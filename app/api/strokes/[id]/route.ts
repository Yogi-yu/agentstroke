import { NextResponse } from "next/server";
import { getStroke, getAgent } from "@/lib/store";
import { withVisitor } from "@/lib/visitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withVisitor(request, async owner => {
    const { id } = await params;
    const stroke = await getStroke(owner, id);
    if (!stroke) return NextResponse.json({ error: "Stroke not found." }, { status: 404 });
    return NextResponse.json({ stroke, agent: await getAgent(owner, stroke.agent_id) ?? null }, { headers: { "Cache-Control": "no-store" } });
  });
}
