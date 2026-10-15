"use client";

// ============================================================================
// Stroke Detail — a PARAMETERIZED COGNITIVE EVENT WITH INTERPRETABLE CAUSALITY.
// ----------------------------------------------------------------------------
// A stroke is not a visual artifact; it is a readable cognitive object. This
// page surfaces its core generative determinants (entropy / confidence /
// duration / …), lets each be inspected, then explains WHY the stroke looks the
// way it does as an explicit Input → Transformation → Output causal chain.
//
// Reads from the SERVER store via GET /api/strokes/:id (single source of truth).
//
// Layout: 1 header · 2 core attributes · 3 expandable inspector (inline) ·
//         4 mood + structural mode · 5 semantic anchors · 6 causal layer · 7 raw JSON
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import StrokePlayerPanel from "@/components/StrokePlayerPanel";
import type { AgentProfile, BrushStrokeStyle, StrokeMotionPattern, TransitionPath } from "@/lib/types";
import { agentRenderStyle, categoryLabel } from "@/lib/agents";
import { motionStabilityFromDurations, pathLength, resolveVisualSignature, WIDTH_STABILITY_CONSTANT_THRESHOLD, WIDTH_STABILITY_FREQUENT_THRESHOLD } from "@/engine/visualSignature";
import { buildMotionPath } from "@/engine/motionPattern";
import { getStrokePlayback } from "@/engine/strokePlayback";
import { hashStr } from "@/simulation/rng";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const fmtSigned = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2);
const fmtTime = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

const MOTION_LABELS: Record<StrokeMotionPattern, string> = {
  glide: "Direct glide", arc: "Arc sweep", wave: "Wave", fold: "Folded flight", orbit: "Expanding orbit", wander: "Wandering flight",
};
const MOTION_EFFECTS: Record<StrokeMotionPattern, string> = {
  glide: "A nearly straight flight with a slight amplitude-led crosswind. It intentionally leaves return and crossing budgets unused.",
  arc: "One broad circular sweep. Curvature chooses its side and span; the return budget can widen the sweep without inserting separate loops.",
  wave: "One to four broad lateral lobes, using the larger of the turn and return budgets. Amplitude sets their height while forward travel stays monotonic.",
  fold: "Alternating connected legs with at most four principal corners. A nonzero crossing budget permits natural overlaps of these legs, not attached loop symbols.",
  orbit: "One continuously expanding spiral. The return budget and amplitude increase its angular travel; curvature chooses its winding direction. It does not paste closed rings onto a line.",
  wander: "A few unequal, seeded legs. Amplitude and the return budget widen their heading changes; candidates exceeding the crossing budget are restrained. The route never splits.",
};
const MATERIAL_EFFECTS: Record<BrushStrokeStyle, string> = {
  hard: "A clean 35° chisel face with a crisp highlight and dark cut edge; width changes with travel direction.",
  soft: "A pressure-shaped ink belly, compressed dark edge and three connected internal ink channels, ending in a lifted point.",
  watercolor: "A broad wet belly with uneven continuous wet rims and seeded pigment-sediment bands inside the same stroke.",
  texture: "Five clipped, high-contrast longitudinal dry-brush grooves, with seeded changes in groove width and pigment deposition—not scattered particles.",
};

