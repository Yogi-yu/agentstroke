// ============================================================================
// POST /api/generateStroke — concept A → semantic transform → concept B.
// ----------------------------------------------------------------------------
// Input:  { from, to, agent_id? }
//   - agent_id optional; if omitted an agent is chosen deterministically from
//     the A→B pair so generations spread across the roster.
// Output: { stroke: TransitionPath }
// The generated stroke is persisted server-side and rendered on the canvas.
// No task execution, no workload — purely A→B stroke generation.
// ============================================================================

import { NextResponse } from "next/server";
import { listAgents, listStrokes, getAgent, addStroke } from "@/lib/store";
import { generateStroke } from "@/lib/strokegen";
import { hashStr } from "@/simulation/rng";
import { canvasRevision } from "@/lib/skyBatchStore";

export const runtime = "nodejs"; // OpenAI SDK needs the Node runtime
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const from = typeof body.from === "string" && body.from.trim() ? body.from.trim() : "";
  const to = typeof body.to === "string" && body.to.trim() ? body.to.trim() : "";
  if (!from || !to) {
    return NextResponse.json({ error: "both `from` and `to` concepts are required" }, { status: 400 });
  }
  const revision = canvasRevision();
  const clearedResponse = () => NextResponse.json({ code: "canvas_cleared", error: "The canvas was cleared. This earlier generation was not saved.", canvasRevision: canvasRevision() }, { status: 409 });
  if (body.canvasRevision !== undefined && body.canvasRevision !== revision) return clearedResponse();

  const agents = listAgents();
  if (agents.length === 0) return NextResponse.json({ error: "no agents available" }, { status: 500 });

  const requested = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  const agent = requested
    ? getAgent(requested)
    : agents[hashStr(`${from}->${to}-${Date.now()}`) % agents.length];
  if (!agent) return NextResponse.json({ error: `unknown agent: ${requested}` }, { status: 404 });

  // Optional explicit timestamp drives which mood time-slice the stroke is
  // generated under (defaults to the server clock). Same A→B at a different
  // time → a different mood → a different stroke.
  const timestamp =
    typeof body.timestamp === "number" && Number.isFinite(body.timestamp)
      ? body.timestamp
      : Date.now();

  const existing = listStrokes();
  const previous = existing[existing.length - 1];
  const stroke = await generateStroke(agent, from, to, timestamp, previous);
  if (canvasRevision() !== revision) return clearedResponse();
  addStroke(stroke);
  return NextResponse.json({ stroke, canvasRevision: revision });
}
