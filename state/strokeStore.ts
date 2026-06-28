// ============================================================================
// strokeStore (client) — per-stroke incremental geometry store.
// ----------------------------------------------------------------------------
// Holds one block per stroke inside a single master Float32Array. Structural
// changes (add / delete / clear) trigger a full repack + upload; transform
// edits (drag / rotate) recompute ONLY the edited stroke's block and report a
// dirty byte-range so the renderer can bufferSubData it — no full rerender.
// Owns the transform store + spatial hitmap so edits stay consistent across
// geometry, render cache, and hit-testing with no orphan data.
// ============================================================================

import type { Agent, StrokeTransform, TransitionPath } from "@/lib/types";
import { agentIndex } from "@/simulation/agentProfiles";
import { FLOATS_PER_INSTANCE } from "@/render/strokeGeometry";
import { buildStrokeBlock, type BlockOpts, type StrokeBlock } from "@/engine/geometryUpdater";
import { TransformStore, IDENTITY_TRANSFORM } from "@/store/transformStore";
import { StrokeHitmap } from "@/canvas/StrokeHitmap";
import { pathCentroid, transformedCentroid, type XY } from "@/engine/strokeMutation";

interface Entry {
  id: string;
  path: TransitionPath;
  offset: number; // instance offset in the master buffer
  block: StrokeBlock;
  opts: BlockOpts;
}

export class StrokeStore {
  data: Float32Array = new Float32Array(0);
  count = 0;
  structureRevision = 0; // bump → renderer does a full upload

  transforms = new TransformStore();
  hitmap = new StrokeHitmap();

  private entries: Entry[] = [];
  private byId = new Map<string, Entry>();
  private dirty: { lo: number; hi: number } | null = null; // float range

  /** Structural (re)build from the authoritative path list. Transforms persist. */
  setData(paths: TransitionPath[], agents: Agent[]): void {
    const hueById = new Map(agents.map((a) => [a.id, a.style.hue]));
    const speedById = new Map(agents.map((a) => [a.id, a.style.speedFactor]));

    const ordered = [...paths].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    this.transforms.retainOnly(new Set(ordered.map((p) => p.id)));
    this.hitmap.clear();

    this.entries = [];
    this.byId.clear();
    let totalFloats = 0;
    const n = ordered.length;

    ordered.forEach((path, i) => {
      // Mood rendering: color_variation shifts the hue (visual tone) and
      // motion_variation modulates animation pacing — so strokes generated in
      // different mood slices look + animate differently (Issue: temporal life).
      const baseHue = hueById.get(path.agent_id) ?? 210;
      const baseSpeed = speedById.get(path.agent_id) ?? 0.5;
      const mood = path.mood;
      const hue = baseHue + (mood ? mood.color_variation * 40 : 0);
      const speed = baseSpeed * (mood ? 0.7 + mood.motion_variation * 0.6 : 1);
      const opts: BlockOpts = {
        hue,
        speed,
        age01: n > 1 ? 0.3 + (i / (n - 1)) * 0.7 : 1,
        strokeIdx: i,
        agentIdx: agentIndex(path.agent_id),
      };
      // Transform precedence: a live in-memory edit (already in the store) wins;
      // otherwise hydrate from the stroke's PERSISTED transform so edits survive
      // a refresh. Falls back to identity for never-edited strokes.
      const t = this.transforms.has(path.id)
        ? this.transforms.get(path.id)
        : path.transform ?? IDENTITY_TRANSFORM;
      this.transforms.set(path.id, t);
      const block = buildStrokeBlock(path, t, opts);
      const entry: Entry = { id: path.id, path, offset: totalFloats / FLOATS_PER_INSTANCE, block, opts };
      this.entries.push(entry);
      this.byId.set(path.id, entry);
      this.hitmap.insert(path.id, block.controlPoints, block.bounds);
      totalFloats += block.count * FLOATS_PER_INSTANCE;
    });

    const master = new Float32Array(totalFloats);
    for (const e of this.entries) master.set(e.block.data, e.offset * FLOATS_PER_INSTANCE);

    this.data = master;
    this.count = totalFloats / FLOATS_PER_INSTANCE;
    this.dirty = null;
    this.structureRevision++;
  }

  clear(): void {
    this.entries = [];
    this.byId.clear();
    this.transforms.clear();
    this.hitmap.clear();
    this.data = new Float32Array(0);
    this.count = 0;
    this.dirty = null;
    this.structureRevision++;
  }

  /** Recompute one stroke's block in place; returns the dirty float range. */
  updateTransform(id: string, t: StrokeTransform): void {
    const entry = this.byId.get(id);
    if (!entry) return;
    this.transforms.set(id, t);
    const block = buildStrokeBlock(entry.path, t, entry.opts);
    // topology (segment count) is transform-invariant → same range
    const start = entry.offset * FLOATS_PER_INSTANCE;
    const len = Math.min(block.count, entry.block.count) * FLOATS_PER_INSTANCE;
    this.data.set(block.data.subarray(0, len), start);
    entry.block = block;
    this.hitmap.insert(id, block.controlPoints, block.bounds);
    const lo = start;
    const hi = start + len;
    this.dirty = this.dirty ? { lo: Math.min(this.dirty.lo, lo), hi: Math.max(this.dirty.hi, hi) } : { lo, hi };
  }

  /** Consume the pending incremental update (float offset + subarray). */
  takeDirty(): { offsetFloats: number; sub: Float32Array } | null {
    if (!this.dirty) return null;
    const { lo, hi } = this.dirty;
    this.dirty = null;
    return { offsetFloats: lo, sub: this.data.subarray(lo, hi) };
  }

  strokeIdxOf(id: string): number {
    return this.entries.findIndex((e) => e.id === id);
  }

  hitTest(nx: number, ny: number, threshold?: number): string | null {
    return this.hitmap.query(nx, ny, threshold);
  }

  transformOf(id: string): StrokeTransform {
    return this.transforms.get(id);
  }

  /** Transformed control points (normalized) for the selected-stroke overlay. */
  controlPointsOf(id: string): XY[] {
    return this.byId.get(id)?.block.controlPoints ?? [];
  }

  /** Current pivot (transformed centroid, normalized) used by the rotate handle. */
  pivotOf(id: string): XY | null {
    const e = this.byId.get(id);
    if (!e) return null;
    return transformedCentroid(this.transforms.get(id), pathCentroid(e.path.points));
  }

}
