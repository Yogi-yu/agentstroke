// ============================================================================
// Mood — CONTINUOUS temporal fingerprint of cognitive state.
// ----------------------------------------------------------------------------
// There is NO time-window bucketing. A mood is uniquely determined for EVERY
// timestamp from the full generation context:
//
//   seed = hash(agent_id + from + to + timestamp + stroke_seed)
//
// so for any t1 != t2 the seed differs and the mood differs — variation is
// continuous, never stepwise-constant. A slow sinusoidal drift on the real
// clock gives organic low-frequency evolution; a per-timestamp hashed component
// guarantees uniqueness. No Math.random — fully deterministic in the context.
// ============================================================================

import type { BranchingModel, GeometryMode, MotionModel, Mood } from "@/lib/types";
import { hashStr, makeRng } from "@/simulation/rng";

/**
 * The unique per-timestamp mood seed — hash of the FULL context including the
 * raw timestamp and the stable stroke_seed. Different timestamp (or agent / A /
 * B) → different seed.
 */
export function moodContextSeed(
  agentId: string,
  from: string,
  to: string,
  timestamp: number,
  strokeSeed: number,
): number {
  return hashStr(`${agentId}|${from}|${to}|${timestamp}|${strokeSeed}`) >>> 0;
}

/** Quantized, order-stable string form of a mood (for hashing into seeds). */
export function moodKey(mood: Mood): string {
  return [
    mood.entropy_shift,
    mood.drift_bias,
    mood.curvature_bias,
    mood.motion_variation,
    mood.color_variation,
  ]
    .map((v) => Math.round(v * 1e6))
    .join(",");
}

/**
 * TEMPORAL DIVERGENCE KEY:
 *   stroke_variation_seed = hash(agent_id + from + to + timestamp + mood)
 *
 * A single strongly-mixed seed driving ALL structural draws (start/end, geometry
 * mode, branching, motion, width variance). Because it folds in the raw
 * timestamp AND the per-timestamp-unique mood, every distinct timestamp gets a
 * distinct structural seed → continuous divergence, no two timestamps alike.
 */
export function strokeVariationSeed(
  agentId: string,
  from: string,
  to: string,
  timestamp: number,
  mood: Mood,
): number {
  return hashStr(`${agentId}|${from}|${to}|${timestamp}|${moodKey(mood)}`) >>> 0;
}

// ============================================================================
// STRUCTURAL MODE SELECTION — mood as a structural generative bias.
// ----------------------------------------------------------------------------
// Each selector maps a mood to ONE discrete structural mode via mood-weighted
// sampling: the mood fields bias which mode is likely, and the variation seed
// makes the actual draw. Because the seed folds in the full mood, a different
// mood reliably re-rolls EVERY axis — geometry, branching, motion, semantics
// all change together when the mood changes.
// ============================================================================

function weightedPick<T extends string>(seed: number, weights: [T, number][]): T {
  const rng = makeRng(seed);
  const total = weights.reduce((a, [, w]) => a + Math.max(0, w), 0) || 1;
  let r = rng() * total;
  for (const [k, w] of weights) {
    r -= Math.max(0, w);
    if (r <= 0) return k;
  }
  return weights[weights.length - 1][0];
}

/** GeometryMode selection — curvature/entropy/drift/motion bias the path shape. */
export function selectGeometryMode(mood: Mood, seed: number): GeometryMode {
  const e = Math.abs(mood.entropy_shift);
  const c = Math.abs(mood.curvature_bias);
  const d = Math.abs(mood.drift_bias);
  const m = mood.motion_variation;
  return weightedPick<GeometryMode>(seed ^ 0x6e0a, [
    ["linear", 1 + (1 - c) * 2 + (1 - e) * 1.5],
    ["curved", 0.5 + c * 3],
    ["spiral", 0.3 + c * 1.4 + d * 1.6],
    ["recursive", 0.3 + e * 3],
    ["oscillatory", 0.3 + m * 2.2 + c * 1],
    ["fragmented", 0.2 + e * 2 + d * 1.6],
  ]);
}

