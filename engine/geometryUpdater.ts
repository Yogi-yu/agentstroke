// ============================================================================
// geometryUpdater — build one stroke's instanced geometry block.
// ----------------------------------------------------------------------------
// Produces the interleaved Float32Array for a single stroke (densified with a
// Catmull-Rom spline + branch spurs), with its editable transform applied to
// the control points first. Used for both full repacks and in-place
// (bufferSubData) transform updates — the segment COUNT is transform-invariant,
// so an edited stroke writes back into the exact same buffer range.
// ============================================================================

import type { StrokeTransform, TransitionPath } from "@/lib/types";
import { hashStr } from "@/simulation/rng";
import { applyTransform, pathCentroid, type XY } from "./strokeMutation";
import { FLOATS_PER_INSTANCE, OFF, hslToRgb } from "@/render/strokeGeometry";

export interface StrokeBlock {
  data: Float32Array; // length = count * FLOATS_PER_INSTANCE
  count: number; // number of segment instances
  controlPoints: XY[]; // transformed control points (for the hitmap)
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface BlockOpts {
  hue: number;
  speed: number;
  age01: number;
  strokeIdx: number;
  agentIdx: number;
}

const SAMPLES_PER_SPAN = 6;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

interface RP {
  x: number; y: number;
  entropy: number; confidence: number; intensity: number; width: number;
  seg01: number;
}

export function buildStrokeBlock(
  path: TransitionPath,
  transform: StrokeTransform,
  opts: BlockOpts,
): StrokeBlock {
  const pts = path.points;
  const P = pts.length;
  const c = pathCentroid(pts);

  // transformed control points
  const tp: XY[] = pts.map((p) => applyTransform(p, transform, c));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of tp) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  // densify with catmull-rom over transformed positions; linear on scalars
  const rp: RP[] = [];
  for (let k = 0; k < P - 1; k++) {
    const a0 = tp[k - 1] ?? tp[k];
    const a1 = tp[k];
    const a2 = tp[k + 1];
    const a3 = tp[k + 2] ?? a2;
    const s0 = pts[k];
    const s1 = pts[k + 1];
    const steps = k === P - 2 ? SAMPLES_PER_SPAN + 1 : SAMPLES_PER_SPAN;
    for (let s = 0; s < steps; s++) {
      const t = s / SAMPLES_PER_SPAN;
      rp.push({
        x: catmull(a0.x, a1.x, a2.x, a3.x, t),
        y: catmull(a0.y, a1.y, a2.y, a3.y, t),
        entropy: lerp(s0.entropy, s1.entropy, t),
        confidence: lerp(s0.confidence, s1.confidence, t),
        intensity: lerp(s0.intensity, s1.intensity, t),
        width: lerp(s0.stroke_width, s1.stroke_width, t),
        seg01: (k + t) / (P - 1),
      });
    }
  }

  // branch spurs at branchy points (visible multi-lines)
  interface Spur { x: number; y: number; bx: number; by: number; w: number; e: number; cf: number; it: number; seg01: number }
  const spurs: Spur[] = [];
  for (let k = 0; k < P; k++) {
    const pt = pts[k];
    if (pt.branch <= 0) continue;
    const here = tp[k];
    const nbr = tp[k + 1] ?? tp[k - 1] ?? here;
    const baseAng = Math.atan2(nbr.y - here.y, nbr.x - here.x) + Math.PI / 2;
    const seg01 = k / (P - 1);
    for (let s = 0; s < pt.branch; s++) {
      const ang = baseAng + (s - (pt.branch - 1) / 2) * 0.9 + transform.rotation;
      const len = (0.016 + pt.entropy * 0.05 + pt.intensity * 0.02) * transform.scale;
      spurs.push({
        x: here.x, y: here.y,
        bx: here.x + Math.cos(ang) * len,
        by: here.y + Math.sin(ang) * len,
        w: pt.stroke_width * 0.7, e: pt.entropy, cf: pt.confidence, it: pt.intensity * 0.8,
        seg01,
      });
    }
  }

  const count = Math.max(0, rp.length - 1) + spurs.length;
  const data = new Float32Array(count * FLOATS_PER_INSTANCE);
  const [r, g, b] = hslToRgb(opts.hue, 0.72, 0.56);
  const phase = (hashStr(path.id) % 1000) / 1000;

  const write = (i: number, ax: number, ay: number, bx: number, by: number, aw: number, bw: number, e: number, cf: number, it: number, s0: number, s1: number) => {
    const o = i * FLOATS_PER_INSTANCE;
    data[o + OFF.start] = ax; data[o + OFF.start + 1] = ay;
    data[o + OFF.end] = bx; data[o + OFF.end + 1] = by;
    data[o + OFF.width] = aw; data[o + OFF.width + 1] = bw;
    data[o + OFF.color] = r; data[o + OFF.color + 1] = g; data[o + OFF.color + 2] = b;
    data[o + OFF.meta] = e; data[o + OFF.meta + 1] = cf; data[o + OFF.meta + 2] = it;
    data[o + OFF.seg] = s0; data[o + OFF.seg + 1] = s1;
    data[o + OFF.anim] = phase; data[o + OFF.anim + 1] = opts.speed; data[o + OFF.anim + 2] = opts.age01;
    data[o + OFF.agentIdx] = opts.agentIdx;
    data[o + OFF.strokeIdx] = opts.strokeIdx;
  };

  let i = 0;
  for (let k = 0; k < rp.length - 1; k++) {
    const a = rp[k], bb = rp[k + 1];
    write(
      i++, a.x, a.y, bb.x, bb.y, a.width, bb.width,
      (a.entropy + bb.entropy) * 0.5, (a.confidence + bb.confidence) * 0.5, (a.intensity + bb.intensity) * 0.5,
      a.seg01, bb.seg01,
    );
  }
  for (const sp of spurs) {
    write(i++, sp.x, sp.y, sp.bx, sp.by, sp.w, 0.5, sp.e, sp.cf, sp.it, sp.seg01, sp.seg01);
  }

  return { data, count, controlPoints: tp, bounds: { minX, minY, maxX, maxY } };
}
