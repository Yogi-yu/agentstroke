import type { GeometryMode, StrokeMotionPattern, StrokeVisualSignature, TransitionPoint } from "@/lib/types";

export interface MotionPoint { x: number; y: number }

export interface MotionPathResult {
  points: MotionPoint[];
  pattern: StrokeMotionPattern;
  /** Entropy's ceiling, not a request to paste this many loop symbols. */
  crossingBudget: number;
  /** Actual distinct self-intersections of the returned continuous polyline. */
  crossingsUsed: number;
  turnBudget: number;
  reversalBudget: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (value: number | undefined, fallback: number) => Number.isFinite(value) ? value! : fallback;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const cross = (a: MotionPoint, b: MotionPoint) => a.x * b.y - a.y * b.x;

export const MOTION_PATTERN_BY_GEOMETRY: Record<GeometryMode, StrokeMotionPattern> = {
  linear: "glide",
  curved: "arc",
  oscillatory: "wave",
  recursive: "fold",
  spiral: "orbit",
  fragmented: "wander",
};

function distance(points: readonly MotionPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

/** Distinct contacts of non-adjacent segments; never count a join twice. */
export function countPathCrossings(points: readonly MotionPoint[]): number {
  const contacts: MotionPoint[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const r = { x: points[i + 1].x - a.x, y: points[i + 1].y - a.y };
    for (let j = i + 2; j < points.length - 1; j++) {
      const b = points[j];
      const s = { x: points[j + 1].x - b.x, y: points[j + 1].y - b.y };
      const determinant = cross(r, s);
      if (Math.abs(determinant) < 1e-12) continue;
      const offset = { x: b.x - a.x, y: b.y - a.y };
      const t = cross(offset, s) / determinant;
      const u = cross(offset, r) / determinant;
      if (t < -1e-8 || t > 1 + 1e-8 || u < -1e-8 || u > 1 + 1e-8) continue;
      // Closing an otherwise simple gesture at its own start is not a crossing.
      if (i === 0 && j === points.length - 2 && t <= 1e-8 && u >= 1 - 1e-8) continue;
      const contact = { x: a.x + r.x * t, y: a.y + r.y * t };
      if (!contacts.some((point) => Math.hypot(point.x - contact.x, point.y - contact.y) < 1e-7)) contacts.push(contact);
    }
  }
  return contacts.length;
}

function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function sampledCurve(fn: (t: number) => MotionPoint): MotionPoint[] {
  return Array.from({ length: 65 }, (_, index) => fn(index / 64));
}

function densify(points: readonly MotionPoint[]): MotionPoint[] {
  const total = distance(points);
  if (total < 1e-10) return [{ ...points[0] }, { ...points[0] }];
  const result = [{ ...points[0] }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const segment = Math.hypot(b.x - a.x, b.y - a.y);
    if (segment < 1e-10) continue;
    const steps = Math.max(1, Math.ceil(segment / total * 96));
    for (let step = 1; step <= steps; step++) result.push({ x: mix(a.x, b.x, step / steps), y: mix(a.y, b.y, step / steps) });
  }
  return result;
}

/**
 * Six complete motion grammars, each producing ONE ordered centreline. The
 * crossing budget can restrict a grammar but never replaces it with a weave.
 * All randomness is seeded variation inside the chosen attribute-led family.
 */
export function buildMotionPath(
  sourcePoints: readonly TransitionPoint[],
  signature: StrokeVisualSignature,
  fallbackSeed: number,
): MotionPathResult {
  const source = sourcePoints.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const pattern = signature.motion_pattern ?? "glide";
  const turnBudget = Math.round(clamp(finite(signature.turn_count, 0), 0, 4));
  const reversalCapacity = signature.length_class === "short" ? 1 : signature.length_class === "medium" ? 2 : 4;
  const reversalBudget = Math.round(clamp(finite(signature.reversal_count, 0), 0, reversalCapacity));
  const crossingBudget = Math.floor(clamp(finite(signature.crossings, 0), 0, signature.length_class === "long" ? 8 : 4));
  const result = (points: MotionPoint[]): MotionPathResult => ({
    points, pattern, crossingBudget, crossingsUsed: countPathCrossings(points), turnBudget, reversalBudget,
  });
  const first = source[0] ?? { x: 0.5, y: 0.5 };
  const length = Math.max(0, finite(signature.length, 0));
  if (source.length < 2 || length <= 0.002) {
    const point = { x: clamp(first.x, 0.015, 0.985), y: clamp(first.y, 0.015, 0.985) };
    return result([point, { ...point }]);
  }

  const random = randomSource(signature.motion_seed ?? fallbackSeed);
  const amplitude = clamp(finite(signature.motion_amplitude, 0.45), 0, 1);
  const curvature = clamp(finite(signature.motion_curvature, 0.3), -1, 1);
  const side = Math.abs(curvature) > 0.02 ? Math.sign(curvature) : random() < 0.5 ? -1 : 1;
  const phase = random() * Math.PI * 2;
  let raw: MotionPoint[];

  if (pattern === "glide") {
    // Confident direct travel: only a slight crosswind, never repetitive loops.
    raw = sampledCurve((t) => ({ x: t - 0.5, y: side * amplitude * 0.025 * Math.sin(t * Math.PI) }));
  } else if (pattern === "arc") {
    // One broad circular sweep. Curvature chooses its side and angular span.
    const sweep = Math.PI * (0.32 + Math.abs(curvature) * 0.56 + Math.min(2, reversalBudget) * 0.14);
    raw = sampledCurve((t) => {
      const angle = (t - 0.5) * sweep;
      return { x: Math.sin(angle), y: side * Math.cos(angle) };
    });
  } else if (pattern === "wave") {
    // One to four broad lateral lobes; forward travel remains monotonic.
    const lobes = Math.max(1, Math.min(4, Math.max(turnBudget, reversalBudget)));
    const height = 0.055 + amplitude * 0.18;
    raw = sampledCurve((t) => ({ x: t - 0.5, y: side * height * Math.sin(Math.PI * lobes * t) }));
  } else if (pattern === "orbit") {
    // A single expanding orbit, not a chain of closed rings or attached 8s.
    // The angular range permits at most four major directional reversals.
    const sweep = Math.PI * 2 * (0.3 + reversalBudget * 0.22 + amplitude * 0.2);
    raw = sampledCurve((t) => {
      const radius = 0.08 + 0.48 * t;
      const angle = phase + side * t * sweep;
      return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
    });
  } else if (pattern === "fold") {
    const turns = Math.min(4, Math.max(turnBudget, reversalBudget));
    const count = turns + 2;
    const lanes = Array.from({ length: count }, (_, index) => ({
      x: (index % 2 === 0 ? -0.5 : 0.5) * (1 - index / count * 0.18),
      y: side * (index / (count - 1) - 0.5) * (0.38 + amplitude * 0.35),
    }));
    raw = lanes;
    if (crossingBudget > 0 && turns >= 2) {
      // One folded chord traversal can naturally cross earlier legs. It has
      // only turns+2 vertices and never inserts a separate loop subpath.
      const chords = Array.from({ length: count }, (_, index) => {
        const angle = phase + index * Math.PI * 4 / 5;
        return { x: Math.cos(angle) * 0.56 + index * 0.014, y: side * Math.sin(angle) * (0.3 + amplitude * 0.22) };
      });
      for (const blend of [1, 0.8, 0.6, 0.4, 0.2]) {
        const candidate = lanes.map((point, index) => ({ x: mix(point.x, chords[index].x, blend), y: mix(point.y, chords[index].y, blend) }));
        const used = countPathCrossings(candidate);
        if (used > 0 && used <= crossingBudget) { raw = candidate; break; }
      }
    }
  } else {
    // Entropy-led wandering: a handful of unequal connected legs, not noise
    // sprinkled over a common template. Higher motion permits larger headings.
    const turns = turnBudget;
    const headings = Array.from({ length: turns }, () => random() * 2 - 1);
    const spans = Array.from({ length: turns + 1 }, () => 0.17 + random() * 0.16);
    const bend = (0.25 + amplitude * 0.8 + reversalBudget * 0.22) * Math.PI;
    raw = [];
    for (const restraint of [1, 0.72, 0.44, 0.18, 0]) {
      const candidate: MotionPoint[] = [{ x: 0, y: 0 }];
      let heading = side * (random() - 0.5) * 0.16;
      spans.forEach((span, index) => {
        if (index > 0) heading += headings[index - 1] * bend * restraint;
        const previous = candidate[candidate.length - 1];
        candidate.push({ x: previous.x + Math.cos(heading) * span, y: previous.y + Math.sin(heading) * span });
      });
      if (countPathCrossings(candidate) <= crossingBudget) { raw = candidate; break; }
    }
  }

  // Category maxima are continuous travelled distances, not fixed templates.
  // Keep the 1/10, 1/2, 1 relationship while permitting near-point short marks.
  const categoryScale = signature.length_class === "short"
    ? clamp(length / 5, 0, 1) * 0.1
    : signature.length_class === "medium"
      ? mix(0.1, 0.5, clamp(length - 5, 0, 1))
      : mix(0.5, 1, clamp((length - 6) / 15, 0, 1));
  const targetLength = categoryScale * 1.12;
  const rawLength = distance(raw);
  if (rawLength < 1e-9) return result([{ x: first.x, y: first.y }, { x: first.x, y: first.y }]);
  const angle = finite(signature.direction_angle_deg, 0) * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const ratio = targetLength / rawLength;
  let transformed = raw.map(({ x, y }) => ({ x: (x * cos - y * sin) * ratio, y: (x * sin + y * cos) * ratio }));
  const bounds = (points: MotionPoint[]) => ({
    minX: Math.min(...points.map((point) => point.x)), maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)), maxY: Math.max(...points.map((point) => point.y)),
  });
  let box = bounds(transformed);
  const fit = Math.min(1, 0.94 / Math.max(1e-9, box.maxX - box.minX), 0.94 / Math.max(1e-9, box.maxY - box.minY));
  // Uniform fit + translation preserves crossings and shape. Per-point clamp
  // would collapse different trajectories into the same straight canvas edge.
  transformed = transformed.map((point) => ({ x: point.x * fit, y: point.y * fit }));
  box = bounds(transformed);
  const centerX = source.reduce((sum, point) => sum + clamp(point.x, 0.015, 0.985), 0) / source.length;
  const centerY = source.reduce((sum, point) => sum + clamp(point.y, 0.015, 0.985), 0) / source.length;
  const halfWidth = (box.maxX - box.minX) * 0.5, halfHeight = (box.maxY - box.minY) * 0.5;
  const x = clamp(centerX, 0.015 + halfWidth, 0.985 - halfWidth) - (box.minX + box.maxX) * 0.5;
  const y = clamp(centerY, 0.015 + halfHeight, 0.985 - halfHeight) - (box.minY + box.maxY) * 0.5;
  return result(densify(transformed.map((point) => ({ x: point.x + x, y: point.y + y }))));
}
