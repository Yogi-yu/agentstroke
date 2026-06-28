// ============================================================================
// strokeMutation — pure transform math for stroke editing.
// ----------------------------------------------------------------------------
// Transforms are applied about the stroke's ORIGINAL centroid so rotate/scale
// preserve shape integrity and translation moves the whole stroke.
//   p' = centroid + scale * R(rotation) * (p - centroid) + translation
// All coordinates are in normalized [0,1]² space.
// ============================================================================

import type { StrokeTransform, TransitionPoint } from "@/lib/types";

export interface XY {
  x: number;
  y: number;
}

export function centroidOf(points: { x: number; y: number }[]): XY {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const n = points.length || 1;
  return { x: sx / n, y: sy / n };
}

/** Apply a transform to a single point about a precomputed centroid. */
export function applyTransform(p: XY, t: StrokeTransform, c: XY): XY {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  const rx = (dx * cos - dy * sin) * t.scale;
  const ry = (dx * sin + dy * cos) * t.scale;
  return {
    x: c.x + rx + t.translation.x,
    y: c.y + ry + t.translation.y,
  };
}

/** Centroid of a path's points, used as the transform pivot. */
export function pathCentroid(points: TransitionPoint[]): XY {
  return centroidOf(points);
}

/** Where the (transformed) centroid currently sits — pivot for rotation UI. */
export function transformedCentroid(t: StrokeTransform, c: XY): XY {
  return { x: c.x + t.translation.x, y: c.y + t.translation.y };
}

// --- editor helpers ----------------------------------------------------------

/** Add a normalized-space delta to a transform's translation (drag). */
export function translateBy(t: StrokeTransform, dx: number, dy: number): StrokeTransform {
  return { ...t, translation: { x: t.translation.x + dx, y: t.translation.y + dy } };
}

/** Set absolute rotation (rotate handle). */
export function withRotation(t: StrokeTransform, rotation: number): StrokeTransform {
  return { ...t, rotation };
}

export function withScale(t: StrokeTransform, scale: number): StrokeTransform {
  return { ...t, scale: Math.max(0.05, scale) };
}

/** Angle (radians) from pivot to a point — used to derive rotation from pointer. */
export function angleFrom(pivot: XY, p: XY): number {
  return Math.atan2(p.y - pivot.y, p.x - pivot.x);
}
