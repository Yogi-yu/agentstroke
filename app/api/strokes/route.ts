import { NextResponse } from "next/server";
import { readCanvas, clearStrokes, removeStroke, updateStrokeTransform, canvasRevision } from "@/lib/store";
import { withVisitor } from "@/lib/visitor";
import type { StrokeTransform } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withVisitor(request, async owner => NextResponse.json(await readCanvas(owner), { headers: { "Cache-Control": "no-store" } }));
}

function isTransform(value: unknown): value is StrokeTransform {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  const tr = t.translation as Record<string, unknown> | undefined;
  return !!tr && [tr.x, tr.y, t.rotation, t.scale].every(v => typeof v === "number" && Number.isFinite(v))
    && Math.abs(tr.x as number) <= 100 && Math.abs(tr.y as number) <= 100
    && Math.abs(t.rotation as number) <= 100000 && (t.scale as number) > 0 && (t.scale as number) <= 100;
}

export async function PATCH(request: Request) {
  return withVisitor(request, async owner => {
    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
    if (!body || typeof body.id !== "string" || !body.id || !isTransform(body.transform)) return NextResponse.json({ error: "A stroke ID and finite transform are required." }, { status: 400 });
    const stroke = await updateStrokeTransform(owner, body.id, body.transform);
    if (!stroke) return NextResponse.json({ error: "Stroke not found on your canvas." }, { status: 404 });
    return NextResponse.json({ stroke });
  });
}

/** Removal only changes this visitor's canvas membership; artwork is retained. */
export async function DELETE(request: Request) {
  return withVisitor(request, async owner => {
    const id = new URL(request.url).searchParams.get("id");
    if (id) {
      const removed = await removeStroke(owner, id);
      return removed ? NextResponse.json({ deleted: true, id, archived: true }) : NextResponse.json({ error: "Stroke not found on your canvas." }, { status: 404 });
    }
    const removed = await clearStrokes(owner);
    return NextResponse.json({ cleared: true, removed, archived: true, canvasRevision: await canvasRevision(owner) });
  });
}
