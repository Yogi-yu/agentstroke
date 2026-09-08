import type { GeometryMode, Mood, MotionModel, StrokeVisualSignature, TransitionPath, TransitionPoint } from "@/lib/types";
import { hashStr } from "@/simulation/rng";

export interface XY { x: number; y: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const DISPLAY_WIDTH_MAX_RATIO = 0.008;

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

  const durations = points.map((point) => point.duration_ms);
  const durationMean = totalDuration / Math.max(1, durations.length);
  const durationVariance = durations.length
    ? durations.reduce((sum, duration) => sum + (duration - durationMean) ** 2, 0) / durations.length
    : 0;
  const motionStability = durationMean > 0
    ? clamp(1 - Math.sqrt(durationVariance) / durationMean, 0, 1)
    : 1;
  let widthState = ((seed || 1) ^ 0x9e3779b9) >>> 0;
  const widthRandom = () => {
    widthState = (Math.imul(widthState, 1103515245) + 12345) >>> 0;
    return widthState / 4294967296;
  };
  // A genuinely steady hand is deliberately rare. Most generated paths sit in
  // the middle band and therefore receive a visible pressure rhythm; only the
  // bottom tail stays mechanically uniform.
  const width_change_count = motionStability < 0.18
    ? 0
    : motionStability < 0.68
      ? 1 + Math.floor(widthRandom() * 3)
      : 5 + Math.floor(widthRandom() * 4);
  let width_profile = [1, 1];
  if (width_change_count > 0) {
    const generated: number[] = [];
    for (let index = 0; index <= width_change_count; index++) {
      if (index === 0) {
        generated.push(0.52 + widthRandom() * 0.96);
        continue;
      }
      const previous = generated[index - 1];
      let next = 0.34 + widthRandom() * 1.32;
      // Do not count tiny numerical changes as a visual transition. Alternating
      // around the centre also permits thick -> thin -> thick sequences.
      if (Math.abs(next - previous) < 0.46) next = previous > 1 ? 0.38 + widthRandom() * 0.24 : 1.38 + widthRandom() * 0.24;
      generated.push(next);
    }
    width_profile = generated;
    const profileMean = width_profile.reduce((sum, value) => sum + value, 0) / width_profile.length;
    width_profile = width_profile.map((value) => Number(clamp(value / profileMean, 0.32, 1.72).toFixed(3)));
  }

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
  // modulo-five remainder so its main silhouette never exceeds four corners.
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

/**
 * Reduces the full semantic path to one readable gesture. Semantic depth still
 * controls the result, but its modulo-five remainder yields at most 4 turns.
 */
export function buildVisualPath(points: TransitionPoint[], sig: StrokeVisualSignature, seed: number): XY[] {
  const first = points[0] ?? { x: 0.5, y: 0.5 };
  if (sig.length <= 0.002) return [{ x: first.x, y: first.y }, { x: first.x, y: first.y }];
  const base = points.length > 1
    ? points.map((p) => ({ x: clamp(p.x, 0.015, 0.985), y: clamp(p.y, 0.015, 0.985) }))
    : [{ x: first.x, y: first.y }, { x: first.x + 0.001, y: first.y }];
  const visiblePointCount = Math.min(base.length, sig.turn_count + 2);
  const selected = visiblePointCount <= 2
    ? [base[0], base[base.length - 1]]
    : Array.from({ length: visiblePointCount }, (_, i) => {
    const index = Math.round((i / (visiblePointCount - 1)) * (base.length - 1));
    return base[index];
  });
  // 0.1 / 0.5 / 1 are category maxima, not three fixed lengths. The source
  // length attribute chooses a continuous value inside each category range.
  const scale = sig.length_class === "short"
    ? clamp(sig.length / 5, 0, 1) * 0.1
    : sig.length_class === "medium"
      ? mix(0.1, 0.5, clamp(sig.length - 5, 0, 1))
      : mix(0.5, 1, clamp((sig.length - 6) / 15, 0, 1));
  const center = selected.reduce((a, p) => ({ x: a.x + p.x / selected.length, y: a.y + p.y / selected.length }), { x: 0, y: 0 });
  const directionRadians = sig.direction_angle_deg * Math.PI / 180;
  const cosDirection = Math.cos(directionRadians);
  const sinDirection = Math.sin(directionRadians);
  const scaled = selected.map((p) => {
    const localX = (p.x - center.x) * scale;
    const localY = (p.y - center.y) * scale;
    return {
      x: clamp(center.x + localX * cosDirection - localY * sinDirection, 0.015, 0.985),
      y: clamp(center.y + localX * sinDirection + localY * cosDirection, 0.015, 0.985),
    };
  });

  // Motion-driven reversals are sampled semicircular hairpins on one ordered
  // centreline. A former three-anchor V turn made a broad nib stamp repeatedly
  // at one vertex, which visually resembled two branches growing from a node.
  // The explicit arc below has degree two everywhere: enter the bend, travel
  // around it, then leave along the next lane.
  if (sig.reversal_count > 0 && sig.crossings <= 0) {
    let span = 0;
    for (let a = 0; a < scaled.length; a++) {
      for (let b = a + 1; b < scaled.length; b++) {
        span = Math.max(span, Math.hypot(scaled[b].x - scaled[a].x, scaled[b].y - scaled[a].y));
      }
    }
    span = Math.max(span, 0.018 + scale * 0.08);
    const ux = Math.cos(directionRadians);
    const uy = Math.sin(directionRadians);
    const nx = -uy;
    const ny = ux;
    const laneDirection = ((seed >>> 0) & 1) === 0 ? 1 : -1;
    // Keep the bend wider than the rendered nib. This matters most for compact
    // watercolor marks: a sub-nib-radius U-turn collapses into a round blot and
    // makes its incoming/outgoing legs look like a fork.
    const laneGap = Math.min(0.065, Math.max(0.014, sig.width_ratio * 10, span * 0.14));
    const gesture: XY[] = [{
      x: clamp(center.x - ux * span * 0.5, 0.015, 0.985),
      y: clamp(center.y - uy * span * 0.5, 0.015, 0.985),
    }];
    for (let leg = 0; leg <= sig.reversal_count; leg++) {
      const side = leg % 2 === 0 ? 1 : -1;
      const reach = Math.max(0.24, 0.5 - leg * 0.065) * span * side;
      const lateral = leg * laneGap * laneDirection;
      gesture.push({
        x: clamp(center.x + ux * reach + nx * lateral, 0.015, 0.985),
        y: clamp(center.y + uy * reach + ny * lateral, 0.015, 0.985),
      });

      if (leg >= sig.reversal_count) continue;

      const radius = laneGap * 0.5;
      const nextLateral = (leg + 1) * laneGap * laneDirection;
      const arcCenterLateral = (lateral + nextLateral) * 0.5;
      const arcSamples = 7;
      for (let sample = 1; sample <= arcSamples; sample++) {
        const theta = -Math.PI * 0.5 + (sample / arcSamples) * Math.PI;
        // Bulge beyond the end of the current lane, then return to the same
        // longitudinal coordinate on the neighbouring lane.
        const arcAlong = reach + side * Math.cos(theta) * radius;
        const arcLateral = arcCenterLateral + Math.sin(theta) * radius * laneDirection;
        gesture.push({
          x: clamp(center.x + ux * arcAlong + nx * arcLateral, 0.015, 0.985),
          y: clamp(center.y + uy * arcAlong + ny * arcLateral, 0.015, 0.985),
        });
      }
    }
    return gesture;
  }
  if (sig.crossings <= 0) return scaled;

  // Build one uninterrupted, forward-moving woven gesture. The curve crosses
  // itself through prolate-cycloid back-swing; it never returns to a sequence
  // of fixed centres, so crossings read as part of one hand motion rather than
  // pasted figure-eight symbols.
  const originalStart = scaled[0];
  const originalEnd = scaled[scaled.length - 1];
  let start = originalStart;
  let end = originalEnd;
  let widest = 0;
  for (let a = 0; a < scaled.length; a++) {
    for (let b = a + 1; b < scaled.length; b++) {
      const distance = Math.hypot(scaled[b].x - scaled[a].x, scaled[b].y - scaled[a].y);
      if (distance > widest) {
        widest = distance;
        start = scaled[a];
        end = scaled[b];
      }
    }
  }
  // Preserve the source direction when choosing the widest axis.
  const forward = Math.hypot(originalStart.x - start.x, originalStart.y - start.y)
    + Math.hypot(originalEnd.x - end.x, originalEnd.y - end.y);
  const reverse = Math.hypot(originalStart.x - end.x, originalStart.y - end.y)
    + Math.hypot(originalEnd.x - start.x, originalEnd.y - start.y);
  if (reverse < forward) [start, end] = [end, start];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const rawSpan = Math.hypot(dx, dy);
  const span = Math.max(0.018, rawSpan);
  const ux = rawSpan > 0.00001 ? dx / rawSpan : 1;
  const uy = rawSpan > 0.00001 ? dy / rawSpan : 0;
  const nx = -uy;
  const ny = ux;
  const cellStep = span / Math.max(1, sig.crossings);
  const alongRadius = Math.min(cellStep * 0.42, 0.07 * scale + 0.006);
  const widthClearance = 0.009 + sig.width_ratio * 4.2;
  const normalRadius = Math.min(
    Math.max(widthClearance, span * (0.055 + (1 - sig.turn_sharpness) * 0.055)),
    0.1 * scale + 0.014,
  );
  const crossed: XY[] = [originalStart];
  if (Math.hypot(originalStart.x - start.x, originalStart.y - start.y) > 0.001) crossed.push(start);
  const weaveCycles = Math.max(sig.crossings, sig.reversal_count);
  const samples = 24 + weaveCycles * 10;
  const phase = ((seed >>> 0) % 997) / 997 * Math.PI * 2;
  for (let sample = 1; sample < samples; sample++) {
    const t = sample / samples;
    const theta = t * Math.PI * 2 * weaveCycles;
    const envelope = Math.pow(Math.sin(Math.PI * t), 0.58);
    const organic = 0.84 + 0.16 * Math.sin(theta * 0.47 + phase);
    const localAlong = t * span + Math.sin(theta) * alongRadius * envelope * organic;
    const slowDrift = Math.sin(Math.PI * t) * normalRadius * 0.18 * Math.sin(phase);
    const localNormal = Math.cos(theta + Math.sin(theta * 0.31 + phase) * 0.16)
      * normalRadius * envelope * organic + slowDrift;
    crossed.push({
      x: clamp(start.x + ux * localAlong + nx * localNormal, 0.015, 0.985),
      y: clamp(start.y + uy * localAlong + ny * localNormal, 0.015, 0.985),
    });
  }
  crossed.push(end);
  if (Math.hypot(originalEnd.x - end.x, originalEnd.y - end.y) > 0.001) crossed.push(originalEnd);
  return crossed;
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
