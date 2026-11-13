/** Tight, immutable raster tiles. No full-viewport bitmap is held per stroke. */
export class NibRasterCache {
  private readonly entries = new Map<string, { canvas: HTMLCanvasElement; bytes: number }>();
  private bytes = 0;
  private evictions = 0;
  private readonly limit: number;

  constructor(
    private readonly factory: (width: number, height: number) => HTMLCanvasElement | null,
    maxBytes = 64 * 1024 * 1024,
  ) {
    this.limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 64 * 1024 * 1024;
  }

  get stats(): { bytes: number; tiles: number; evictions: number } {
    return { bytes: this.bytes, tiles: this.entries.size, evictions: this.evictions };
  }

  /** A read also marks the tile recently used. Cached pixels must stay immutable. */
  get(key: string): HTMLCanvasElement | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.canvas;
  }

  /** Reject overlarge work instead of silently rescaling the original geometry. */
  make(width: number, height: number): HTMLCanvasElement | null {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    const w = Math.ceil(width), h = Math.ceil(height);
    if (w > 4096 || h > 4096 || w * h * 4 > this.limit) return null;
    try {
      const canvas = this.factory(w, h);
      if (!canvas) return null;
      canvas.width = w;
      canvas.height = h;
      return canvas;
    } catch {
      return null;
    }
  }

  /** Ownership transfers to the cache; eviction releases the backing pixels. */
  put(key: string, canvas: HTMLCanvasElement): void {
    // A single canvas may only be owned by one entry. Renaming its key must
    // neither double-count its memory nor zero the pixels being transferred.
    for (const [otherKey, entry] of this.entries) {
      if (entry.canvas === canvas) {
        this.entries.delete(otherKey);
        this.bytes -= entry.bytes;
      }
    }
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.bytes -= old.bytes;
      this.release(old.canvas);
    }
    const width = canvas.width, height = canvas.height;
    const bytes = width * height * 4;
    if (!Number.isFinite(bytes) || width <= 0 || height <= 0 || width > 4096 || height > 4096 || bytes > this.limit) {
      this.release(canvas);
      return;
    }
    this.entries.set(key, { canvas, bytes });
    this.bytes += bytes;
    while (this.bytes > this.limit) {
      const first = this.entries.entries().next().value as [string, { canvas: HTMLCanvasElement; bytes: number }] | undefined;
      if (!first) break;
      this.entries.delete(first[0]);
      this.bytes -= first[1].bytes;
      this.release(first[1].canvas);
      this.evictions++;
    }
  }

  deletePrefix(prefix: string): void {
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      this.bytes -= entry.bytes;
      this.release(entry.canvas);
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) this.release(entry.canvas);
    this.entries.clear();
    this.bytes = 0;
  }

  private release(canvas: HTMLCanvasElement): void {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export interface NibTileNode {
  x: number;
  y: number;
  nx: number;
  ny: number;
  width: number;
  progress: number;
}
export interface NibTileSpan { start: number; end: number }

const finitePoint = (node: NibTileNode) => Number.isFinite(node.x) && Number.isFinite(node.y);
// The active prefix is swept exactly up to the current head. Keep that live
// vector work tiny while finished intervals remain inexpensive cached pixels.
const MAX_NODES = 6;
const MAX_PIXELS = 96;
const MAX_TURN = 0.55;

function monotoneSpan(nodes: readonly NibTileNode[], start: number, end: number): boolean {
  if (end <= start + 1) return true;
  const a = nodes[start], b = nodes[end];
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-8) return false;
  const tx = dx / length, ty = dy / length;
  let previousProjection = 0;
  let referenceAngle: number | null = null;
  for (let i = start; i <= end; i++) {
    const node = nodes[i];
    const projection = (node.x - a.x) * tx + (node.y - a.y) * ty;
    // A barely visible loop can pass a chord/arc-ratio test. Every individual
    // projection must advance, otherwise a reveal plane would expose the future.
    if (projection < previousProjection - 1e-8) return false;
    previousProjection = projection;
    const normalLength = Math.hypot(node.nx, node.ny);
    if (!Number.isFinite(normalLength) || normalLength < 1e-8) continue;
    const angle = Math.atan2(-node.nx, node.ny);
    if (referenceAngle === null) referenceAngle = angle;
    else if (Math.abs(Math.atan2(Math.sin(angle - referenceAngle), Math.cos(angle - referenceAngle))) > MAX_TURN) return false;
  }
  return true;
}

/**
 * Shared endpoints partition original arc intervals, never manufacture a new
 * centerline. Each tile is short and locally monotone so a cheap reveal plane
 * cannot expose a later loop. An indivisible long adjacent pair is retained;
 * its tight raster bounds can be checked separately by the cache's byte limit.
 */
export function splitNibTiles(nodes: readonly NibTileNode[], zoom = 1): NibTileSpan[] {
  const result: NibTileSpan[] = [];
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  let runStart = 0;
  while (runStart < nodes.length) {
    if (!finitePoint(nodes[runStart])) { runStart++; continue; }
    let runEnd = runStart;
    while (runEnd + 1 < nodes.length && finitePoint(nodes[runEnd + 1])) runEnd++;
    if (runEnd === runStart) result.push({ start: runStart, end: runStart });
    let start = runStart;
    while (start < runEnd) {
      let end = start + 1;
      let distance = Math.hypot(nodes[end].x - nodes[start].x, nodes[end].y - nodes[start].y) * scale;
      while (end < runEnd && end - start + 1 < MAX_NODES) {
        const next = end + 1;
        const candidateDistance = distance + Math.hypot(nodes[next].x - nodes[end].x, nodes[next].y - nodes[end].y) * scale;
        if (candidateDistance > MAX_PIXELS || !monotoneSpan(nodes, start, next)) break;
        distance = candidateDistance;
        end = next;
      }
      result.push({ start, end });
      start = end;
    }
    runStart = runEnd + 1;
  }
  return result;
}
