import { NextResponse } from "next/server";
import { removeAgent, listAgents, agentCapacity, getAgent } from "@/lib/store";
import { withVisitor } from "@/lib/visitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Retired identities remain inspectable; reads never refresh their activity. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withVisitor(request,async owner => {
    const { id } = await params;
    const agent = await getAgent(owner,id);
    if (!agent) return NextResponse.json({ error:"Agent not found." },{status:404});
    const active = (await listAgents(owner)).some(item => item.id === id);
    return NextResponse.json({agent,active},{headers:{"Cache-Control":"no-store"}});
  });
}

/** Removing an agent from this pool never removes their artworks. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withVisitor(request, async owner => {
    const { id } = await params;
    const removed = await removeAgent(owner, id);
    return NextResponse.json({ ok: removed, agents: await listAgents(owner), capacity: agentCapacity() }, { status: removed ? 200 : 404 });
  });
}
