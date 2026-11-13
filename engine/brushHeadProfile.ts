import type { BrushHeadAxis, BrushHeadAxisKey, BrushHeadProfile, TransitionPath } from "@/lib/types";
import { motionStabilityFromDurations } from "@/engine/visualSignature";

const clamp01 = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const mean = (values: readonly number[]) => values.length ? values.reduce((average, value, index) => average + (value - average) / (index + 1), 0) : null;
const CORE_RADIUS = 0.16;

/** Keep the evolution of a source, not just the mean that makes all nibs alike. */
function describe(values: readonly number[]) {
  if (!values.length) return { mean: null, spread: 0, trend: 0 };
  const phase = Math.max(1, Math.ceil(values.length / 3));
  return {
    mean: mean(values),
    spread: Math.max(...values) - Math.min(...values),
    trend: mean(values.slice(-phase))! - mean(values.slice(0, phase))!,
  };
}

/** Bounded signed-square-root contrast: close signals remain visibly distinct. */
function contourRadius(signal: number): number {
  const centered = 2 * clamp01(signal) - 1;
  const contrasted = 0.5 + 0.5 * Math.sign(centered) * Math.sqrt(Math.abs(centered));
  return CORE_RADIUS + (1 - CORE_RADIUS) * contrasted;
}

/**
 * Read-only, attribute-derived nib. Source levels, range and early/late change
 * form eight signals. Contrast reveals differences that an average-only radar
 * loses; a small connected core prevents zero-radius islands. A final UNIFORM
 * fit is the same normalization used by the renderer, never a new width value.
 * Identity, randomness, pigment, pressure and playback do not enter this shape.
 */
export function resolveBrushHeadProfile(stroke: TransitionPath): BrushHeadProfile {
  const points = stroke.points ?? [];
  const values = (key: "intensity" | "confidence" | "entropy") => points.map(point => point[key]).filter(finite).map(clamp01);
  const intensity = describe(values("intensity"));
  const confidence = describe(values("confidence"));
  const entropy = describe(values("entropy"));
  const durations = points.map(point => point.duration_ms).filter(finite).map(value => Math.max(0, value));
  const dwell = durations.length ? durations.reduce((sum, value) => Math.min(Number.MAX_VALUE, sum + value), 0) : null;
  const maxDuration = durations.length ? Math.max(...durations) : 0;
  const pacing = describe(durations.map(value => maxDuration > 0 ? value / maxDuration : 0));
  const stability = durations.length ? motionStabilityFromDurations(durations) : null;
  const branches = points.map(point => point.branch).filter(finite).map(value => Math.max(0, value));
  const branching = describe(branches);
  const turns: number[] = [];
  for (let index = 1; index < points.length - 1; index++) {
    const a = points[index - 1], b = points[index], c = points[index + 1];
    if (![a.x, a.y, b.x, b.y, c.x, c.y].every(finite)) continue;
    const ax = b.x - a.x, ay = b.y - a.y, bx = c.x - b.x, by = c.y - b.y;
    if (Math.hypot(ax, ay) < 1e-10 || Math.hypot(bx, by) < 1e-10) continue;
    turns.push(Math.atan2(Math.abs(ax * by - ay * bx), ax * bx + ay * by) / Math.PI);
  }
  const curvature = describe(turns);
  const motion = finite(stroke.mood?.motion_variation) ? clamp01(stroke.mood!.motion_variation) : null;
  const specs: {
    key: BrushHeadAxisKey; label: string; raw: number | null; signal: number;
    spread?: number; trend?: number; source: string;
  }[] = [
    { key: "intensity", label: "Intensity", raw: intensity.mean,
      signal: (intensity.mean ?? 0) + 0.75 * intensity.trend - 0.35 * intensity.spread,
      spread: intensity.spread, trend: intensity.trend,
      source: "Mean intensity + 0.75 × late-minus-early change − 0.35 × range. Building activity extends this edge; isolated bursts pinch it." },
    { key: "confidence", label: "Confidence", raw: confidence.mean,
      signal: (confidence.mean ?? 0) + 0.9 * confidence.trend,
      spread: confidence.spread, trend: confidence.trend,
      source: "Mean confidence + 0.9 × late-minus-early change. Gaining confidence extends this edge; losing confidence draws it inward." },
    { key: "entropy", label: "Entropy", raw: entropy.mean,
      signal: (entropy.mean ?? 0) + 0.45 * entropy.spread - 0.5 * entropy.trend,
      spread: entropy.spread, trend: entropy.trend,
      source: "Mean entropy + 0.45 × range − 0.5 × late-minus-early change. A broad search that resolves uncertainty creates a more pronounced edge." },
    { key: "motion_variation", label: "Motion variation", raw: motion, signal: motion ?? 0,
      source: "Recorded mood.motion_variation on its original 0–1 scale. Greater variation extends this edge. Missing legacy values retain only the connected core." },
    { key: "stability", label: "Motion stability", raw: stability,
      signal: (stability ?? 0) - 0.65 * Math.abs(pacing.trend), spread: pacing.spread, trend: pacing.trend,
      source: "Timing uniformity (1 − standard deviation / mean dwell) − 0.65 × absolute late-minus-early pacing change. Pacing is divided by the longest dwell, so changing playback speed does not change the nib." },
    { key: "curvature", label: "Curvature", raw: curvature.mean ?? (points.length ? 0 : null),
      signal: (curvature.mean ?? 0) + 0.5 * curvature.spread, spread: curvature.spread, trend: curvature.trend,
      source: "Mean source-path turn / 180° + 0.5 × turning range. A mix of gentle and sharp turns extends this edge. Repeated anchors do not invent corners." },
    { key: "branching", label: "Branch density", raw: branching.mean,
      signal: branching.mean === null ? 0 : branching.mean / (1 + branching.mean) + 0.35 * branching.spread / (1 + branching.spread),
      spread: branching.spread, trend: branching.trend,
      source: "Mean branch count / (1 + mean) + 0.35 × range / (1 + range). This preserves differences above one branch. It shapes the nib, never adds branches to the drawn path." },
    { key: "duration", label: "Dwell time", raw: dwell,
      signal: dwell === null ? 0 : Math.log1p(dwell / 1000) / (Math.log1p(dwell / 1000) + 2),
      source: "Logarithmic total dwell: log(1 + milliseconds / 1,000) / [log(1 + milliseconds / 1,000) + 2]. Long paths stay distinct instead of all hitting a 6-second ceiling. This is recorded dwell, not playback speed." },
  ];
  const radii = specs.map(spec => points.length ? contourRadius(spec.raw === null ? 0 : spec.signal) : 0);
  const outer = Math.max(...radii, 1e-10);
  const axes: BrushHeadAxis[] = specs.map((spec, index) => ({
    key: spec.key, label: spec.label, rawValue: spec.raw,
    signalValue: spec.raw === null ? 0 : clamp01(spec.signal),
    value: radii[index] / outer,
    ...(spec.spread !== undefined ? { spread: spec.spread, trend: spec.trend } : {}),
    angleDegrees: index * 45, source: spec.source, available: spec.raw !== null,
  }));
  return {
    version: 2, previewOnly: false, hasData: points.length > 0, axes,
    vertices: axes.map(axis => {
      const angle = (axis.angleDegrees - 90) * Math.PI / 180;
      return { x: Math.cos(angle) * axis.value, y: Math.sin(angle) * axis.value };
    }),
  };
}
