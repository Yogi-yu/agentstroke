import type { GeometryMode, Mood, MotionModel, StrokeVisualSignature, TransitionPath, TransitionPoint } from "@/lib/types";
import { hashStr } from "@/simulation/rng";
import { buildMotionPath, MOTION_PATTERN_BY_GEOMETRY } from "./motionPattern";

export interface XY { x: number; y: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const DISPLAY_WIDTH_MAX_RATIO = 0.008;
export const WIDTH_STABILITY_CONSTANT_THRESHOLD = 0.02;
export const WIDTH_STABILITY_FREQUENT_THRESHOLD = 0.45;
export const WIDTH_PRESSURE_MIN = 0.15;
export const WIDTH_PRESSURE_MAX = 2.2;

/** Original pacing-uniformity signal, shared with the attribute inspector. */
export function motionStabilityFromDurations(source: readonly number[]): number {
  if (!source.length) return 1;
  const durations = source.map((value) => Number.isFinite(value) ? Math.max(0, value) : 0);
  const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  if (mean <= 0) return 1;
  const variance = durations.reduce((sum, value) => sum + (value - mean) ** 2, 0) / durations.length;
  return clamp(1 - Math.sqrt(variance) / mean, 0, 1);
}

/**
 * Seeded press/lift extrema. No mean normalization: it previously compressed
 * the contrast back toward an almost uniform line. Every counted transition
 * now crosses between a fine 0.15–0.30 valley and a broad 1.85–2.20 peak.
 */
export function createWidthProfile(stability: number, seed: number): {
  width_change_count: number;
  width_profile: number[];
} {
  let state = ((seed || 1) ^ 0x9e3779b9) >>> 0;
  const random = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
  const signal = Number.isFinite(stability) ? clamp(stability, 0, 1) : 0;
  const width_change_count = signal < WIDTH_STABILITY_CONSTANT_THRESHOLD
    ? 0
    : signal < WIDTH_STABILITY_FREQUENT_THRESHOLD
      ? 1 + Math.floor(random() * 3)
      : 5 + Math.floor(random() * 4);
  if (width_change_count === 0) return { width_change_count, width_profile: [1, 1] };
  const startHigh = random() >= 0.5;
  const width_profile = Array.from({ length: width_change_count + 1 }, (_, index) => {
    const high = (index % 2 === 0) === startHigh;
    const pressure = high ? 1.85 + random() * 0.35 : WIDTH_PRESSURE_MIN + random() * 0.15;
    return Number(clamp(pressure, WIDTH_PRESSURE_MIN, WIDTH_PRESSURE_MAX).toFixed(3));
  });
  return { width_change_count, width_profile };
}

interface SignatureSource {
  points: TransitionPoint[];
  mood: Mood;
  baseHue: number;
  seed?: number;
  geometryMode?: GeometryMode;
  motionModel?: MotionModel;
}

const avg = (pts: TransitionPoint[], key: "entropy" | "confidence" | "intensity") =>
  pts.length ? pts.reduce((sum, p) => sum + p[key], 0) / pts.length : 0;

/** Derive all seven visual variables from the existing semantic path. */
export function createVisualSignature(source: SignatureSource): StrokeVisualSignature {
  const { points, mood, baseHue, geometryMode, motionModel, seed = 1 } = source;
  const entropy = avg(points, "entropy");
  const confidence = avg(points, "confidence");
  const intensity = avg(points, "intensity");
  const totalDuration = points.reduce((sum, p) => sum + p.duration_ms, 0);
  const branchTotal = points.reduce((sum, p) => sum + p.branch, 0);
  const depth01 = clamp((points.length - 2) / 10, 0, 1);
  const duration01 = clamp(totalDuration / 6000, 0, 1);

  // Duration provides travelled time; semantic depth provides travelled ideas.
  const lengthEnergy = duration01 * 0.62 + depth01 * 0.28 + intensity * 0.1;
  const length = intensity < 0.015 ? 0 : 21 * Math.pow(clamp(lengthEnergy, 0, 1), 2.25);
  const length_class = length < 5 ? "short" : length <= 6 ? "medium" : "long";

  // Preserve the original width logic, but express it in canvas-relative units.
  const mass = clamp(0.4 * intensity + 0.35 * confidence + 0.25 * (1 - entropy), 0, 1);
  const width_ratio = 1 / 1600 + Math.pow(mass, 6.2) * (DISPLAY_WIDTH_MAX_RATIO - 1 / 1600);

  // Entropy alone controls topological self-contact, keeping the mapping easy
  // to explain. Dense crossings need room to unfold, so only a long gesture is
  // allowed into the 5–8 tier; short and medium marks always stop at four.
  let crossings = 0;
  if (entropy >= 0.38 && entropy <= 0.72) {
    crossings = Math.round(((entropy - 0.38) / 0.34) * 4);
  } else if (entropy > 0.72) {
    const highTier = 5 + Math.round(((entropy - 0.72) / 0.28) * 3);
    crossings = length > 6 ? clamp(highTier, 5, 8) : 4;
  }

  // Generated paths occupy a comparatively narrow intensity band. These
  // calibrated quartiles keep all tools legible while remaining a deterministic
  // reading of path intensity (never a random style choice).
  const brush_style = intensity < 0.7 ? "hard" : intensity < 0.76 ? "soft" : intensity < 0.83 ? "watercolor" : "texture";
  const styleHead = {
    hard: "square", soft: "round", watercolor: "ring", texture: "organic",
  } as const;
  const geometryHead = {
    linear: "square", curved: "round", spiral: "ring", recursive: "diamond",
    oscillatory: "organic", fragmented: "triangle",
  } as const;
  const motionHead = {
    continuous: "round", segmented: "square", jitter: "organic", wave: "ring", burst: "triangle",
  } as const;
  const brush_heads = [styleHead[brush_style]] as StrokeVisualSignature["brush_heads"];
  if (branchTotal > 0) brush_heads.push(geometryHead[geometryMode ?? "curved"]);
  if (entropy > 0.68) brush_heads.push(motionHead[motionModel ?? "continuous"]);

  // Motion determines palette size, but spatial capacity is a hard gate: only
  // a long stroke can carry multiple pigments. Colors are random at creation
  // (seeded so the artwork remains stable across refreshes) and independent of
  // agent/category hue.
  const motion = clamp(mood.motion_variation, 0, 1);
  const color_count: 1 | 3 | 5 = length_class !== "long"
    ? 1
    : motion < 0.35 ? 1 : motion < 0.7 ? 3 : 5;
  let colorState = (seed || 1) >>> 0;
  const random01 = () => {
    colorState = (Math.imul(colorState, 1664525) + 1013904223) >>> 0;
    return colorState / 4294967296;
  };
  const color_hues = Array.from({ length: color_count }, () => Number((random01() * 360).toFixed(2)));

  const motionStability = motionStabilityFromDurations(points.map((point) => point.duration_ms));
  const { width_change_count, width_profile } = createWidthProfile(motionStability, seed);

  // Temperature remains explanatory metadata; actual pigment selection is the
  // seeded random palette requested by the protocol.
  const color_temperature = clamp((confidence + intensity - entropy - 0.5) * 1.15 + mood.color_variation * 0.25, -1, 1);
  const color_mode = color_count === 1 ? "monochrome" : color_count === 3 ? "duotone" : "spectrum";
  const hue_start = color_hues[0] ?? baseHue;
  const hue_end = color_hues[color_hues.length - 1] ?? hue_start;

  // Duration is inverted: long dwell = slow drawing. Group semantic points into
  // 3–6 readable phases instead of inventing an unrelated tempo curve.
  const phaseCount = clamp(Math.ceil(points.length / 2), 3, 6);
  const meanDuration = totalDuration / Math.max(1, points.length);
  const speed_profile = Array.from({ length: phaseCount }, (_, phase) => {
    const lo = Math.floor((phase / phaseCount) * points.length);
    const hi = Math.max(lo + 1, Math.floor(((phase + 1) / phaseCount) * points.length));
    const slice = points.slice(lo, hi);
    const dwell = slice.reduce((sum, p) => sum + p.duration_ms, 0) / Math.max(1, slice.length);
    return clamp(meanDuration / Math.max(1, dwell), 0.12, 2);
  });

  let angleSum = 0, angleCount = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = Math.atan2(points[i].y - points[i - 1].y, points[i].x - points[i - 1].x);
    const b = Math.atan2(points[i + 1].y - points[i].y, points[i + 1].x - points[i].x);
    let d = Math.abs(b - a);
    if (d > Math.PI) d = Math.PI * 2 - d;
    angleSum += d; angleCount++;
  }
  const measuredTurn = angleCount ? (angleSum / angleCount) * 180 / Math.PI : 0;
  const modeHardness = motionModel === "segmented" || motionModel === "burst" ? 0.35 : 0;
  const turn_sharpness = clamp((1 - entropy) * 0.45 + modeHardness + Math.abs(mood.curvature_bias) * 0.2, 0, 1);
  // The semantic path may contain many anchors, but the visible gesture uses a
  // modulo-four remainder so its main silhouette never exceeds four corners.
  const rawTurns = Math.max(0, points.length - 2);
  const turn_count = rawTurns === 0 ? 0 : ((rawTurns - 1) % 4) + 1;
  const direction_angle_deg = ((mood.drift_bias * 360) % 360 + 360) % 360;
  const requestedReversals = motion < 0.35 ? 0
    : motion < 0.58 ? 1
      : motion < 0.78 ? 2
        : motion < 0.92 ? 3 : 4;
  const reversalCapacity = length_class === "short" ? 1 : length_class === "medium" ? 2 : 4;
  const reversal_count = Math.min(requestedReversals, reversalCapacity);
  return {
    version: 1,
    length: Number(length.toFixed(3)),
    length_class,
    width_ratio: Number(width_ratio.toFixed(5)),
    crossings,
    motion_pattern: MOTION_PATTERN_BY_GEOMETRY[geometryMode ?? "linear"],
    motion_amplitude: Number(clamp(entropy * 0.62 + (1 - confidence) * 0.23 + Math.abs(mood.curvature_bias) * 0.15, 0, 1).toFixed(3)),
    motion_curvature: Number(clamp(mood.curvature_bias, -1, 1).toFixed(3)),
    motion_seed: seed >>> 0,
    brush_heads: brush_heads.slice(0, 3),
    brush_style,
    color_temperature: Number(color_temperature.toFixed(3)),
    color_mode,
    color_count,
    color_hues,
    hue_start: Number(hue_start.toFixed(2)),
    hue_end: Number(hue_end.toFixed(2)),
    speed_profile: speed_profile.map((v) => Number(v.toFixed(3))),
    turn_angle_deg: Number(clamp(measuredTurn + Math.abs(mood.curvature_bias) * 35, 0, 179).toFixed(1)),
    turn_count,
    turn_sharpness: Number(turn_sharpness.toFixed(3)),
    direction_angle_deg: Number(direction_angle_deg.toFixed(1)),
    reversal_count,
    width_change_count,
    width_profile,
  };
}

