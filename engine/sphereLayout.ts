import { hashStr } from "@/simulation/rng";

export const SPHERE_ATLAS_WIDTH = 2048;
export const SPHERE_ATLAS_HEIGHT = 1024;
interface Point { x: number; y: number }
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));

/**
 * Display-only atlas placement. Keep relative path lengths and single-path
 * topology; never normalize every stroke to the same bounding box. Seeded
 * longitude/latitude anchors remain stable when other works arrive or leave.
 * A padded chart keeps the complete ribbon away from the seam and poles.
 * The renderer then samples this chart ON the sphere, not between 3D points.
 */
export function sphereStrokeControls(id: string, controls: readonly Point[]): Point[] {
  const points = controls.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!points.length) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const width = maxX - minX, height = maxY - minY;
  const span = Math.max(width, height);
  const latitude = Math.asin(((hashStr(`${id}:latitude`) % 10007) / 10006 - 0.5) * 1.35);
  // Short but nonzero paths get only a small readability floor (about 7°).
  // Genuine point gestures remain points. Large gestures retain their range.
  const angularScale = span > 0 ? Math.max(2.4, Math.min(10, 0.12 / span)) : 2.4;
  let scaleX = angularScale / (Math.PI * 2 * Math.cos(latitude));
  let scaleY = angularScale / Math.PI;
  const cap = Math.min(1, 0.38 / Math.max(1e-9, width * scaleX), 0.52 / Math.max(1e-9, height * scaleY));
  scaleX *= cap; scaleY *= cap;
  const halfX = width * scaleX / 2, halfY = height * scaleY / 2;
  const longitudeSeed = (hashStr(`${id}:longitude`) % 10009) / 10008;
  const centerX = 0.025 + halfX + longitudeSeed * (0.95 - halfX * 2);
  const centerY = clamp(0.5 - latitude / Math.PI, 0.08 + halfY, 0.92 - halfY);
  const pivotX = (minX + maxX) / 2, pivotY = (minY + maxY) / 2;
  return points.map(p => ({ x: centerX + (p.x - pivotX) * scaleX, y: centerY + (p.y - pivotY) * scaleY }));
}
