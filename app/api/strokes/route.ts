// ============================================================================
// /api/strokes — server-persisted A→B strokes (Layer 1 + 3).
// ----------------------------------------------------------------------------
//   GET    → every stored stroke (loaded on page refresh)
//   PATCH  → { id, transform } persist one stroke's edit-mode transform
//   DELETE → ?id=<id> remove ONE stroke globally; no id → clear all (reset)
//
// Persistence is the system's backbone: this is a "persistent cognitive stroke
// database", so edits and deletions are written here, not just in the UI.
// ============================================================================

import { NextResponse } from "next/server";
import {
  listStrokes,
  clearStrokes,
  removeStroke,
  updateStrokeTransform,
} from "@/lib/store";
import type { StrokeTransform } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ strokes: listStrokes() });
}

function isTransform(v: unknown): v is StrokeTransform {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  const tr = t.translation as Record<string, unknown> | undefined;
  return (
    !!tr &&
    typeof tr.x === "number" &&
    typeof tr.y === "number" &&
    typeof t.rotation === "number" &&
    typeof t.scale === "number"
  );
}

export async function PATCH(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "`id` is required" }, { status: 400 });
  if (!isTransform(body.transform)) {
    return NextResponse.json({ error: "`transform` is malformed" }, { status: 400 });
  }
  const stroke = updateStrokeTransform(id, body.transform);
  if (!stroke) return NextResponse.json({ error: `unknown stroke: ${id}` }, { status: 404 });
  return NextResponse.json({ stroke });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const removed = removeStroke(id);
    if (!removed) return NextResponse.json({ error: `unknown stroke: ${id}` }, { status: 404 });
    return NextResponse.json({ deleted: true, id });
  }
  const removed = clearStrokes();
  return NextResponse.json({ cleared: true, removed });
}
