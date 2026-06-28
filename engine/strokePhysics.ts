// ============================================================================
// strokePhysics — low-level math used by the motion models.
// ----------------------------------------------------------------------------
// Pure, deterministic helpers: value noise (Perlin-like), bezier curves,
// vector ops and attractor integration. No rendering, no state.
// ============================================================================

export interface V2 {
  x: number;
  y: number;
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export const vadd = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
export const vsub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
export const vscale = (a: V2, s: number): V2 => ({ x: a.x * s, y: a.y * s });
export const vlen = (a: V2) => Math.hypot(a.x, a.y);
export const vlerp = (a: V2, b: V2, t: number): V2 => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
});

/** Unit perpendicular to the a→b direction. */
export function perp(a: V2, b: V2): V2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len };
}

// --- value noise -------------------------------------------------------------
function hash1(i: number, seed: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(seed, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h >>> 0) / 4294967296;
}

/** Smooth 1D value noise in [0,1]. */
export function valueNoise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash1(i, seed);
  const b = hash1(i + 1, seed);
  return a + (b - a) * fade(f);
}

/** Fractal (multi-octave) 1D noise in [0,1]. */
export function fbm1(x: number, seed: number, octaves = 3): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise1(x * freq, seed + o * 1013) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// --- bezier ------------------------------------------------------------------
export function quadBezier(p0: V2, c: V2, p1: V2, t: number): V2 {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

export function cubicBezier(p0: V2, c0: V2, c1: V2, p1: V2, t: number): V2 {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c0.x + c * c1.x + d * p1.x,
    y: a * p0.y + b * c0.y + c * c1.y + d * p1.y,
  };
}

// --- attractor field ---------------------------------------------------------
/** A single step of velocity-less attractor pull toward the strongest nearby well. */
export function attractorPull(p: V2, attractors: V2[], strength: number): V2 {
  let fx = 0;
  let fy = 0;
  for (const a of attractors) {
    const dx = a.x - p.x;
    const dy = a.y - p.y;
    const d2 = dx * dx + dy * dy + 0.02; // softening
    const f = strength / d2;
    fx += dx * f;
    fy += dy * f;
  }
  return { x: fx, y: fy };
}
