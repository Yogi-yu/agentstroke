// ============================================================================
// motionModels — the multi-mode motion system.
// ----------------------------------------------------------------------------
// Each TransitionPath travels from A → B via one of six motion archetypes.
// These functions turn (start, end, count, seed) into a normalized trajectory
// of points in [0,1]². The scalar fields (entropy/confidence/…) are layered on
// top by the generator; here we only shape geometry + branch hints.
// ============================================================================

import type { AgentStyle, MotionType } from "@/lib/types";
import { makeRng } from "@/simulation/rng";
import {
  attractorPull,
  clamp01,
  cubicBezier,
  fbm1,
  perp,
  quadBezier,
  vadd,
  vlerp,
  vscale,
  type V2,
} from "./strokePhysics";

export interface Trajectory {
  points: V2[];
  /** indices where the stroke conceptually branches (drives branch counts). */
  branchAt: number[];
}

export interface MotionParams {
  start: V2;
  end: V2;
  count: number;
  seed: number;
  style: AgentStyle;
}

const c01 = (p: V2): V2 => ({ x: clamp01(p.x), y: clamp01(p.y) });

/**
 * Pick a motion archetype. Weighted by the agent's genome so personalities are
 * expressed (e.g. branchy agents fractal/drift more; smooth agents curve more),
 * but every type stays reachable for diversity.
 */
export function chooseMotionType(
  style: AgentStyle,
  seed: number,
  bias?: { motion: MotionType; strength: number },
): MotionType {
  const rng = makeRng(seed ^ 0x5bf03);
  const w: Record<MotionType, number> = {
    direct: 1 + (1 - style.entropyBias) * 1.5,
    curved: 1 + style.movementSmoothness * 2,
    orbital: 0.8 + style.movementSmoothness * 1.2,
    fractal: 0.4 + style.branchingTendency * 3,
    drift: 0.6 + style.entropyBias * 2.5,
    attractor: 0.6 + style.entropyBias * 1.5,
  };
  // Optional bias toward a signature archetype (keeps category identity while
  // still letting the mood seed shift the pick across time buckets).
  if (bias && bias.strength > 0) w[bias.motion] += bias.strength;
  const types = Object.keys(w) as MotionType[];
  const total = types.reduce((a, t) => a + w[t], 0);
  let r = rng() * total;
  for (const t of types) {
    r -= w[t];
    if (r <= 0) return t;
  }
  return "curved";
}

export function generateTrajectory(type: MotionType, p: MotionParams): Trajectory {
  switch (type) {
    case "direct":
      return direct(p);
    case "curved":
      return curved(p);
    case "orbital":
      return orbital(p);
    case "fractal":
      return fractal(p);
    case "drift":
      return drift(p);
    case "attractor":
      return attractor(p);
  }
}

function direct({ start, end, count }: MotionParams): Trajectory {
  const points: V2[] = [];
  for (let i = 0; i < count; i++) points.push(c01(vlerp(start, end, i / (count - 1))));
  return { points, branchAt: [] };
}

function curved({ start, end, count, seed, style }: MotionParams): Trajectory {
  const rng = makeRng(seed ^ 0xc0ffee);
  const n = perp(start, end);
  const amp = (0.18 + rng() * 0.3) * (0.5 + style.entropyBias);
  const side = rng() < 0.5 ? -1 : 1;
  const mid = vlerp(start, end, 0.5);
  // two control points → gentle S / arc
  const c0 = vadd(vlerp(start, mid, 0.6), vscale(n, amp * side));
  const c1 = vadd(vlerp(mid, end, 0.4), vscale(n, amp * side * (rng() < 0.4 ? -0.7 : 1)));
  const points: V2[] = [];
  for (let i = 0; i < count; i++) {
    points.push(c01(cubicBezier(start, c0, c1, end, i / (count - 1))));
  }
  return { points, branchAt: [] };
}

