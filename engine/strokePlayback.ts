import type { TransitionPath } from "@/lib/types";
import { resolveVisualSignature } from "./visualSignature";

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export interface StrokePlaybackTiming {
  durationMs: number;
  phaseSpeeds: number[];
  /** Fraction of the total time spent in each equal-distance phase. */
  phaseDurations: number[];
}

/** One clock for creation, the star field and detail replay. No wall-clock seed. */
export function getStrokePlayback(path: TransitionPath): StrokePlaybackTiming {
  const signature = resolveVisualSignature(path);
  const dwell = path.points.reduce((sum, point) => sum + Math.max(0, point.duration_ms), 0);
  const intensity = path.points.length
    ? path.points.reduce((sum, point) => sum + point.intensity, 0) / path.points.length
    : 0.5;
  // Longer semantic dwell takes longer to reveal; higher activation draws
  // faster. Keep even very short gestures slow enough to inspect at 1×.
  const durationMs = Math.round(clamp((1600 + dwell * 1.25) / (0.65 + intensity * 0.7), 2200, 14000));
  const phaseSpeeds = signature.speed_profile.map((speed) => clamp(speed, 0.12, 2));
  if (!phaseSpeeds.length) phaseSpeeds.push(1);
  const times = phaseSpeeds.map((speed) => 1 / speed);
  const total = times.reduce((sum, time) => sum + time, 0);
  return { durationMs, phaseSpeeds, phaseDurations: times.map((time) => time / total) };
}

/** Convert elapsed TIME fraction to travelled DISTANCE fraction, without jumps. */
export function strokeDistanceAtTime(progress: number, timing: StrokePlaybackTiming): number {
  const time = clamp(progress, 0, 1);
  if (time === 0 || time === 1) return time;
  let start = 0;
  for (let phase = 0; phase < timing.phaseDurations.length; phase++) {
    const duration = timing.phaseDurations[phase];
    if (time <= start + duration) {
      return (phase + (time - start) / duration) / timing.phaseDurations.length;
    }
    start += duration;
  }
  return 1;
}
