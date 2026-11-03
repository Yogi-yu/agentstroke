import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { hasOpenRouterKey } from "@/lib/openrouter/client";
import { createSkyBatch, retrySkyBatch, runSkyBatch, selectSkyAgents, skyBatchSize, type SkyBatch, type SkyMode } from "@/lib/skyBatch";
import { canvasRevision, listAgents, listStrokes } from "@/lib/store";
import { generateStroke } from "@/lib/strokegen";
import { readSkyBatch, readSkySnapshot, claimSkyBatch, saveSkyBatch, heartbeatSkyBatch, abandonSkyBatch } from "@/lib/skyBatchStore";
import { withVisitor } from "@/lib/visitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Twenty sequential bounded 60-second model requests, plus checkpoint margin.
export const maxDuration = 1320;

const validRequestId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{16,100}$/.test(value);

export async function GET(request: Request) {
  return withVisitor(request, async owner => {
    const requestId = new URL(request.url).searchParams.get("requestId") ?? undefined;
    if (requestId && !validRequestId(requestId)) return NextResponse.json({ error: "A valid request ID is required." }, { status: 400 });
    const { job: saved, canvasRevision: revision } = await readSkySnapshot(owner, requestId);
    const job = saved?.status === "cleared" || (saved && saved.canvasRevision !== revision) ? null : saved;
    return NextResponse.json({ job, resumedFrom: requestId && job && job.requestId !== requestId ? requestId : null, configured: hasOpenRouterKey(), canvasRevision: revision });
  });
}