/** Back-compatible signature for strokes created before visual_signature. */
export function resolveVisualSignature(path: TransitionPath, baseHue = 210): StrokeVisualSignature {
  const neutralMood: Mood = path.mood ?? {
    timestamp: path.timestamp,
    entropy_shift: 0,
    drift_bias: 0,
    curvature_bias: 0,
    motion_variation: 0.5,
    color_variation: 0,
  };
  // Re-derive from source attributes so signatures created by earlier,
  // oversized curves are migrated immediately without rewriting stored data.
  return createVisualSignature({
    points: path.points,
    mood: neutralMood,
    baseHue,
    seed: path.variation_seed ?? path.base_seed ?? hashStr(path.id),
    geometryMode: path.geometry_mode,
    motionModel: path.motion_model,
  });
}

/** Keep the public path contract while preserving the selected motion family. */
export function buildVisualPath(points: TransitionPoint[], sig: StrokeVisualSignature, seed: number): XY[] {
  return buildMotionPath(points, sig, seed).points;
}

export function pathLength(points: XY[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

export function sampleProfile(profile: number[], t: number): number {
  if (!profile.length) return 1;
  if (profile.length === 1) return profile[0];
  const x = clamp(t, 0, 1) * (profile.length - 1);
  const i = Math.floor(x);
  return mix(profile[i], profile[Math.min(profile.length - 1, i + 1)], x - i);
}

/** Smooth pressure extrema without changing the independent speed profile. */
export function sampleWidthProfile(profile: number[], t: number): number {
  if (!profile.length) return 1;
  if (profile.length === 1) return profile[0];
  const x = clamp(t, 0, 1) * (profile.length - 1);
  const index = Math.floor(x);
  const local = x - index;
  const eased = local * local * (3 - 2 * local);
  return mix(profile[index], profile[Math.min(profile.length - 1, index + 1)], eased);
}