/** BranchingModel selection — motion/entropy/drift bias the branch topology. */
export function selectBranchingModel(mood: Mood, seed: number): BranchingModel {
  const e = Math.abs(mood.entropy_shift);
  const d = Math.abs(mood.drift_bias);
  const m = mood.motion_variation;
  return weightedPick<BranchingModel>(seed ^ 0x1b7a, [
    ["none", 1 + (1 - m) * 2 + (1 - e) * 1.5],
    ["binary", 0.6 + (1 - e) * 1 + m * 0.5],
    ["tree", 0.4 + m * 2.6],
    ["chaotic", 0.2 + e * 2.6 + m * 1.4],
    ["delayed", 0.5 + d * 1.6 + m * 0.6],
  ]);
}

/** MotionModel selection — entropy/curvature/motion bias the animation structure. */
export function selectMotionModel(mood: Mood, seed: number): MotionModel {
  const e = Math.abs(mood.entropy_shift);
  const c = Math.abs(mood.curvature_bias);
  const d = Math.abs(mood.drift_bias);
  const m = mood.motion_variation;
  return weightedPick<MotionModel>(seed ^ 0x4c0d, [
    ["continuous", 1 + (1 - e) * 2],
    ["segmented", 0.4 + d * 2.2],
    ["jitter", 0.3 + e * 3],
    ["wave", 0.4 + c * 2.2 + m * 1],
    ["burst", 0.3 + m * 2.6],
  ]);
}

/**
 * Semantic depth (number of intermediate anchors) the mood restructures to.
 * Detour-rich, low-abstraction moods → deeper paths; abstract/calm moods →
 * shorter, higher-altitude paths. Clamped to 4..13.
 */
export function selectSemanticDepth(mood: Mood, seed: number): number {
  const rng = makeRng(seed ^ 0x5e3a);
  const detour = mood.motion_variation * 0.6 + Math.abs(mood.entropy_shift) * 0.6; // 0..~1.2
  const abstraction = mood.color_variation; // -1..1 (abstract → fewer)
  const depth = 6 + detour * 7 - abstraction * 2 + (rng() - 0.5) * 2;
  return Math.max(4, Math.min(13, Math.round(depth)));
}

const signed = (u01: number) => u01 * 2 - 1; // [0,1) → [-1,1)
const clamp01v = (v: number) => Math.max(0, Math.min(1, v));
const clampSigned = (v: number) => Math.max(-1, Math.min(1, v));

/**
 * CONTINUOUS mood — uniquely determined for EVERY timestamp from the full
 * generation context. There is no time bucket: the seed folds in the raw
 * timestamp + stroke_seed, so t1 != t2 → mood(t1) != mood(t2).
 *
 *   mood = generateMood(timestamp, agent_id, from, to, stroke_seed)
 *
 * Each field blends a SLOW sinusoidal drift on the real clock (organic,
 * low-frequency evolution) with a per-timestamp HASHED component (guarantees
 * uniqueness + strong moment-to-moment variation). Fully deterministic.
 */
export function generateMood(
  timestamp: number,
  agentId: string,
  from: string,
  to: string,
  strokeSeed: number,
): Mood {
  const rng = makeRng(moodContextSeed(agentId, from, to, timestamp, strokeSeed));
  // slow drift on a real-seconds clock — period of hours, so it reads as organic
  const ts = timestamp / 1000;
  const wave = (f: number, p: number) => Math.sin(ts * f + p);
  // 55% hashed (unique per timestamp) + 45% smooth drift (organic continuity)
  const mix = (f: number, p: number) => clampSigned(0.45 * wave(f, p) + 0.55 * signed(rng()));
  return {
    timestamp,
    entropy_shift: mix(0.00071, 0.0),
    drift_bias: mix(0.00109, 1.7),
    curvature_bias: mix(0.00091, 3.1),
    motion_variation: clamp01v(0.45 * (0.5 + 0.5 * wave(0.00127, 5.4)) + 0.55 * rng()),
    color_variation: mix(0.00053, 2.2),
  };
}
