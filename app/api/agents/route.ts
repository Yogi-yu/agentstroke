// ============================================================================
// /api/agents — the server-authoritative pool of available economic agents.
// ----------------------------------------------------------------------------
//   GET  → { agents, capacity }   the persistent available-agent list (load + re-sync)
//   POST → attract one new agent into the pool → { agent, agents, capacity }
//          (agent is null when the catalog is exhausted)
// The frontend never owns this list — it mirrors what these endpoints return.
// ============================================================================

import { NextResponse } from "next/server";
import { listAgents, agentCapacity, attractAgent } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ agents: listAgents(), capacity: agentCapacity() });
}

export async function POST() {
  const agent = attractAgent() ?? null; // null = catalog exhausted (pool full)
  return NextResponse.json({ agent, agents: listAgents(), capacity: agentCapacity() });
}