// ---- Layer 3: per-attribute inspector docs --------------------------------
interface AttrDoc {
  definition: string;
  geometry: string;
  motion: string;
  ranges: string;
  highLow: string;
}
const ATTR_DOCS: Record<string, AttrDoc> = {
  curvature_bias: {
    definition: "Signed mood curvature. Its sign chooses the bend side or winding direction; this is separate from measured source curvature.",
    geometry: "Magnitude widens an arc and contributes 15% of motion amplitude. The sign selects the local bend/winding side. Near-zero values use the stable creation seed where a side is needed.",
    motion: "Drift rotates the complete gesture separately; curvature acts within that orientation and does not alter duration.",
    ranges: "−1 to +1. Opposite signs change local bend/winding direction; screen orientation also depends on drift rotation.",
    highLow: "Large magnitude → stronger curvature contribution. Near zero → a restrained bias with deterministic variation.",
  },
  motion_amplitude: {
    definition: "A 0–1 lateral-exploration signal derived from existing attributes rather than an unrelated random magnitude.",
    geometry: "amplitude = clamp(0.62 × entropy + 0.23 × (1 − confidence) + 0.15 × |curvature bias|). It changes crosswind, wave height, folded-lane spread, orbit travel or wandering heading range.",
    motion: "Controls spatial movement, not playback rate. The arc family instead uses signed curvature and its return budget directly.",
    ranges: "0–1, interpreted within the selected family.",
    highLow: "High → broader lateral exploration. Low → restrained movement. Length remains an independent travel-distance constraint.",
  },
  motion_pattern: {
    definition: "The complete one-stroke movement family selected by geometry_mode. Crossing settings cannot override it.",
    geometry: "linear → direct glide; curved → arc sweep; oscillatory → wave; recursive → folded flight; spiral → expanding orbit; fragmented → wandering flight. Each is one ordered, unbranched centerline.",
    motion: "Amplitude, signed curvature and turn/return budgets vary the chosen family. The shared timeline reveals that route continuously.",
    ranges: "Six categorical families, not opacity settings or copies of one looping template.",
    highLow: "No high/low ranking: a glide may leave its crossing budget unused; a fold may overlap earlier legs; an orbit expands around one center.",
  },
  entropy: {
    definition: "Average uncertainty in the semantic path; affects spatial exploration and material texture, not whether the stroke is continuous.",
    geometry: "Entropy supplies 62% of motion amplitude and sets a self-crossing ceiling. It broadens the selected family's bends without replacing that family with a generic weave.",
    motion: "Local entropy also increases material dryness and edge irregularity. Dwell times independently set the head's phase-speed weights.",
    ranges: "0–1. Crossing ceiling: <0.38 → 0; 0.38–0.72 → 0–4; >0.72 → 5–8 only when long, otherwise capped at 4.",
    highLow: "High → greater lateral exploration and more permitted intersections. Low → quieter movement. A high ceiling does not require any actual crossings.",
  },
  confidence: {
    definition: "Certainty recorded at each semantic step; its average helps determine source width and movement amplitude.",
    geometry: "Higher confidence reduces lateral amplitude through the (1 − confidence) term, while increasing the source-width signal. It also consolidates material edges and reduces dryness.",
    motion: "Confidence shapes the route and pigment coherence, not animation speed. Dwell and intensity determine duration.",
    ranges: "0–1. Motion amplitude includes 0.23 × (1 − average confidence).",
    highLow: "High → restrained lateral movement and coherent edges. Low → more exploration and dry texture. Material width limits still apply.",
  },
  duration: {
    definition: "The sum of recorded dwell times across the source path; this is input data, not the animation's elapsed time.",
    geometry: "Total dwell combines with anchor count and intensity to derive the source length value and its short, medium or long category.",
    motion: "Contributes to the meteor's drawing duration together with path intensity. See drawing duration for the actual playback time.",
    ranges: "Shown in milliseconds as the exact sum of the source points' duration_ms values. The separate drawing-duration attribute reports playback seconds.",
    highLow: "More dwell generally raises the derived length value and slows the reveal, subject to each calculation's limits. It does not add source anchors.",
  },
  points: {
    definition: "Number of sampled semantic anchors along the A→B transition.",
    geometry: "Anchor count contributes to derived length. Principal turns use a remainder rule capped at four, so more anchors do not necessarily mean more visible corners.",
    motion: "Anchors are grouped into 3–6 equal-distance speed phases. Their dwell times set relative phase speeds; the animation uses a dense sampled centerline rather than revealing one point per frame.",
    ranges: "Typically 4 – 12 anchors.",
    highLow: "High → more recorded semantic samples. Low → fewer samples. Visible shape and timing follow the derived attributes rather than the point count alone.",
  },
  intensity: {
    definition: "Activation magnitude along the path; selects the physical material and contributes to drawing duration.",
    geometry: "Hard <0.70: clean chisel face. Soft 0.70–0.76: ink belly and compressed edge. Watercolor 0.76–0.83: wet rims and pigment sediment. Texture ≥0.83: five high-contrast dry-brush grooves.",
    motion: "Material changes actual contour, leading edge and internal pigment, not only opacity. Local intensity changes pigment loading; higher average intensity shortens duration for the same dwell.",
    ranges: "0–1. Physical-material thresholds: 0.70, 0.76 and 0.83.",
    highLow: "Crossing a threshold changes the material. Within each material, pressure, entropy, confidence and seeded structure create further variation.",
  },
  curvature: {
    definition: "Measured average turning between consecutive source segments; distinct from the signed curvature-bias attribute.",
    geometry: "This contributes to the source turn-angle descriptor. The visible route now comes from its six-family motion pattern, not a direct tracing of all source corners.",
    motion: "It does not create extra orbits or set speed. Curvature bias controls bend direction/span, while sharpness rounds local joins.",
    ranges: "0 = straight source path; 1 = near-reversing source path.",
    highLow: "High → larger recorded angle descriptor. Low → smaller descriptor. This is not a literal count of visible bends.",
  },
  branching: {
    definition: "Recorded branching density in the original cognitive path.",
    geometry: "This is retained as provenance metadata. The meteor presentation uses one continuous centerline and does not add branch spurs or separate nib shapes.",
    motion: "The same moving head traverses the full route without splitting into secondary strokes.",
    ranges: "0.0 (none) – 1.0+ (dense fan).",
    highLow: "High and low describe the source path's branching metadata; neither introduces visible branches in the meteor renderer.",
  },
  stability: {
    definition: "Pacing uniformity: clamp(1 − standard deviation / mean dwell, 0, 1). This recorded signal selects how frequently the nib presses and lifts.",
    geometry: "Only the lowest 0.02 band remains constant. Middle values produce 1–3 broad press/lift transitions; values at or above 0.45 produce 5–8. Each transition moves between a fine valley and a visibly broad peak.",
    motion: "Pressure changes the width on the same continuous centerline. Smoothstep easing rounds every peak and valley without changing the route, adding branches or changing playback timing.",
    ranges: `<${WIDTH_STABILITY_CONSTANT_THRESHOLD.toFixed(2)} = constant; ${WIDTH_STABILITY_CONSTANT_THRESHOLD.toFixed(2)}–<${WIDTH_STABILITY_FREQUENT_THRESHOLD.toFixed(2)} = 1–3 changes; ≥${WIDTH_STABILITY_FREQUENT_THRESHOLD.toFixed(2)} = 5–8 changes.`,
    highLow: "High → frequent, pronounced press/lift rhythm. Middle → fewer but equally strong changes. Only extremely low stability holds pressure constant; the material can still taper its own outline.",
  },
  motion_variation: {
    definition: "A 0–1 mood value used to derive a return budget and, for long strokes, the palette-size tier.",
    geometry: "The family interprets this budget as wider arc sweep, wave lobes, folded legs, orbit travel or wandering heading range. A glide can leave it unused; no universal hairpin is inserted.",
    motion: "Changes spatial behavior, not the playback clock. Dwell and intensity set duration; phase weights distribute time.",
    ranges: "Return budget: <0.35 = 0; 0.35–0.58 = 1; 0.58–0.78 = 2; 0.78–0.92 = 3; ≥0.92 = 4. Short/medium capacities are 1/2. Long palettes use 1/3/5 pigments.",
    highLow: "High → more permitted angular travel or folding within the family. Low → restrained travel. The budget is not an exact count of identical U-turns.",
  },
  line_length: {
    definition: "A derived source length value, not the literal pixel length of the displayed path.",
    geometry: "The value chooses a continuous target distance within short, medium or long. The complete family is uniformly scaled and shifted to fit; individual points are never clamped into a border pile.",
    motion: "The head travels the resulting centerline. Duration is independent, so a longer distance need not take proportionally more time.",
    ranges: "Source <5: short, up to 0.112 normalized square-canvas units; 5–6: medium, 0.112–0.56; >6: long, 0.56–1.12. Fitting may reduce the target. Minimum is a point.",
    highLow: "High → a greater travel-distance allowance. Low → a compact gesture. Source length, generated distance and camera zoom are distinct quantities.",
  },
  line_width: {
    definition: "The source stroke width as a proportion of the square canvas side, interpreted through the selected brush material.",
    geometry: "Source width, the seeded pressure profile and nib geometry jointly set the swept ribbon's width. Hard nibs also respond to travel direction; soft nibs add a press-and-lift envelope.",
    motion: "The head is the front edge of this same ribbon. Pressure changes its size and the mark left behind it without spawning separate shapes.",
    ranges: "Material-response ranges in CSS pixels: hard 0.60–6.40, soft 0.35–12, watercolor 0.65–12, texture 0.55–11.80. A fine connected base is preserved; short pressure phases receive a tighter peak cap to avoid beads. The leading tip and tail can taper narrower.",
    highLow: "High source width or pressure → a wider nib and stronger body. Low → finer travel. Material-specific limits keep all strokes readable together.",
  },
  width_variation: {
    definition: "A seeded pressure envelope that makes this individual stroke visibly thicken and thin along its travel.",
    geometry: "Extrema alternate between 0.15–0.30× valleys and 1.85–2.20× peaks. They are not normalized back toward an average of one, so the strong contrast survives. Material response translates pressure into physical width, capped at 12 CSS pixels.",
    motion: "Smoothstep interpolation makes every press/lift transition continuous, with a smooth change of slope at extrema. The profile stays attached to path distance during play, pause, replay and seeking.",
    ranges: `<${WIDTH_STABILITY_CONSTANT_THRESHOLD.toFixed(2)} stability: constant; ${WIDTH_STABILITY_CONSTANT_THRESHOLD.toFixed(2)}–<${WIDTH_STABILITY_FREQUENT_THRESHOLD.toFixed(2)}: 1–3 transitions; ≥${WIDTH_STABILITY_FREQUENT_THRESHOLD.toFixed(2)}: 5–8. Pressure spans 0.15×–2.20×; physical width also depends on material.`,
    highLow: "Peaks produce a strong body; valleys retain a fine connected strand. More transitions repeat that contrast more often. The seed fixes the same profile on every replay.",
  },
  crossings: {
    definition: "The maximum permitted self-crossings, together with the actual count on this generated centerline.",
    geometry: "Folds and wandering paths can naturally revisit earlier legs. Glides, arcs, waves and expanding orbits need not consume the budget. Excess-crossing candidates are restrained rather than adding figure-eight modules.",
    motion: "One head revisits a coordinate at a later time. Actual means centerline intersections before bounded corner rounding, not branches or multiple brush strokes.",
    ranges: "Entropy <0.38 → ceiling 0; 0.38–0.72 → ceiling 0–4; >0.72 → ceiling 5–8 only when long, otherwise at most 4. Actual is always ≤ ceiling.",
    highLow: "High → overlaps are permitted, not required. Zero → no self-crossings. The selected motion family is preserved.",
  },
  brush_head: {
    definition: "The physical material of the moving nib. The head is the front of its ribbon, not a detached dot overlay.",
    geometry: "Hard: clean 35° chisel face and cut edge. Soft: ink belly, compressed edge and three internal ink channels. Watercolor: wet rims and pigment sediment. Texture: five high-contrast dry-brush grooves clipped within the silhouette.",
    motion: "Hard/texture ends are oblique; soft lifts to a point; watercolor has a wet leading contour. Entropy, confidence, intensity and pressure vary continuous internal deposition as the same head travels.",
    ranges: "Intensity <0.70: hard; 0.70–0.76: soft; 0.76–0.83: watercolor; ≥0.83: texture. Primitive-head metadata is provenance, not separate stamps.",
    highLow: "Materials differ in contour, pressure response, pigment and groove structure—not simply opacity. A genuine zero-length gesture remains a compact point.",
  },
  color_system: {
    definition: "A seeded random palette distributed continuously and evenly over the travelled length of the stroke.",
    geometry: "Color changes pigment only; it never splits or duplicates the one-stroke centerline.",
    motion: "The gradient remains attached to travelled distance as the meteor reveals the route.",
    ranges: "Long stroke + motion <0.35 = 1 color; 0.35–<0.70 = 3; ≥0.70 = 5. Non-long strokes are locked to 1.",
    highLow: "High motion on a long stroke → five random color stops. Otherwise → one random color.",
  },
  draw_speed: {
    definition: "The meteor's travel rhythm, derived from the dwell times recorded along its semantic path.",
    geometry: "Speed leaves the path coordinates unchanged, keeping form and time independently controllable.",
    motion: "The moving head follows equal-distance phases at different speeds. Slower phases occupy more of the timeline; faster phases take less time.",
    ranges: "Relative phase-speed weights range from 0.12 to 2.00; they compare phases within this stroke, not against an absolute canvas speed. The playback rate control scales the whole animation.",
    highLow: "High local speed → a quick sweep. Low local speed → a lingering reveal. Greater phase contrast creates a more varied journey.",
  },
  drawing_duration: {
    definition: "The time this meteor takes to reveal its complete trajectory at 1× playback.",
    geometry: "Duration changes when each part of the trajectory appears; it does not stretch or reshape the artwork.",
    motion: "Total recorded dwell time and average path intensity determine the overall duration. The phase speed profile then distributes that time along the route.",
    ranges: "2.2–14 seconds at 1×. Replay, pause and seek all use this same timeline.",
    highLow: "More dwell generally gives a longer reveal; higher intensity generally makes it faster. The animation stays within a readable duration range.",
  },
  turn_system: {
    definition: "The principal-turn budget, source turn-angle descriptor and local corner sharpness; not a count of every sampled curve segment.",
    geometry: "Turn and return budgets jointly set fold corners and wave lobes; the turn budget sets wander corners. Each stays within four principal changes. A glide or arc need not use every turn. Bounded joins round corners without overshooting or branching.",
    motion: "One head follows the complete family. Return budget and curvature govern broader angular travel; timing is independent.",
    ranges: "Source turns use a modulo-four remainder: 1–4, or 0 for at most two anchors. Source angle 0°–179°; sharpness 0–1.",
    highLow: "Larger budget → more permitted principal changes. Higher sharpness → tighter local joins; lower sharpness → broader rounding.",
  },
  direction_system: {
    definition: "Overall orientation from drift bias, plus the motion-family return budget.",
    geometry: "Drift bias rotates the complete centerline through 360°. The family interprets its return budget rather than being replaced by a standard hairpin sequence.",
    motion: "Direct, sweeping, wavy, folded, orbiting and wandering travel remain distinct after rotation.",
    ranges: "Orientation 0°–360°. Return budget 0–4, capped at 1 for short and 2 for medium strokes.",
    highLow: "Drift changes the global heading. A higher return budget can extend angular travel, but is not an exact U-turn count.",
  },
};

