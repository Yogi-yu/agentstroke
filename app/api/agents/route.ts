import { NextResponse } from "next/server";
import { listAgents, agentCapacity, attractAgent, clearAgents } from "@/lib/store";
import { withVisitor } from "@/lib/visitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withVisitor(request, async owner => NextResponse.json({ agents: await listAgents(owner), capacity: agentCapacity() }, { headers: { "Cache-Control": "no-store" } }));
}
export async function POST(request: Request) {
  return withVisitor(request, async owner => {
    const agent = await attractAgent(owner) ?? null;
    return NextResponse.json({ agent, agents: await listAgents(owner), capacity: agentCapacity() });
  });
}
export async function DELETE(request: Request) {
  return withVisitor(request, async owner => {
    const agentsRemoved = await clearAgents(owner);
    return NextResponse.json({ agentsRemoved, agents: await listAgents(owner), capacity: agentCapacity() });
  });
}
