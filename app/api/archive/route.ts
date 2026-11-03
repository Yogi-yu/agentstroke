import { NextResponse } from "next/server";
import { listArchivedStrokes, restoreStroke, canvasRevision } from "@/lib/store";
import { withVisitor } from "@/lib/visitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withVisitor(request, async owner => {
    const params = new URL(request.url).searchParams;
    const offset = Number(params.get("offset") ?? 0);
    const limit = Number(params.get("limit") ?? 30);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return NextResponse.json({ error: "Use a nonnegative offset and a limit between 1 and 100." }, { status: 400 });
    const result = await listArchivedStrokes(owner, { offset, limit });
    return NextResponse.json({ ...result, hasMore: offset + result.strokes.length < result.total }, { headers: { "Cache-Control": "no-store" } });
  });
}

export async function POST(request: Request) {
  return withVisitor(request, async owner => {
    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
    if (!body || typeof body.id !== "string" || !body.id) return NextResponse.json({ error: "A stroke ID is required." }, { status: 400 });
    const revision = await canvasRevision(owner);
    const stroke = await restoreStroke(owner, body.id, { expectedRevision: revision });
    if (!stroke) return NextResponse.json({ error: "Archived stroke not found." }, { status: 404 });
    if (await canvasRevision(owner) !== revision) return NextResponse.json({ code: "canvas_cleared", error: "The canvas was cleared. This artwork remains in Archive.", canvasRevision: await canvasRevision(owner) }, { status: 409 });
    return NextResponse.json({ stroke, canvasRevision: revision });
  });
}
