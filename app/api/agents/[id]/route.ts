// ============================================================================
// DELETE /api/agents/:id — remove an agent from the available pool.
// ----------------------------------------------------------------------------
// Server-authoritative removal: drops the agent and CASCADE-deletes its strokes
// (no orphans). Returns the fresh list so the UI can re-sync from the server.
// ============================================================================

import { NextResponse } from "next/server";
import { removeAgent, listAgents, agentCapacity } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const removed = removeAgent(id);
  return NextResponse.json(
    { ok: removed, agents: listAgents(), capacity: agentCapacity() },
    { status: removed ? 200 : 404 },
  );
}