export async function POST(request: Request) {
  return withVisitor(request, async owner => {
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid body");
      body = parsed;
    } catch { return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 }); }
    const requestId = body.requestId;
    const retryOf = body.retryOf;
    if (!validRequestId(requestId) || (body.mode !== undefined && body.mode !== "autonomous")
      || (retryOf !== undefined && !validRequestId(retryOf))) {
      return NextResponse.json({ error: "A valid request ID and autonomous generation mode are required." }, { status: 400 });
    }
    if ((body.skyMode !== undefined && body.skyMode !== "standard" && body.skyMode !== "sphere")
      || ["count", "targetCount", "batchSize", "size"].some(key => key in body)) {
      return NextResponse.json({ error: "Choose standard Sky (10 strokes) or Sphere Sky (20 strokes). Custom batch sizes are not supported." }, { status: 400 });
    }
    const skyMode: SkyMode = body.skyMode === "sphere" ? "sphere" : "standard";
    if (body.canvasRevision !== undefined && (!Number.isSafeInteger(body.canvasRevision) || (body.canvasRevision as number) < 0)) {
      return NextResponse.json({ error: "A valid canvas revision is required." }, { status: 400 });
    }
    const revision = await canvasRevision(owner);
    const clearedResponse = async () => NextResponse.json({ code: "canvas_cleared", error: "This sky belongs to a cleared canvas. Saved artwork remains in Archive.", canvasRevision: await canvasRevision(owner) }, { status: 409 });
    if (body.canvasRevision !== undefined && body.canvasRevision !== revision) return clearedResponse();
    // A repeat request never dispatches another paid call, including after a restart.
    const previous = await readSkyBatch(owner, requestId);
    if (previous?.status === "cleared") return clearedResponse();
    if (previous) return NextResponse.json({ job: previous, reused: true });
    const source = retryOf ? await readSkyBatch(owner, retryOf as string) : null;
    if (retryOf && !source) return NextResponse.json({ code: "invalid_retry", error: "This batch is unavailable for retry. No model calls were made." }, { status: 404 });
    if (source?.status === "cleared") return clearedResponse();
    if (source && source.requestId !== retryOf) {
      return NextResponse.json({ code: "already_retried", error: "These entries were already retried. Showing the latest results.", job: source }, { status: 409 });
    }
    if (source && (source.status === "running" || !source.entries.some(entry => entry.status === "failed"))) {
      return NextResponse.json({ code: "invalid_retry", error: "Only a finished batch with failed entries can be retried. No model calls were made." }, { status: 409 });
    }
    const available = await listAgents(owner);
    if (!available.length) return NextResponse.json({ code: "empty_agent_pool", error: "No agents are available. Add an agent before generating sky strokes. No model calls were made." }, { status: 409 });
    if (!hasOpenRouterKey()) return NextResponse.json({ error: "The model provider is not configured. No model calls were made." }, { status: 503 });
    const existing = await listStrokes(owner);
    // A retry inherits its source's reserved slots and view, regardless of a
    // subsequently selected UI mode; it cannot turn twenty paid slots into ten.
    const proposal = source ? retrySkyBatch(source, randomUUID(), requestId)
      : createSkyBatch(randomUUID(), requestId, selectSkyAgents(available, Math.random, skyBatchSize(skyMode)), "", "", skyMode);
    proposal.canvasRevision = revision;
    const claim = await claimSkyBatch(owner, proposal, { retryOf: retryOf as string | undefined, expectedRevision: revision });
    if (!claim.claimed || !claim.job || !claim.leaseId) {
      if (claim.code === "canvas_cleared" || claim.job?.status === "cleared") return clearedResponse();
      if (claim.code === "existing") return NextResponse.json({ job: claim.job, reused: true });
      return NextResponse.json({ code: claim.code ?? "active", error: claim.code === "active" ? "A sky generation is already running. Its progress is shown below." : "This generation request cannot be repeated. Showing the saved results.", job: claim.job }, { status: 409 });
    }
    const job = claim.job;
    const leaseId = claim.leaseId;
    const generation = new AbortController();
    const encoder = new TextEncoder();
    let connected = true;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (value: { job?: SkyBatch | null; code?: string; error?: string }) => {
          if (!connected) return;
          try { controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)); } catch { connected = false; }
        };
        emit({ job }); // claim has already committed before this first frame
        let heartbeatPending = false;
        const heartbeat = setInterval(() => {
          if (heartbeatPending) return;
          heartbeatPending = true;
          void heartbeatSkyBatch(owner, requestId, leaseId).then(valid => {
            if (!valid) generation.abort();
          }).catch(() => {
            // A transient heartbeat failure cannot discard an already paid
            // result. The next durable checkpoint must succeed before another
            // slot starts; an expired lease still fences its membership.
          }).finally(() => { heartbeatPending = false; });
        }, 20_000);
        heartbeat.unref?.();
        const checkpoint = async () => {
          const saved = await saveSkyBatch(owner, job, leaseId);
          if (!saved) {
            generation.abort();
            // Emit only committed state; a late completion must not refill a cleared canvas.
            const current = await readSkyBatch(owner, requestId);
            emit({ job: current });
            return;
          }
          emit({ job });
        };
        void runSkyBatch(job, {
          signal: generation.signal,
          generate: async (agent, index, onAttempt) => {
            const previous = job.entries.slice(0, index).findLast(entry => entry.status === "succeeded")?.stroke ?? existing.at(-1);
            // Clearing/losing a lease stops the NEXT slot, not an already paid
            // request. Its bounded in-flight result still belongs in Archive.
            const stroke = await generateStroke(agent, "", "", job.createdAt + index * 100, previous, { mode: "autonomous", requireModel: true, onAttempt });
            stroke.id = `${stroke.id}-${randomUUID()}`;
            return stroke;
          },
          // saveSkyBatch archives the work and progress in the same transaction.
          persist: () => {},
        }, checkpoint).catch(async () => {
          generation.abort();
          try { await abandonSkyBatch(owner, requestId, leaseId); } catch { /* Recovery will mark the expired lease interrupted. */ }
          emit({ code: "storage_unavailable", error: "Progress could not be saved. Generation has stopped. Reload to recover saved artwork; no successful save is being reported." });
        }).finally(() => {
          clearInterval(heartbeat);
          if (connected) { try { controller.close(); } catch { /* Client disconnected. */ } }
        });
      },
      // Closing the browser is not permission to repeat or discard a paid call.
      cancel() { connected = false; },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
  });
}
