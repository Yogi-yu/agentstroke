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
import { buildVisualPath, resolveVisualSignature, sampleProfile } from "./visualSignature";

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
  const sig = resolveVisualSignature(path, opts.hue);
  const seed = path.base_seed ?? hashStr(path.id);
  const visualPts = buildVisualPath(pts, sig, seed);
  const P = visualPts.length;
  const c = visualPts.reduce((a, p) => ({ x: a.x + p.x / P, y: a.y + p.y / P }), { x: 0, y: 0 });

  // transformed control points
  const tp: XY[] = visualPts.map((p) => applyTransform(p, transform, c));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of tp) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  const scalarAt = (t: number) => {
    const x = Math.max(0, Math.min(1, t)) * Math.max(0, pts.length - 1);
    const i = Math.floor(x);
    const a = pts[i] ?? pts[0];
    const b = pts[Math.min(pts.length - 1, i + 1)] ?? a;
    const f = x - i;
    return {
      entropy: lerp(a?.entropy ?? 0.5, b?.entropy ?? 0.5, f),
      confidence: lerp(a?.confidence ?? 0.5, b?.confidence ?? 0.5, f),
      intensity: lerp(a?.intensity ?? 0.5, b?.intensity ?? 0.5, f),
      width: lerp(a?.stroke_width ?? 1, b?.stroke_width ?? 1, f),
    };
  };

  // Densify while blending linear corners with Catmull-Rom. Sharpness 1 keeps
  // the hard angle; sharpness 0 rounds it completely.
  const rp: RP[] = [];
  for (let k = 0; k < P - 1; k++) {
    const a0 = tp[k - 1] ?? tp[k];
    const a1 = tp[k];
    const a2 = tp[k + 1];
    const a3 = tp[k + 2] ?? a2;
    const s0 = scalarAt(k / Math.max(1, P - 1));
    const s1 = scalarAt((k + 1) / Math.max(1, P - 1));
    const density = P > 80 ? 1 : SAMPLES_PER_SPAN;
    const steps = k === P - 2 ? density + 1 : density;
    for (let s = 0; s < steps; s++) {
      const t = s / density;
      const lx = lerp(a1.x, a2.x, t);
      const ly = lerp(a1.y, a2.y, t);
      const cx = catmull(a0.x, a1.x, a2.x, a3.x, t);
      const cy = catmull(a0.y, a1.y, a2.y, a3.y, t);
      rp.push({
        x: lerp(cx, lx, sig.turn_sharpness),
        y: lerp(cy, ly, sig.turn_sharpness),
        entropy: lerp(s0.entropy, s1.entropy, t),
        confidence: lerp(s0.confidence, s1.confidence, t),
        intensity: lerp(s0.intensity, s1.intensity, t),
        width: lerp(s0.width, s1.width, t),
        seg01: (k + t) / (P - 1),
      });
    }
  }

  // A visual stroke is one uninterrupted gesture. Entropy and length shape
  // crossings; branches only enrich the composite head and never spawn lines.
  const count = Math.max(0, rp.length - 1);
  const data = new Float32Array(count * FLOATS_PER_INSTANCE);
  const phase = (hashStr(path.id) % 1000) / 1000;
  const shapeCode: Record<string, number> = { round: 0, square: 1, diamond: 2, triangle: 3, ring: 4, organic: 5 };
  const primaryHead = shapeCode[sig.brush_heads[0] ?? "round"] ?? 0;
  const brushStyleCode = sig.brush_style === "hard" ? 0 : sig.brush_style === "soft" ? 1 : sig.brush_style === "watercolor" ? 2 : 3;

  const write = (i: number, ax: number, ay: number, bx: number, by: number, aw: number, bw: number, e: number, cf: number, it: number, s0: number, s1: number) => {
    const o = i * FLOATS_PER_INSTANCE;
    const sm = (s0 + s1) * 0.5;
    let hue = sig.hue_start;
    if (sig.color_mode === "duotone") hue = lerp(sig.hue_start, sig.hue_end, Math.min(1, sm * 1.35));
    if (sig.color_mode === "spectrum") hue = sig.hue_start + ((sig.hue_end - sig.hue_start + 540) % 360 - 180) * sm + sm * 180;
    // Even a monochrome stroke carries local pigment variation: entropy shifts
    // hue, confidence controls value, and intensity controls saturation.
    const localHue = hue + (e - 0.5) * (sig.color_mode === "monochrome" ? 26 : 48) + Math.sin(sm * Math.PI * 2) * 9;
    const saturation = 0.42 + it * 0.38 + Math.abs(sig.color_temperature) * 0.08;
    const lightness = 0.3 + cf * 0.22 + it * 0.1;
    const [r, g, b] = hslToRgb(localHue, saturation, lightness);
    data[o + OFF.start] = ax; data[o + OFF.start + 1] = ay;
    data[o + OFF.end] = bx; data[o + OFF.end + 1] = by;
    data[o + OFF.width] = aw; data[o + OFF.width + 1] = bw;
    data[o + OFF.color] = r; data[o + OFF.color + 1] = g; data[o + OFF.color + 2] = b;
    data[o + OFF.meta] = e; data[o + OFF.meta + 1] = cf; data[o + OFF.meta + 2] = it;
    data[o + OFF.seg] = s0; data[o + OFF.seg + 1] = s1;
    data[o + OFF.anim] = phase; data[o + OFF.anim + 1] = opts.speed * sampleProfile(sig.speed_profile, sm); data[o + OFF.anim + 2] = opts.age01;
    data[o + OFF.agentIdx] = opts.agentIdx;
    data[o + OFF.strokeIdx] = opts.strokeIdx;
    data[o + OFF.visual] = sig.width_ratio;
    data[o + OFF.visual + 1] = primaryHead;
    data[o + OFF.visual + 2] = sig.brush_heads.length;
    data[o + OFF.visual + 3] = brushStyleCode;
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
  return { data, count, controlPoints: tp, bounds: { minX, minY, maxX, maxY } };
}
