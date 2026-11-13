import type { DatabaseClient } from "@/lib/database";
import type { StrokeColorTreatment, TransitionPath } from "@/lib/types";
import { colorTreatmentForIndex } from "@/engine/colorTreatment";
import { SHARED_CANVAS_OWNER } from "@/lib/sharedCanvas";

const PALETTE_VERSION = "balanced-palette-v1";
interface PaletteState { initialized: number; next_sequence: number | string }
interface ColorRow { artwork_id: string; treatment: StrokeColorTreatment }
const valid = (value: unknown): value is StrokeColorTreatment => value === "bright" || value === "muted";

/**
 * One atomic backfill, never a view-dependent recoloring. Original artwork and
 * Sky JSON stay byte-for-byte intact. Visible shared works are allocated first
 * so both that initial canvas and the complete archive differ by at most one.
 * Before shared-canvas migration exists, its eventual visible union is used.
 */
export async function initializeColorTreatments(db: DatabaseClient): Promise<void> {
  const previous = (await db.query<PaletteState>("SELECT initialized,next_sequence FROM noema_color_state WHERE id=$1", [PALETTE_VERSION])).rows[0];
  if (Number(previous?.initialized) === 1) return;
  await db.query("INSERT INTO noema_color_state(id,initialized,next_sequence) VALUES($1,0,0) ON CONFLICT(id) DO NOTHING", [PALETTE_VERSION]);
  const state = (await db.query<PaletteState>("SELECT initialized,next_sequence FROM noema_color_state WHERE id=$1 FOR UPDATE", [PALETTE_VERSION])).rows[0];
  if (Number(state.initialized) === 1) return;
  const sharedExists = (await db.query("SELECT owner_id FROM noema_visitors WHERE owner_id=$1", [SHARED_CANVAS_OWNER])).rowCount > 0;
  const works = (await db.query<{ id: string }>(`SELECT a.id FROM noema_artworks a ORDER BY CASE WHEN EXISTS (SELECT 1 FROM noema_canvas c WHERE c.artwork_id=a.id AND c.hidden=0${sharedExists ? " AND c.owner_id=$1" : ""}) THEN 0 ELSE 1 END,a.created_at,a.id`, sharedExists ? [SHARED_CANVAS_OWNER] : [])).rows;
  for (let index = 0; index < works.length; index++) {
    await db.query("INSERT INTO noema_artwork_colors(artwork_id,treatment,assigned_at) VALUES($1,$2,$3) ON CONFLICT(artwork_id) DO NOTHING", [works[index].id,colorTreatmentForIndex(index),Date.now()]);
  }
  await db.query("UPDATE noema_color_state SET initialized=1,next_sequence=$2 WHERE id=$1", [PALETTE_VERSION,works.length]);
}

/** Reserve one ordinary slot only once; explicit Sky allocations use no slot. */
export async function assignArtworkColor(db: DatabaseClient, path: TransitionPath): Promise<TransitionPath> {
  await initializeColorTreatments(db);
  let row = (await db.query<ColorRow>("SELECT artwork_id,treatment FROM noema_artwork_colors WHERE artwork_id=$1", [path.id])).rows[0];
  if (!row) {
    const state = (await db.query<PaletteState>("SELECT initialized,next_sequence FROM noema_color_state WHERE id=$1 FOR UPDATE", [PALETTE_VERSION])).rows[0];
    // Another transaction may have created this id while waiting for the lock.
    row = (await db.query<ColorRow>("SELECT artwork_id,treatment FROM noema_artwork_colors WHERE artwork_id=$1", [path.id])).rows[0];
    if (!row) {
      const reserved = valid(path.color_treatment);
      const treatment = reserved ? path.color_treatment! : colorTreatmentForIndex(Number(state.next_sequence));
      await db.query("INSERT INTO noema_artwork_colors(artwork_id,treatment,assigned_at) VALUES($1,$2,$3)", [path.id,treatment,Date.now()]);
      if (!reserved) await db.query("UPDATE noema_color_state SET next_sequence=$2 WHERE id=$1", [PALETTE_VERSION,Number(state.next_sequence)+1]);
      row = { artwork_id:path.id,treatment };
    }
  }
  return { ...path, color_treatment:row.treatment };
}

/** Read overlay for canvas, archive, detail and historical Sky copies alike. */
export async function withArtworkColors(db: DatabaseClient, paths: TransitionPath[]): Promise<TransitionPath[]> {
  if (!paths.length) return paths;
  await initializeColorTreatments(db);
  const colors = new Map<string, StrokeColorTreatment>();
  const ids = [...new Set(paths.map(path => path.id))];
  for (let start=0; start<ids.length; start+=400) {
    const chunk=ids.slice(start,start+400);
    const rows=await db.query<ColorRow>(`SELECT artwork_id,treatment FROM noema_artwork_colors WHERE artwork_id IN (${chunk.map((_,i)=>`$${i+1}`).join(",")})`,chunk);
    for (const row of rows.rows) colors.set(row.artwork_id,row.treatment);
  }
  return paths.map(path => colors.has(path.id) ? { ...path,color_treatment:colors.get(path.id)! } : path);
}
