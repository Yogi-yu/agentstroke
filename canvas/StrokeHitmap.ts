// ============================================================================
// StrokeHitmap — uniform-grid spatial index over normalized [0,1]² space.
// ----------------------------------------------------------------------------
// Lets the editor hit-test the pointer against strokes on the CPU (no GPU
// readback), so selection and dragging stay cheap. Each stroke registers the
// grid cells its transformed control-point polyline overlaps; queries gather
// candidates from the pointer's cell + neighbours and do a precise
// distance-to-polyline test.
// ============================================================================

import type { XY } from "@/engine/strokeMutation";

interface Entry {
  id: string;
  points: XY[];
  cells: number[];
}

const GRID = 32; // 32×32 cells across the unit square

export class StrokeHitmap {
  private cells: Map<number, Set<string>> = new Map();
  private entries: Map<string, Entry> = new Map();

  private cellIndex(cx: number, cy: number): number {
    return cy * GRID + cx;
  }

  private clampCell(v: number): number {
    return Math.max(0, Math.min(GRID - 1, Math.floor(v * GRID)));
  }

  insert(id: string, points: XY[], bounds: { minX: number; minY: number; maxX: number; maxY: number }): void {
    this.remove(id);
    const cx0 = this.clampCell(bounds.minX);
    const cy0 = this.clampCell(bounds.minY);
    const cx1 = this.clampCell(bounds.maxX);
    const cy1 = this.clampCell(bounds.maxY);
    const cells: number[] = [];
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const idx = this.cellIndex(cx, cy);
        cells.push(idx);
        let set = this.cells.get(idx);
        if (!set) {
          set = new Set();
          this.cells.set(idx, set);
        }
        set.add(id);
      }
    }
    this.entries.set(id, { id, points, cells });
  }

  remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    for (const idx of e.cells) {
      const set = this.cells.get(idx);
      if (set) {
        set.delete(id);
        if (set.size === 0) this.cells.delete(idx);
      }
    }
    this.entries.delete(id);
  }

  clear(): void {
    this.cells.clear();
    this.entries.clear();
  }

  /** Nearest stroke id whose polyline is within `threshold` (normalized) of (x,y). */
  query(x: number, y: number, threshold = 0.025): string | null {
    const cx = this.clampCell(x);
    const cy = this.clampCell(y);
    const candidates = new Set<string>();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
        const set = this.cells.get(this.cellIndex(nx, ny));
        if (set) for (const id of set) candidates.add(id);
      }
    }
    let best: string | null = null;
    let bestD = threshold;
    for (const id of candidates) {
      const e = this.entries.get(id);
      if (!e) continue;
      const d = polylineDistance(e.points, x, y);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }
}

function polylineDistance(pts: XY[], x: number, y: number): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(pts[0].x - x, pts[0].y - y);
  let min = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = segDist(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, x, y);
    if (d < min) min = d;
  }
  return min;
}

function segDist(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy || 1e-9;
  let t = (wx * vx + wy * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const dx = ax + vx * t - px;
  const dy = ay + vy * t - py;
  return Math.hypot(dx, dy);
}
