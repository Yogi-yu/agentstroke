import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { hasOpenRouterKey } from "@/lib/openrouter/client";
import { createSkyBatch, retrySkyBatch, runSkyBatch, selectSkyAgents, touchSkyBatch, type SkyBatch } from "@/lib/skyBatch";
import { addStroke, listAgents, listStrokes } from "@/lib/store";
import { generateStroke } from "@/lib/strokegen";
import { skyBatchState as state } from "@/lib/skyBatchStore";
import { isSameOriginRequest } from "@/lib/requestOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Ten sequential slots, each capped at 60s by the generator, plus response overhead.
export const maxDuration = 660;

function latestRetry(current: ReturnType<typeof state>, source: SkyBatch): SkyBatch {
  let job = source;
  for (let remaining = current.jobs.size; remaining > 0 && job.retryRequestId; remaining--) {
    const next = current.jobs.get(job.retryRequestId);
    if (!next) break;
    job = next;
  }
  return job;
}

/** Older builds cleared strokes but retained Sky copies. Never restore those. */
function isDeletedSnapshot(job: SkyBatch): boolean {
  if (job.status === "cleared") return true;
  if (job.status === "running") return false;
  const savedIds = job.entries.flatMap((entry) => entry.stroke ? [entry.stroke.id] : []);
  if (!savedIds.length) return false;
  const liveIds = new Set(listStrokes().map((stroke) => stroke.id));
  return !savedIds.some((id) => liveIds.has(id));
}

export async function GET(request: Request) {
  const current = state();
  const requestId = new URL(request.url).searchParams.get("requestId");
  const source = requestId ? current.jobs.get(requestId) : current.latestId ? current.jobs.get(current.latestId) : undefined;
  const candidate = source ? latestRetry(current, source) : undefined;
  const job = candidate && !isDeletedSnapshot(candidate) ? candidate : undefined;
  return NextResponse.json({ job: job ?? null, resumedFrom: source && job !== source ? source.requestId : null, configured: hasOpenRouterKey(), canvasRevision: current.canvasRevision }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Generation must be requested from this site." }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid body");
    body = parsed;
  } catch {
    return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 });
  }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const from = typeof body.from === "string" ? body.from.trim() : "chaos";
  const to = typeof body.to === "string" ? body.to.trim() : "order";
  const retryOf = typeof body.retryOf === "string" ? body.retryOf : undefined;
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId) || !from || !to || from.length > 100 || to.length > 100
    || (body.retryOf !== undefined && (!retryOf || !/^[a-zA-Z0-9_-]{16,100}$/.test(retryOf)))) {
    return NextResponse.json({ error: "A valid request ID and two concepts of 1–100 characters are required." }, { status: 400 });
  }
  const current = state();
  if (body.canvasRevision !== undefined && (!Number.isSafeInteger(body.canvasRevision) || (body.canvasRevision as number) < 0)) {
    return NextResponse.json({ error: "A valid canvas revision is required." }, { status: 400 });
  }
  if (body.canvasRevision !== undefined && body.canvasRevision !== current.canvasRevision) {
    return NextResponse.json({ code: "canvas_cleared", error: "The canvas was cleared. Start a new generation to create new artwork.", canvasRevision: current.canvasRevision }, { status: 409 });
  }
  const previous = current.jobs.get(requestId);
  const clearedResponse = () => NextResponse.json({ code: "canvas_cleared", error: "This sky belongs to a cleared canvas. Start a new generation to create new artwork.", canvasRevision: current.canvasRevision }, { status: 409 });
  // Replaying the same browser request is a read, never another ten model calls.
  if (previous && isDeletedSnapshot(previous)) return clearedResponse();
  if (previous) return NextResponse.json({ job: previous, reused: true });
  if (current.seenRequestIds.has(requestId)) {
    return NextResponse.json({ error: "This request was already processed. Its detailed results have expired; no generation was repeated." }, { status: 409 });
  }
  const source = retryOf ? current.jobs.get(retryOf) : undefined;
  if (retryOf && !source) {
    return NextResponse.json({ error: "This batch is no longer available for retry. No model calls were made." }, { status: 404 });
  }
  if (source && isDeletedSnapshot(latestRetry(current, source))) return clearedResponse();
  if (source?.retryRequestId) {
    const next = current.jobs.get(source.retryRequestId);
    const successor = next ? latestRetry(current, next) : null;
    return NextResponse.json({ code: "already_retried", error: "These failed entries have already been retried. Showing the latest results; no duplicate generation was started.", job: successor ?? null }, { status: 409 });
  }
  if (source && (source.status === "running" || !source.entries.some((entry) => entry.status === "failed"))) {
    return NextResponse.json({ error: "Only a finished batch with failed entries can be retried. No model calls were made." }, { status: 409 });
  }
  if (current.activeId) {
    return NextResponse.json({ error: "A sky generation is already running. Its progress is shown below.", job: current.jobs.get(current.activeId) }, { status: 409 });
  }
  const availableAgents = listAgents();
  if (!availableAgents.length) {
    return NextResponse.json({ code: "empty_agent_pool", error: "No agents are available. Add an agent before generating sky strokes. No model calls were made." }, { status: 409 });
  }
  if (!hasOpenRouterKey()) {
    return NextResponse.json({ error: "OPENROUTER_API_KEY is not configured. No model calls were made." }, { status: 503 });
  }

  const job = source
    ? retrySkyBatch(source, randomUUID(), requestId)
    : createSkyBatch(randomUUID(), requestId, selectSkyAgents(availableAgents), from, to);
  job.canvasRevision = current.canvasRevision;
  const generationController = new AbortController();
  // There are no awaits between checking and claiming the process-wide lock.
  current.activeId = requestId;
  current.latestId = requestId;
  current.jobs.set(requestId, job);
  current.seenRequestIds.add(requestId);
  current.controllers.set(requestId, generationController);
  if (source) { source.retryRequestId = requestId; touchSkyBatch(source); }
  while (current.jobs.size > 8) {
    const oldest = current.jobs.keys().next().value as string | undefined;
    if (!oldest || oldest === requestId) break;
    current.jobs.delete(oldest);
  }

  const encoder = new TextEncoder();
  let connected = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = () => {
        if (!connected) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify({ job })}\n`)); }
        catch { connected = false; }
      };
      emit();
      void runSkyBatch(job, {
        signal: generationController.signal,
        generate: async (agent, index, onAttempt) => {
          const strokes = listStrokes();
          return generateStroke(agent, job.from, job.to, job.createdAt + index * 100, strokes[strokes.length - 1], { requireModel: true, onAttempt, signal: generationController.signal });
        },
        persist: (stroke) => { addStroke(stroke); },
      }, emit).finally(() => {
        current.controllers.delete(requestId);
        if (current.activeId === requestId) current.activeId = null;
        if (connected) {
          try { controller.close(); } catch { /* The client may have closed just before completion. */ }
        }
      });
    },
    // Already authorized model calls finish once and remain recoverable via GET.
    cancel() { connected = false; },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
