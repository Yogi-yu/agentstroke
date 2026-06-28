// ============================================================================
// structuralModes — mood-selected GENERATIVE structure (not appearance).
// ----------------------------------------------------------------------------
// Implements the three structural axes a mood selects:
//   • buildGeometryPath  — distinct point-construction strategy per GeometryMode
//   • assignBranches     — distinct branch topology per BranchingModel
//   • motionPacing       — distinct temporal pacing per MotionModel
// Each is a pure, deterministically-seeded function so the same (seed, mood)
// reproduces the same structure, while a different mood yields a structurally
// different stroke. Geometry here defines the PATH SHAPE itself — the catmull
// densifier downstream only smooths whatever shape these produce.
// ============================================================================

import type { BranchingModel, GeometryMode, MotionModel, Mood } from "@/lib/types";
import { makeRng } from "@/simulation/rng";
import { perp, vlerp, clamp01, type V2 } from "@/engine/strokePhysics";

const c01 = (p: V2): V2 => ({ x: clamp01(p.x), y: clamp01(p.y) });

export interface GeoParams {
  start: V2;
  end: V2;
  count: number;
  seed: number;
  mood: Mood;
}

// ---- 1. PATH GEOMETRY -------------------------------------------------------

export function buildGeometryPath(mode: GeometryMode, p: GeoParams): V2[] {
  switch (mode) {
    case "linear": return linear(p);
    case "curved": return curved(p);
    case "spiral": return spiral(p);
    case "recursive": return recursive(p);
    case "oscillatory": return oscillatory(p);
    case "fragmented": return fragmented(p);
  }
}

function linear({ start, end, count }: GeoParams): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < count; i++) out.push(c01(vlerp(start, end, count > 1 ? i / (count - 1) : 0)));
  return out;
}

function curved({ start, end, count, mood }: GeoParams): V2[] {
  const nrm = perp(start, end);
  // signed amplitude → curvature_bias controls bow side + magnitude
  const amp = mood.curvature_bias * 0.4 + Math.sign(mood.curvature_bias || 1) * 0.12;
  const out: V2[] = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const base = vlerp(start, end, t);
    const bow = Math.sin(t * Math.PI) * amp;
    out.push(c01({ x: base.x + nrm.x * bow, y: base.y + nrm.y * bow }));
  }
  return out;
}

function spiral({ start, end, count, mood }: GeoParams): V2[] {
  const center = vlerp(start, end, 0.5);
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const r0 = Math.hypot(start.x - center.x, start.y - center.y);
  const turns = 1 + (Math.abs(mood.curvature_bias) + mood.motion_variation) * 1.5; // 1..4 loops
  const dir = mood.drift_bias >= 0 ? 1 : -1;
  const out: V2[] = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const ang = a0 + dir * turns * Math.PI * 2 * t;
    const r = r0 * (1 - t) * (1 - 0.4 * t) + 0.02; // wind inward
    out.push(c01({ x: center.x + Math.cos(ang) * r, y: center.y + Math.sin(ang) * r }));
  }
  out[0] = c01(start);
  out[count - 1] = c01(end);
  return out;
}

function recursive({ start, end, count, seed, mood }: GeoParams): V2[] {
  const rng = makeRng(seed ^ 0xf4ac);
  let pts: V2[] = [start, end];
  let amp = 0.12 + Math.abs(mood.entropy_shift) * 0.3; // self-similar displacement
  while (pts.length < count) {
    const next: V2[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      next.push(a);
      const mid = vlerp(a, b, 0.5);
      const nrm = perp(a, b);
      const disp = (rng() - 0.5) * 2 * amp;
      next.push({ x: mid.x + nrm.x * disp, y: mid.y + nrm.y * disp });
    }
    next.push(pts[pts.length - 1]);
    pts = next;
    amp *= 0.55;
  }
  pts = pts.slice(0, count).map(c01);
  pts[0] = c01(start);
  pts[count - 1] = c01(end);
  return pts;
}

