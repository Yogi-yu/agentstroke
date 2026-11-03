import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { listAgents, listStrokes, getAgent, addStroke, restoreStroke, canvasRevision } from "@/lib/store";
import { generateStroke } from "@/lib/strokegen";
import { classifySemanticGenerationError } from "@/lib/semanticPath";
import { createPublishedCanvas } from "@/lib/publishedCanvas";
import { withVisitor } from "@/lib/visitor";
import type { TransitionPath } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 75;

export async function POST(request: Request) {
  return withVisitor(request, async owner => {
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid body");
      body = parsed;
    } catch {
      return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 });
    }
    const mode = body.mode === undefined ? "autonomous" : body.mode;
    if (mode !== "autonomous" && mode !== "example") {
      return NextResponse.json({ error: "Generation mode must be autonomous or example." }, { status: 400 });
    }
    if (body.canvasRevision !== undefined && (!Number.isSafeInteger(body.canvasRevision) || (body.canvasRevision as number) < 0)) {
      return NextResponse.json({ error: "A valid canvas revision is required." }, { status: 400 });
    }
    if (body.agent_id !== undefined && (typeof body.agent_id !== "string" || !body.agent_id.trim())) {
      return NextResponse.json({ error: "A valid agent ID is required." }, { status: 400 });
    }
    const revision = await canvasRevision(owner);
    const clearedResponse = async (archived = false) => NextResponse.json({
      code: "canvas_cleared", archived,
      error: archived ? "The canvas was cleared. Your completed artwork is safely stored in Archive." : "The canvas was cleared. Start a new generation to create new artwork.",
      canvasRevision: await canvasRevision(owner),
    }, { status: 409 });
    if (body.canvasRevision !== undefined && body.canvasRevision !== revision) return clearedResponse();

    // The fixed public example is a saved work, not a paid model operation.
    if (mode === "example") {
      const example = createPublishedCanvas().strokes.find(stroke => stroke.generation_mode === "example");
      if (!example) return NextResponse.json({ error: "The example is unavailable." }, { status: 503 });
      const stroke = await restoreStroke(owner, example.id, { expectedRevision: revision });
      if (!stroke) return NextResponse.json({ error: "The example is unavailable." }, { status: 503 });
      if (await canvasRevision(owner) !== revision) return clearedResponse(true);
      return NextResponse.json({ stroke, reused: true, canvasRevision: revision });
    }

    const agents = await listAgents(owner);
    if (!agents.length) return NextResponse.json({ code: "empty_agent_pool", error: "No agents are available. Add an agent before generating." }, { status: 409 });
    const requested = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
    const agent = requested ? await getAgent(owner, requested) : agents[Math.floor(Math.random() * agents.length)];
    if (!agent) return NextResponse.json({ error: "Agent not found." }, { status: 404 });
    const existing = await listStrokes(owner);
    const timestamp = typeof body.timestamp === "number" && Number.isFinite(body.timestamp) ? body.timestamp : Date.now();
    let stroke: TransitionPath;
    try {
      stroke = await generateStroke(agent, "", "", timestamp, existing.at(-1), { mode: "autonomous", requireModel: true });
      // Identical client timestamps must never overwrite another saved artwork.
      stroke.id = `${stroke.id}-${randomUUID()}`;
    } catch (error) {
      const safe = classifySemanticGenerationError(error);
      const status = safe.code === "timeout" ? 504 : safe.code === "rate_limit" ? 429
        : ["configuration", "authentication", "credits", "unavailable"].includes(safe.code) ? 503 : 502;
      return NextResponse.json({ error: safe.message, code: safe.code, retryable: safe.retryable }, { status });
    }
    // Storage failures are not model failures: never claim the work was saved.
    const saved = await addStroke(owner, stroke, { expectedRevision: revision });
    if (await canvasRevision(owner) !== revision) return clearedResponse(true);
    return NextResponse.json({ stroke: saved, reused: false, canvasRevision: revision });
  });
}