interface CoreAttr {
  key: string;
  label: string;
  display: string; // formatted value
  bar01: number; // 0..1 fill
}

export default function StrokeDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [stroke, setStroke] = useState<TransitionPath | null>(null);
  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing">("loading");
  const [openAttr, setOpenAttr] = useState<string | null>(null);

  // Single source of truth: the SERVER store.
  useEffect(() => {
    let alive = true;
    setStatus("loading");
    setStroke(null);
    setAgent(null);
    setOpenAttr(null);
    (async () => {
      try {
        const r = await fetch(`/api/strokes/${encodeURIComponent(id)}`, { cache: "no-store" });
        if (!alive) return;
        if (!r.ok) { setStatus("missing"); return; }
        const d = await r.json();
        if (!alive) return;
        setStroke(d.stroke ?? null);
        setAgent(d.agent ?? null);
        setStatus(d.stroke ? "ready" : "missing");
      } catch {
        if (alive) setStatus("missing");
      }
    })();
    return () => { alive = false; };
  }, [id]);

  const signature = useMemo(
    () => stroke ? resolveVisualSignature(stroke, agentRenderStyle(agent?.category ?? "coding").hue) : null,
    [stroke, agent],
  );
  const timing = useMemo(() => stroke ? getStrokePlayback(stroke) : null, [stroke]);
  const motion = useMemo(() => stroke && signature
    ? buildMotionPath(stroke.points, signature, stroke.variation_seed ?? stroke.base_seed ?? hashStr(stroke.id))
    : null, [stroke, signature]);
  const travelledDistance = useMemo(() => motion ? pathLength(motion.points) : 0, [motion]);

  // ---- aggregate the core generative attributes from the point cloud -------
  const m = useMemo(() => {
    const pts = stroke?.points ?? [];
    const n = pts.length;
    const avg = (f: (p: (typeof pts)[number]) => number) => (n ? pts.reduce((a, p) => a + f(p), 0) / n : 0);
    const entropy = avg((p) => p.entropy);
    const confidence = avg((p) => p.confidence);
    const intensity = avg((p) => p.intensity);
    const duration = pts.reduce((a, p) => a + p.duration_ms, 0);
    const branchTotal = pts.reduce((a, p) => a + p.branch, 0);
    const branching = n ? branchTotal / n : 0;

    let curvature = 0;
    if (n >= 3) {
      let sum = 0, c = 0;
      for (let i = 1; i < n - 1; i++) {
        const a1 = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
        const a2 = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
        let d = Math.abs(a2 - a1);
        if (d > Math.PI) d = 2 * Math.PI - d;
        sum += d; c++;
      }
      curvature = c ? sum / c / Math.PI : 0;
    }

    const stability = motionStabilityFromDurations(pts.map((point) => point.duration_ms));
    const motionVariation = stroke?.mood?.motion_variation ?? 0.5;
    return { n, entropy, confidence, intensity, duration, branching, curvature, stability, motionVariation };
  }, [stroke]);

  const attrs: CoreAttr[] = useMemo(() => [
    { key: "entropy", label: "entropy", display: m.entropy.toFixed(2), bar01: m.entropy },
    { key: "confidence", label: "confidence", display: m.confidence.toFixed(2), bar01: m.confidence },
    { key: "duration", label: "duration", display: `${m.duration}ms`, bar01: clamp01(m.duration / 6000) },
    { key: "points", label: "points", display: `${m.n}`, bar01: clamp01(m.n / 12) },
    { key: "intensity", label: "path intensity", display: m.intensity.toFixed(2), bar01: m.intensity },
    { key: "curvature", label: "curvature intensity", display: m.curvature.toFixed(2), bar01: m.curvature },
    { key: "branching", label: "branching density", display: m.branching.toFixed(2), bar01: clamp01(m.branching) },
    { key: "stability", label: "motion stability", display: m.stability.toFixed(2), bar01: m.stability },
    { key: "motion_variation", label: "motion variation", display: m.motionVariation.toFixed(2), bar01: m.motionVariation },
    ...(timing ? [{ key: "drawing_duration", label: "drawing duration", display: `${fmtTime(timing.durationMs)} at 1×`, bar01: clamp01(timing.durationMs / 14000) }] : []),
    ...(signature ? [
      { key: "motion_pattern", label: "motion pattern", display: MOTION_LABELS[motion?.pattern ?? "glide"], bar01: 1 },
      { key: "motion_amplitude", label: "motion amplitude", display: (signature.motion_amplitude ?? 0).toFixed(2), bar01: signature.motion_amplitude ?? 0 },
      { key: "curvature_bias", label: "curvature bias", display: fmtSigned(signature.motion_curvature ?? 0), bar01: Math.abs(signature.motion_curvature ?? 0) },
      { key: "line_length", label: "line length", display: signature.length <= 0.002 ? "point" : `${signature.length_class} · ${signature.length.toFixed(2)}`, bar01: clamp01(signature.length / 21) },
      { key: "line_width", label: "line width", display: `${(signature.width_ratio * 100).toFixed(2)}%`, bar01: clamp01(signature.width_ratio / 0.008) },
      { key: "width_variation", label: "width variation", display: `${signature.width_change_count} change${signature.width_change_count === 1 ? "" : "s"}`, bar01: signature.width_change_count / 8 },
      { key: "crossings", label: "crossings", display: `${motion?.crossingsUsed ?? 0} actual · ${motion?.crossingBudget ?? signature.crossings} max`, bar01: (motion?.crossingsUsed ?? 0) / 8 },
      { key: "brush_head", label: "brush material", display: signature.brush_style, bar01: signature.brush_style === "hard" ? 0.2 : signature.brush_style === "soft" ? 0.45 : signature.brush_style === "watercolor" ? 0.72 : 1 },
      { key: "color_system", label: "color", display: `${signature.color_count} color${signature.color_count > 1 ? "s" : ""} · ${signature.length_class}`, bar01: signature.color_count / 5 },
      { key: "draw_speed", label: "phase speed", display: `${signature.speed_profile.length} phases`, bar01: clamp01((Math.max(...signature.speed_profile) - Math.min(...signature.speed_profile)) / 1.88) },
      { key: "turn_system", label: "turn budget", display: `${signature.turn_count} · ${signature.turn_angle_deg.toFixed(0)}° source`, bar01: signature.turn_count / 4 },
      { key: "direction_system", label: "direction / return", display: `${signature.direction_angle_deg.toFixed(0)}° · budget ${motion?.reversalBudget ?? signature.reversal_count}`, bar01: signature.reversal_count / 4 },
    ] : []),
  ], [m, signature, timing, motion]);

  const attributeState = useMemo<Record<string, string>>(() => {
    if (!signature) return {} as Record<string, string>;
    const hueList = signature.color_hues.map((hue) => `${Math.round(hue)}°`).join(" → ");
    const speedRange = `${Math.min(...signature.speed_profile).toFixed(2)}–${Math.max(...signature.speed_profile).toFixed(2)}`;
    const pattern = motion?.pattern ?? "glide";
    const family = MOTION_LABELS[pattern];
    const actualCrossings = motion?.crossingsUsed ?? 0;
    const crossingBudget = motion?.crossingBudget ?? signature.crossings;
    return {
      entropy: `Average entropy ${m.entropy.toFixed(2)} contributes ${(m.entropy * 0.62).toFixed(3)} to motion amplitude and permits at most ${crossingBudget} crossings after the ${signature.length_class} length gate. This ${family.toLowerCase()} actually uses ${actualCrossings}; the ceiling does not force loops.`,
      confidence: `Average confidence ${m.confidence.toFixed(2)} contributes ${((1 - m.confidence) * 0.23).toFixed(3)} to movement amplitude. It also helps derive ${(signature.width_ratio * 100).toFixed(2)}% source width and the material's edge coherence; ${signature.color_temperature >= 0 ? "warm" : "cold"} temperature remains source metadata, not the seeded palette.`,
      duration: `${m.duration}ms of recorded dwell contributes to a ${signature.length.toFixed(2)} source length value (${signature.length_class}). With intensity included, actual playback takes ${timing ? fmtTime(timing.durationMs) : "the derived duration"} at 1×.`,
      points: `${m.n} source anchors yield a ${signature.turn_count}-turn budget under the remainder rule and ${signature.speed_profile.length} speed phases. ${family} interprets the budget according to its own geometry; these are semantic anchors, not animation frames.`,
      intensity: `Average intensity ${m.intensity.toFixed(2)} selects ${signature.brush_style}: ${MATERIAL_EFFECTS[signature.brush_style]} It also contributes to the ${timing ? fmtTime(timing.durationMs) : "recorded"} reveal duration.`,
      curvature: `Measured source curvature ${m.curvature.toFixed(2)} contributes to the ${signature.turn_angle_deg.toFixed(0)}° turn-angle descriptor. The separately derived sharpness ${signature.turn_sharpness.toFixed(2)} controls the meteor's bounded corner rounding.`,
      branching: `The source records branching density ${m.branching.toFixed(2)} and ${signature.brush_heads.join(" + ")} nib metadata. These remain inspectable, while the displayed meteor follows one continuous, unbranched centerline.`,
      stability: `Motion stability ${m.stability.toFixed(3)} falls in the ${m.stability < WIDTH_STABILITY_CONSTANT_THRESHOLD ? "extremely low / constant" : m.stability < WIDTH_STABILITY_FREQUENT_THRESHOLD ? "1–3 transition" : "5–8 transition"} band and selects ${signature.width_change_count} press/lift transition${signature.width_change_count === 1 ? "" : "s"}. ${signature.width_change_count ? "Each transition alternates a 0.15–0.30× valley with a 1.85–2.20× peak." : "Pressure is held at 1×."} Relative phase-speed weights remain ${speedRange}, independently of width.`,
      motion_pattern: `${stroke?.geometry_mode ?? "linear (legacy default)"} selects ${family}. ${MOTION_EFFECTS[pattern]} This realization has ${actualCrossings} centerline crossings under a ceiling of ${crossingBudget}.`,
      motion_amplitude: `${m.entropy.toFixed(2)} × 0.62 + (1 − ${m.confidence.toFixed(2)}) × 0.23 + |${fmtSigned(signature.motion_curvature ?? 0)}| × 0.15 gives amplitude ${(signature.motion_amplitude ?? 0).toFixed(3)}. ${MOTION_EFFECTS[pattern]}`,
      curvature_bias: `Curvature bias ${fmtSigned(signature.motion_curvature ?? 0)} chooses this family's local bend/winding side and contributes ${(Math.abs(signature.motion_curvature ?? 0) * 0.15).toFixed(3)} to amplitude. ${pattern === "arc" ? "Its magnitude also directly widens this arc's sweep." : "It is distinct from the measured source-curvature descriptor."} Global rotation remains ${signature.direction_angle_deg.toFixed(0)}°.`,
      motion_variation: `Motion variation ${m.motionVariation.toFixed(2)} gives a return budget of ${motion?.reversalBudget ?? signature.reversal_count} after the ${signature.length_class} length cap. ${MOTION_EFFECTS[pattern]} It also ${signature.length_class === "long" ? `selects ${signature.color_count} pigments` : "remains color-gated to one pigment"}.`,
      line_length: `Source length ${signature.length.toFixed(2)} selects ${signature.length_class}. After continuous scaling and boundary fitting, the generated centerline travels ${travelledDistance.toFixed(3)} normalized square-canvas units before corner rounding and camera zoom. It is not a fixed-length template.`,
      line_width: `The source width is ${(signature.width_ratio * 100).toFixed(2)}% of the canvas side. This source value and pressure profile are remapped through the ${signature.brush_style} nib's geometry, with a maximum body width of 12 CSS pixels across all materials.`,
      width_variation: `${signature.width_change_count === 0 ? "This stroke holds pressure at 1× because its stability is below 0.02; its material still shapes the outline." : `This stroke has ${signature.width_change_count} pronounced press/lift transitions: ${signature.width_profile.map((value) => `${value.toFixed(2)}×`).join(" → ")}. Its pressure peak-to-valley contrast is ${(Math.max(...signature.width_profile) / Math.min(...signature.width_profile)).toFixed(1)}:1, smoothly interpolated without mean normalization.`} The centerline is unchanged; physical width stays inside the material's 12-pixel cap.`,
      crossings: `Actual centerline crossings: ${actualCrossings}. Maximum permitted: ${crossingBudget}, derived from entropy ${m.entropy.toFixed(2)} and ${signature.length_class} length. ${family} uses only the intersections natural to its complete route; unused budget does not add loops. Counted before bounded corner rounding.`,
      brush_head: `${signature.brush_style}: ${MATERIAL_EFFECTS[signature.brush_style]} The original ${signature.brush_heads.join(" + ")} primitive-head metadata remains inspectable without stamping detached shapes onto the route.`,
      color_system: `${signature.color_count} seeded-random pigment${signature.color_count === 1 ? " is" : "s are"} used (${hueList}). Stops are equally spaced and interpolated by travelled distance, so refreshes preserve this artwork's palette.`,
      draw_speed: `This meteor travels through ${signature.speed_profile.length} phases with relative speed weights ${signature.speed_profile.map((value) => value.toFixed(2)).join(" → ")}, derived from per-anchor dwell times. Each phase covers an equal share of the route; a larger weight takes less time.`,
      drawing_duration: timing ? `${m.duration}ms of recorded dwell and average intensity ${m.intensity.toFixed(2)} produce a ${fmtTime(timing.durationMs)} reveal at 1×. Playback speed changes the viewing rate; the original timing remains part of this stroke.` : "",
      turn_system: `The turn budget is ${motion?.turnBudget ?? signature.turn_count}, interpreted by ${family.toLowerCase()} rather than forced into identical corners. Source angle is ${signature.turn_angle_deg.toFixed(0)}°; sharpness ${signature.turn_sharpness.toFixed(2)} determines bounded local rounding. ${MOTION_EFFECTS[pattern]}`,
      direction_system: `Drift bias ${fmtSigned(stroke?.mood?.drift_bias ?? 0)} rotates the complete ${family.toLowerCase()} to ${signature.direction_angle_deg.toFixed(0)}°. Its return budget is ${motion?.reversalBudget ?? signature.reversal_count}, not an exact U-turn count. ${MOTION_EFFECTS[pattern]}`,
    };
  }, [m, signature, timing, stroke, motion, travelledDistance]);

  const semanticAnchors = useMemo(
    () => [...new Set((stroke?.points ?? []).map((p) => p.anchor).filter(Boolean))],
    [stroke],
  );

  if (status === "loading") {
    return <Shell title={id}><div className="sd-state">loading stroke…</div></Shell>;
  }
  if (status === "missing" || !stroke) {
    return <Shell title={id}><div className="sd-state">Stroke “{id}” not found.</div></Shell>;
  }

  const agentName = agent?.name ?? stroke.agent_id;
  const cat = agent ? categoryLabel(agent.category) : "—";

  // ---- Layer 3 (causal) narrative + chain, derived from the parameters -----
  const why: { title: string; text: string }[] = [
    {
      title: "Why this agent produced this shape",
      text: `${agentName}${agent ? ` (${agent.occupation}, ${cat})` : ""} records the transition "${stroke.from}" → "${stroke.to}". Its ${stroke.geometry_mode ?? "linear"} geometry selects ${MOTION_LABELS[motion?.pattern ?? "glide"].toLowerCase()}; source attributes then shape that family. The recorded "${stroke.motion_type}" archetype is provenance, not a reason to replace every family with loops.`,
    },
    {
      title: "How entropy influenced structure",
      text: `Entropy ${m.entropy.toFixed(2)} contributes to lateral amplitude and sets a crossing ceiling of ${motion?.crossingBudget ?? 0}. This ${MOTION_LABELS[motion?.pattern ?? "glide"].toLowerCase()} uses ${motion?.crossingsUsed ?? 0} actual centerline intersections. Unused budget stays unused; the head still follows one unbranched route.`,
    },
    {
      title: "How confidence shapes movement and material",
      text: `Average confidence ${m.confidence.toFixed(2)} reduces the lateral-exploration signal while contributing${signature ? ` to ${(signature.width_ratio * 100).toFixed(2)}% source width` : " to source width"}. Local confidence also consolidates material edges. It does not independently set the animation clock.`,
    },
    {
      title: "How duration controls the reveal",
      text: `A total dwell of ${m.duration}ms across ${m.n} anchors and average intensity ${m.intensity.toFixed(2)} determine ${timing ? `a ${fmtTime(timing.durationMs)} reveal at 1×` : "the reveal duration"}. Recorded phase speeds make the head accelerate or linger along the same route.`,
    },
    {
      title: "How mood interacted with geometry / motion models",
      text: stroke.mood
        ? `Curvature bias ${fmtSigned(stroke.mood.curvature_bias)} sets the local bend/winding side; drift ${fmtSigned(stroke.mood.drift_bias)} sets global orientation; motion ${stroke.mood.motion_variation.toFixed(2)} gives a return budget of ${motion?.reversalBudget ?? 0}. The recorded ${stroke.motion_model ?? "continuous"} motion model contributes source pacing; ${stroke.branching_model ?? "none"} branching remains source metadata, not visible branches.`
        : `No mood was recorded; structural modes resolve to ${stroke.geometry_mode ?? "—"} / ${stroke.branching_model ?? "—"} / ${stroke.motion_model ?? "—"}.`,
    },
    ...(signature ? [{
      title: "How the meteor retains its source attributes",
      text: `Source length ${signature.length.toFixed(2)} produces a ${signature.length_class} gesture travelling ${travelledDistance.toFixed(3)} normalized square-canvas units before corner rounding. Its ${MOTION_LABELS[motion?.pattern ?? "glide"].toLowerCase()} family is preserved with ${motion?.crossingsUsed ?? 0} crossings under a ${motion?.crossingBudget ?? 0} ceiling. Motion and length select ${signature.color_count} seeded colors. ${MATERIAL_EFFECTS[signature.brush_style]}`,
    }] : []),
  ];

  const chain: { input: string; effect: string }[] = [
    { input: `geometry_mode: ${stroke.geometry_mode ?? "linear"}`, effect: `selects ${MOTION_LABELS[motion?.pattern ?? "glide"].toLowerCase()}, never overridden by the crossing ceiling` },
    { input: `entropy (${m.entropy.toFixed(2)})`, effect: "increases lateral amplitude and the permitted crossing ceiling; also affects material dryness" },
    { input: `confidence (${m.confidence.toFixed(2)})`, effect: "restrains lateral movement, consolidates material edges and contributes to source width" },
    { input: `dwell ${m.duration}ms + intensity ${m.intensity.toFixed(2)}`, effect: timing ? `sets a ${fmtTime(timing.durationMs)} reveal at 1×` : "sets the meteor reveal duration" },
    { input: `path intensity (${m.intensity.toFixed(2)})`, effect: signature ? `selects the ${signature.brush_style} brush material` : "selects the brush material" },
    { input: `curvature (${m.curvature.toFixed(2)})`, effect: "contributes to the recorded source turn-angle descriptor" },
    { input: `branching density (${m.branching.toFixed(2)})`, effect: "retained as source metadata; the meteor remains one unbranched centerline" },
    ...(signature ? [
      { input: `depth ${m.n} + dwell ${m.duration}ms`, effect: `derives source length ${signature.length.toFixed(2)}; actual centerline distance ${travelledDistance.toFixed(3)} normalized units` },
      { input: `entropy + (1 − confidence) + |curvature bias|`, effect: `weighted 0.62 / 0.23 / 0.15 → movement amplitude ${(signature.motion_amplitude ?? 0).toFixed(3)}` },
      { input: `intensity + confidence − entropy`, effect: `derives ${(signature.width_ratio * 100).toFixed(2)}% width and ${signature.color_temperature >= 0 ? "warm" : "cold"} temperature` },
      { input: `motion stability ${m.stability.toFixed(2)}`, effect: `creates ${signature.width_change_count} seeded thickness change${signature.width_change_count === 1 ? "" : "s"}: ${signature.width_profile.map((value) => `${value.toFixed(2)}×`).join(" → ")}` },
      { input: `entropy + length tier`, effect: `permits at most ${motion?.crossingBudget ?? signature.crossings} crossings; this centerline actually uses ${motion?.crossingsUsed ?? 0}` },
      { input: `motion ${m.motionVariation.toFixed(2)} + ${signature.length_class} length`, effect: `selects ${signature.color_count} evenly spaced random color stop${signature.color_count === 1 ? "" : "s"}` },
      { input: `drift ${fmtSigned(stroke.mood?.drift_bias ?? 0)} + motion ${m.motionVariation.toFixed(2)}`, effect: `rotates the complete family to ${signature.direction_angle_deg.toFixed(0)}° with return budget ${motion?.reversalBudget ?? signature.reversal_count}` },
      { input: `per-anchor dwell times`, effect: `create ${signature.speed_profile.length} relative speed phases along the meteor route` },
    ] : []),
  ];

  return (
    <Shell title={`${stroke.from} → ${stroke.to}`}>
      <div className="sd-content">
        <StrokePlayerPanel stroke={stroke} agent={agent} />

        {/* 2 + 3 · CORE GENERATIVE ATTRIBUTES (click a row to inspect) */}
        <section className="panel sd-section">
          <div className="panel-head">
            <h2>Generative + Visual Attributes</h2>
            <span className="muted">click to inspect</span>
          </div>
          <div className="sd-attrs">
            {attrs.map((a) => {
              const open = openAttr === a.key;
              const doc = ATTR_DOCS[a.key];
              return (
                <div key={a.key} className={`sd-attr${open ? " open" : ""}`}>
                  <button
                    className="sd-attr-row"
                    onClick={() => setOpenAttr(open ? null : a.key)}
                    aria-expanded={open}
                  >
                    <span className="sd-attr-name">{a.label}</span>
                    <span className="sd-attr-value">{a.display}</span>
                    <span className="sd-attr-bar"><span className="sd-attr-fill" style={{ width: `${Math.round(a.bar01 * 100)}%` }} /></span>
                    <span className="sd-attr-caret">{open ? "▾" : "▸"}</span>
                  </button>
                  {open && doc && (
                    <div className="sd-attr-detail">
                      <div className="sd-ad-row"><span>definition</span><p>{doc.definition}</p></div>
                      <div className="sd-ad-row"><span>affects geometry</span><p>{doc.geometry}</p></div>
                      <div className="sd-ad-row"><span>affects motion</span><p>{doc.motion}</p></div>
                      <div className="sd-ad-row"><span>typical range</span><p>{doc.ranges}</p></div>
                      <div className="sd-ad-row"><span>high vs low</span><p>{doc.highLow}</p></div>
                      <div className="sd-ad-row sd-ad-result"><span>this stroke</span><p>{attributeState[a.key]}</p></div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* 4 · MOOD + STRUCTURAL MODE */}
        <section className="panel sd-section">
          <div className="panel-head"><h2>Mood + Structural Mode</h2></div>
          <div className="sd-block">
            {stroke.mood ? (
              <div className="sd-mood">
                <span title="extra path randomness">entropy_shift {fmtSigned(stroke.mood.entropy_shift)}</span>
                <span title="directional drift">drift_bias {fmtSigned(stroke.mood.drift_bias)}</span>
                <span title="bend/winding direction and amplitude contribution">curvature_bias {fmtSigned(stroke.mood.curvature_bias)}</span>
                <span title="motion-family return budget and length-gated palette size">motion_variation {stroke.mood.motion_variation.toFixed(2)}</span>
                <span title="source color-temperature metadata; the displayed palette uses a creation seed">color_variation {fmtSigned(stroke.mood.color_variation)}</span>
              </div>
            ) : <p className="sd-muted">no mood recorded for this stroke.</p>}

            <dl className="sd-modes">
              <div><dt>geometry_mode</dt><dd><b>{stroke.geometry_mode ?? "linear"} → {MOTION_LABELS[motion?.pattern ?? "glide"]}</b> · {MOTION_EFFECTS[motion?.pattern ?? "glide"]}</dd></div>
              <div><dt>crossing budget</dt><dd><b>{motion?.crossingsUsed ?? 0} actual / {motion?.crossingBudget ?? 0} maximum</b> · counts the generated centerline; unused budget never inserts loops</dd></div>
              <div><dt>branching_model</dt><dd><b>{stroke.branching_model ?? "—"}</b> · source semantic metadata; the displayed trajectory remains one unbranched stroke</dd></div>
              <div><dt>motion_model</dt><dd><b>{stroke.motion_model ?? "—"}</b> · contributes to recorded anchor pacing, which becomes the relative phase-speed profile</dd></div>
              <div><dt>semantic_depth</dt><dd><b>{stroke.semantic_depth ?? "—"}</b> · number of anchors the mood restructured the path to</dd></div>
            </dl>
          </div>
        </section>

        {/* 5 · SEMANTIC ANCHORS */}
        <section className="panel sd-section">
          <div className="panel-head"><h2>Semantic Anchors</h2><span className="muted">key conceptual nodes</span></div>
          <div className="sd-block">
            {semanticAnchors.length ? (
              <div className="sd-anchors">
                {semanticAnchors.map((a, i) => <span key={i} className="sd-anchor">{a}</span>)}
              </div>
            ) : <p className="sd-muted">no anchors.</p>}
          </div>
        </section>

        {/* 6 · CAUSAL EXPLANATION LAYER */}
        <section className="panel sd-section">
          <div className="panel-head"><h2>Why this stroke exists</h2><span className="muted">causal reasoning</span></div>
          <div className="sd-block">
            <div className="sd-why">
              {why.map((w, i) => (
                <div key={i} className="sd-why-item">
                  <div className="sd-why-title">{w.title}</div>
                  <p>{w.text}</p>
                </div>
              ))}
            </div>

            <div className="sd-chain-label">Input space → Transformation → Output form</div>
            <div className="sd-chain">
              {chain.map((c, i) => (
                <div key={i} className="sd-chain-row">
                  <span className="sd-chain-in">{c.input}</span>
                  <span className="sd-chain-arrow">→</span>
                  <span className="sd-chain-out">{c.effect}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 7 · RAW JSON */}
        <section className="panel sd-section">
          <div className="panel-head"><h2>Raw stroke object</h2><span className="muted">full debug view · no hidden fields</span></div>
          <pre className="sd-json">{JSON.stringify(stroke, null, 2)}</pre>
        </section>
      </div>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="stroke-detail-page">
      <div className="detail-topbar">
        <Link href="/studio" className="back-link">← back to studio</Link>
        <div className="detail-title">{title}</div>
        <span className="back-link" />
      </div>
      {children}
    </div>
  );
}
