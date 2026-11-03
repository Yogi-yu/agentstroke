import { NextResponse } from "next/server";
import { removeAgent, listAgents, agentCapacity } from "@/lib/store";
import { withVisitor } from "@/lib/visitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Removing an agent from this pool never removes their artworks. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withVisitor(request, async owner => {
    const { id } = await params;
    const removed = await removeAgent(owner, id);
    return NextResponse.json({ ok: removed, agents: await listAgents(owner), capacity: agentCapacity() }, { status: removed ? 200 : 404 });
  });
}