function oscillatory({ start, end, count, mood }: GeoParams): V2[] {
  const nrm = perp(start, end);
  const freq = 2 + mood.motion_variation * 5;
  const amp = 0.08 + Math.abs(mood.curvature_bias) * 0.24;
  const out: V2[] = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const base = vlerp(start, end, t);
    const off = Math.sin(t * Math.PI * freq) * amp * Math.sin(t * Math.PI); // taper to endpoints
    out.push(c01({ x: base.x + nrm.x * off, y: base.y + nrm.y * off }));
  }
  return out;
}

function fragmented({ start, end, count, seed, mood }: GeoParams): V2[] {
  const nrm = perp(start, end);
  const amp = 0.05 + Math.abs(mood.entropy_shift) * 0.25 + Math.abs(mood.drift_bias) * 0.15;
  const fragments = 3 + Math.floor(mood.motion_variation * 4);
  const dir = { x: end.x - start.x, y: end.y - start.y };
  const dl = Math.hypot(dir.x, dir.y) || 1;
  const out: V2[] = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const base = vlerp(start, end, t);
    // offset is CONSTANT within a fragment and jumps at boundaries → discontinuous
    const frag = Math.floor(t * fragments);
    const fr = makeRng(((seed ^ 0x57a5) + frag * 0x9e3779b1) >>> 0);
    const off = (fr() - 0.5) * 2 * amp;
    const along = (fr() - 0.5) * amp * 0.6;
    out.push(
      c01({
        x: base.x + nrm.x * off + (dir.x / dl) * along,
        y: base.y + nrm.y * off + (dir.y / dl) * along,
      }),
    );
  }
  out[0] = c01(start);
  out[count - 1] = c01(end);
  return out;
}

// ---- 2. BRANCHING TOPOLOGY --------------------------------------------------

/** Branch count per anchor index (0 at endpoints). Topology varies by model. */
export function assignBranches(
  model: BranchingModel,
  p: { count: number; seed: number; mood: Mood },
): number[] {
  const { count, seed, mood } = p;
  const rng = makeRng(seed ^ 0xb4a9c);
  const out = new Array<number>(count).fill(0);

  switch (model) {
    case "none":
      break;
    case "binary": {
      // a single binary split near mid-path → two spurs
      const i = Math.max(1, Math.min(count - 2, Math.round(count * 0.5 + (rng() - 0.5) * 2)));
      out[i] = 2;
      break;
    }
    case "tree": {
      // progressive expansion: branch density + count grow along the path
      for (let i = 1; i < count - 1; i++) {
        const progress = i / (count - 1);
        if (rng() < 0.3 + progress * 0.55) out[i] = 1 + Math.floor(progress * 2.5);
      }
      break;
    }
    case "chaotic": {
      // dense, high-variance multi-branching everywhere
      const p1 = 0.6 + Math.abs(mood.entropy_shift) * 0.3;
      for (let i = 1; i < count - 1; i++) {
        if (rng() < p1) out[i] = 1 + Math.floor(rng() * 3);
      }
      break;
    }
    case "delayed": {
      // nothing until the final stretch, then it fans out
      const startIdx = Math.max(1, Math.floor(count * 0.6));
      for (let i = startIdx; i < count - 1; i++) {
        if (rng() < 0.6) out[i] = 1 + Math.floor(rng() * 2);
      }
      break;
    }
  }
  return out;
}

// ---- 3. MOTION / TEMPORAL PACING -------------------------------------------

/** Per-anchor duration multiplier → distinct movement structure per model. */
export function motionPacing(model: MotionModel, count: number, seed: number): number[] {
  const rng = makeRng(seed ^ 0x770710);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    let m = 1;
    switch (model) {
      case "continuous": m = 1; break;
      case "segmented": m = i % 2 === 0 ? 1.6 : 0.4; break; // stop-go jumps
      case "jitter": m = 0.4 + rng() * 1.6; break; // erratic
      case "wave": m = 0.6 + 0.8 * (0.5 + 0.5 * Math.sin(t * Math.PI * 3)); break;
      case "burst": m = 0.4 + Math.pow((Math.sin(t * Math.PI * 2) + 1) / 2, 2) * 1.8; break;
    }
    out.push(m);
  }
  return out;
}
