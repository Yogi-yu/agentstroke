// ============================================================================
// Rendering Helpers — the canonical "TransitionPoint → visual" mapping.
// ----------------------------------------------------------------------------
// Shared by the live Starfield renderer and the Art Composition engine so the
// stroke identity stays consistent everywhere.
//
//   x,y         -> position on canvas
//   entropy     -> stroke blur / diffusion (shadowBlur + positional jitter)
//   confidence  -> brightness (lightness / alpha)
//   intensity   -> thickness (line width)
//   branch      -> number of split lines spawned
//   duration_ms -> spacing / temporal pacing (used by the animation clock)
// ============================================================================

import type { Agent, TransitionPoint } from "./types";

export interface Vec2 {
  x: number;
  y: number;
}

/** Agent's signature color at a given confidence, as an rgba string. */
export function agentColor(
  hue: number,
  confidence: number,
  alpha = 1,
  satBoost = 0,
): string {
  const sat = Math.round(70 + satBoost * 25);
  const light = Math.round(45 + confidence * 40); // brighter when confident
  return `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`;
}

/** Map an entropy value to a shadow blur radius in px. */
export function entropyBlur(entropy: number, scale = 1): number {
  return entropy * 26 * scale;
}

/** Map intensity to a line width in px. */
export function intensityWidth(intensity: number, scale = 1): number {
  return (0.6 + intensity * 4.2) * scale;
}

/** Canvas-space position for a point given canvas dimensions + padding. */
export function toCanvas(p: { x: number; y: number }, w: number, h: number, pad = 0.06): Vec2 {
  const px = pad + p.x * (1 - pad * 2);
  const py = pad + p.y * (1 - pad * 2);
  return { x: px * w, y: py * h };
}

/**
 * Catmull-Rom spline interpolation through the given control points, returning
 * `samples` densified points. Produces silky cognitive trajectories.
 */
export function catmullRom(points: Vec2[], samplesPerSeg = 12): Vec2[] {
  if (points.length < 3) return points.slice();
  const out: Vec2[] = [];
  const pts = points;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Cumulative timeline (ms) at each point, from duration_ms. */
export function timeline(points: TransitionPoint[]): number[] {
  const t: number[] = [];
  let acc = 0;
  for (const p of points) {
    t.push(acc);
    acc += p.duration_ms;
  }
  return t;
}

export function totalDuration(points: TransitionPoint[]): number {
  return points.reduce((a, p) => a + p.duration_ms, 0);
}

export const agentHue = (a: Agent) => a.style.hue;