function orbital({ start, end, count, seed, style }: MotionParams): Trajectory {
  const rng = makeRng(seed ^ 0x07b17a);
  const center = vadd(vlerp(start, end, 0.5), {
    x: (rng() - 0.5) * 0.18,
    y: (rng() - 0.5) * 0.18,
  });
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);
  const r0 = Math.hypot(start.x - center.x, start.y - center.y);
  const r1 = Math.hypot(end.x - center.x, end.y - center.y);
  // sweep the short way, plus an extra partial loop for orbital feel
  let delta = a1 - a0;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const loop = (rng() < 0.5 ? 1 : -1) * Math.PI * 2 * (0.4 + style.movementSmoothness * 0.6);
  const points: V2[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const ang = a0 + (delta + loop) * t;
    const r = r0 + (r1 - r0) * t;
    points.push(c01({ x: center.x + Math.cos(ang) * r, y: center.y + Math.sin(ang) * r }));
  }
  // ensure endpoints land exactly on start/end
  points[0] = c01(start);
  points[count - 1] = c01(end);
  return { points, branchAt: [] };
}

function fractal({ start, end, count, seed, style }: MotionParams): Trajectory {
  const rng = makeRng(seed ^ 0xf4ac);
  // midpoint-displacement subdivision
  let pts: V2[] = [start, end];
  let amp = (0.12 + rng() * 0.2) * (0.6 + style.branchingTendency);
  while (pts.length < count) {
    const next: V2[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      next.push(a);
      const mid = vlerp(a, b, 0.5);
      const n = perp(a, b);
      const disp = (rng() - 0.5) * 2 * amp;
      next.push(vadd(mid, vscale(n, disp)));
    }
    next.push(pts[pts.length - 1]);
    pts = next;
    amp *= 0.55;
  }
  pts = pts.slice(0, count).map(c01);
  pts[0] = c01(start);
  pts[count - 1] = c01(end);
  // branch on the displaced interior vertices
  const branchAt: number[] = [];
  for (let i = 1; i < count - 1; i++) if (rng() < 0.55) branchAt.push(i);
  return { points: pts, branchAt };
}

function drift({ start, end, count, seed, style }: MotionParams): Trajectory {
  const n = perp(start, end);
  const amp = (0.1 + style.entropyBias * 0.35);
  const freq = 1.5 + style.entropyBias * 4;
  const points: V2[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const base = vlerp(start, end, t);
    const off = (fbm1(t * freq + 3.1, seed, 3) - 0.5) * 2 * amp;
    const along = (fbm1(t * freq * 0.7 + 11.7, seed ^ 0x99, 2) - 0.5) * amp * 0.5;
    const dir = { x: end.x - start.x, y: end.y - start.y };
    const dl = Math.hypot(dir.x, dir.y) || 1;
    points.push(
      c01({
        x: base.x + n.x * off + (dir.x / dl) * along,
        y: base.y + n.y * off + (dir.y / dl) * along,
      }),
    );
  }
  points[0] = c01(start);
  points[count - 1] = c01(end);
  return { points, branchAt: [] };
}

function attractor({ start, end, count, seed, style }: MotionParams): Trajectory {
  const rng = makeRng(seed ^ 0xa771ac);
  const nAttr = 2 + Math.floor(rng() * 2);
  const attractors: V2[] = Array.from({ length: nAttr }, () => ({
    x: 0.2 + rng() * 0.6,
    y: 0.2 + rng() * 0.6,
  }));
  const strength = 0.004 + style.entropyBias * 0.01;
  const points: V2[] = [c01(start)];
  let p = { ...start };
  for (let i = 1; i < count; i++) {
    const t = i / (count - 1);
    // progress toward end + pull toward attractors
    const toEnd = { x: end.x - p.x, y: end.y - p.y };
    const pull = attractorPull(p, attractors, strength);
    p = {
      x: p.x + toEnd.x * 0.28 + pull.x,
      y: p.y + toEnd.y * 0.28 + pull.y,
    };
    // blend toward the true endpoint as we approach the end so B is reached
    p = vlerp(p, end, t * t * 0.5);
    points.push(c01(p));
  }
  points[count - 1] = c01(end);
  return { points, branchAt: [] };
}
