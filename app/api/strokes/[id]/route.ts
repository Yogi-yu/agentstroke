// ============================================================================
// GET /api/strokes/:id — a single stroke straight from the server store.
// ----------------------------------------------------------------------------
// The stroke detail page reads from here so it derives from the authoritative
// StrokeStore (single source of truth), not frontend state. Bundles the owning
// agent so the page can label + colour the artifact.
// ============================================================================

import { NextResponse } from "next/server";
import { getStroke, getAgent } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const stroke = getStroke(id);
  if (!stroke) return NextResponse.json({ error: "stroke not found" }, { status: 404 });
  const agent = getAgent(stroke.agent_id) ?? null;
  return NextResponse.json({ stroke, agent });
}
