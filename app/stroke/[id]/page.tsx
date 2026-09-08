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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import CanvasView from "@/components/CanvasView";
import type { Agent, AgentProfile, TransitionPath } from "@/lib/types";
import { agentRenderStyle, categoryLabel } from "@/lib/agents";
import { resolveVisualSignature } from "@/engine/visualSignature";

const noop = () => {};
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const fmtSigned = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2);

// ---- Layer 3: per-attribute inspector docs --------------------------------
interface AttrDoc {
  definition: string;
  geometry: string;
  motion: string;
  ranges: string;
  highLow: string;
}
const ATTR_DOCS: Record<string, AttrDoc> = {
  entropy: {
    definition: "Local uncertainty in the agent's path — how noisy or diffuse each step is.",
    geometry: "Higher entropy roughens the path and raises branching probability; lower entropy yields clean, deterministic geometry.",
    motion: "Adds jitter and softer, more diffuse edges to the travelling pulse.",
    ranges: "0.0 – 1.0 · typical strokes sit ~0.1 – 0.7.",
    highLow: "High → frayed, exploratory, blurry lines. Low → crisp, decisive, minimal lines.",
  },
  confidence: {
    definition: "Certainty of the agent at each step — drives brightness and determinism.",
    geometry: "High confidence reduces path divergence (straighter, more direct); low confidence permits wandering.",
    motion: "Brighter core and steadier travel along the path.",
    ranges: "0.0 – 1.0 · typical ~0.4 – 0.9.",
    highLow: "High → bright, direct, committed. Low → dim, hesitant, divergent.",
  },
  duration: {
    definition: "Total dwell time across the path — the temporal length of the cognitive event.",
    geometry: "Longer durations elongate stroke continuity and span more semantic anchors.",
    motion: "Slower, more continuous travel; short durations feel bursty and clipped.",
    ranges: "~500 – 6000ms depending on path length + agent pacing.",
    highLow: "High → long, flowing, continuous. Low → short, staccato gestures.",
  },
  points: {
    definition: "Number of sampled semantic anchors along the A→B transition.",
    geometry: "More points = denser, more articulated geometry with more inflection.",
    motion: "More segments for the pulse to traverse before completing.",
    ranges: "Typically 4 – 12 anchors.",
    highLow: "High → intricate, multi-step reasoning. Low → terse, direct leaps.",
  },
  intensity: {
    definition: "Activation magnitude along the path — deterministically selects the drawing instrument.",
    geometry: "Average intensity selects the tool: hard <0.70, soft 0.70–0.76, watercolor 0.76–0.83, texture ≥0.83.",
    motion: "Hard uses a stable square nib; soft uses pressure taper; watercolor creates edge pooling and bloom; texture uses grain and irregular edges.",
    ranges: "0.0 – 1.0 · current generated paths typically occupy ~0.65 – 0.90.",
    highLow: "High → textured, material drag. Low → precise, hard-edged mark.",
  },
  curvature: {
    definition: "Average turning of the trajectory between consecutive segments.",
    geometry: "Higher curvature bends the path into arcs and orbits; low curvature stays linear.",
    motion: "Sweeping, looping travel versus a straight glide.",
    ranges: "0.0 (straight) – 1.0 (sharp reversals).",
    highLow: "High → swirling, organic. Low → rigid, direct.",
  },
  branching: {
    definition: "Density of sub-branch spurs spawned along the path.",
    geometry: "Higher density adds components to the brush head; crossings are controlled separately by entropy and the length gate.",
    motion: "Branching changes the pressure/head behaviour without creating detached secondary strokes.",
    ranges: "0.0 (none) – 1.0+ (dense fan).",
    highLow: "High → a more complex composite nib and pressure response. Low → a simpler clean gesture.",
  },
  stability: {
    definition: "Uniformity of per-step pacing, used as the control signal for deliberate width transitions.",
    geometry: "Only exceptionally low values keep one width; medium values create 1–3 seeded width changes; high values create 5–8 changes.",
    motion: "Each change modifies the actual brush pressure along the same path, allowing thick → thin → thick sequences.",
    ranges: "<0.18 = constant; 0.18–0.68 = 1–3 changes; ≥0.68 = 5–8 changes.",
    highLow: "High → 5–8 pressure/width phases. Middle → 1–3 phases. Only exceptionally low stability stays uniform.",
  },
  motion_variation: {
    definition: "The stroke's 0–1 motion variability value; it controls temporal liveliness, U-turn count and the permitted palette size.",
    geometry: "<0.35 stays forward; higher tiers create 1–4 continuous direction reversals without branches or disconnected marks.",
    motion: "Higher values increase the flexibility and pressure pulse of the living brush body.",
    ranges: "Reversals: <0.35 = 0, 0.35–0.58 = 1, 0.58–0.78 = 2, 0.78–0.92 = 3, ≥0.92 = 4; short/medium capacity is 1/2. Long-stroke color tiers remain 1/3/5.",
    highLow: "High → repeated continuous U-turns and, when long, a five-pigment gradient. Low → direct travel with one pigment.",
  },
  line_length: {
    definition: "The total distance travelled by the stroke, measured against one side of the square canvas.",
    geometry: "Length controls how much territory the path traverses; long strokes can loop repeatedly while a zero-length stroke resolves to a point.",
    motion: "A longer path gives the moving head more distance and more temporal phases to reveal.",
    ranges: "Attribute <5 = Short (point–10% scale); 5–6 = Medium (10–50%); >6 = Long (50–100%). Values vary continuously inside each range.",
    highLow: "High → extended, layered journeys. Low → compact marks; minimum → a single point.",
  },
  line_width: {
    definition: "Stroke diameter as a proportion of the square canvas side, independent of device resolution.",
    geometry: "Changes the physical mass of every segment without changing its centerline.",
    motion: "Wide strokes leave broad luminous trails; thin strokes read as precise moving filaments.",
    ranges: "1 – 10 screen pixels (up to 0.8% of canvas side); derived from intensity, confidence and inverse entropy with a strongly thin-biased curve.",
    highLow: "High → monumental bands. Low → hairline or point-like traces.",
  },
  width_variation: {
    definition: "The seeded pressure profile that changes thickness along this individual stroke.",
    geometry: "Profile values are interpolated continuously, so width swells and contracts without breaking the centerline.",
    motion: "The living brush carries these width states while it flexes; this is not an opacity effect.",
    ranges: "0 changes for stability <0.18; 1–3 for 0.18–0.68; 5–8 at or above 0.68. Multipliers span a clearly visible 0.32×–1.72× range.",
    highLow: "Many changes → repeated thick/thin rhythm. Zero changes → uniform pressure from start to end.",
  },
  crossings: {
    definition: "The intended number of natural self-crossings in one uninterrupted gesture.",
    geometry: "The whole path continuously swings forward and locally folds over its earlier route; no figure-eight modules or branches are inserted.",
    motion: "The moving head revisits shared coordinates at different moments, creating accumulated light at intersections.",
    ranges: "Entropy <0.38 = 0; 0.38–0.72 = 0–4; >0.72 = 5–8 only for long strokes. Short and medium strokes are capped at 4.",
    highLow: "High entropy + long length → woven 5–8 crossing structure. Low entropy → open, uninterrupted trajectory.",
  },
  brush_head: {
    definition: "The primitive or composite shape carried by the moving drawing head.",
    geometry: "Round, square, diamond, triangle, ring and organic primitives may appear alone or in combinations of up to three.",
    motion: "The chosen silhouette travels with the pulse, so the act of drawing has its own visible instrument.",
    ranges: "1 – 3 components; geometry mode selects the primary head, motion mode and branching add secondary heads.",
    highLow: "Single → clean signature. Multiple → layered, more synthetic imprint.",
  },
  color_system: {
    definition: "A seeded random palette distributed continuously and evenly over the travelled length of the stroke.",
    geometry: "Color changes pigment only; it never splits or duplicates the one-stroke centerline.",
    motion: "The gradient remains attached to the living brush body as its pressure and curvature evolve.",
    ranges: "Long stroke + motion <0.35 = 1 color; 0.35–0.70 = 3; >0.70 = 5. Non-long strokes are locked to 1.",
    highLow: "High motion on a long stroke → five random color stops. Otherwise → one random color.",
  },
  draw_speed: {
    definition: "A multi-stage speed profile sampled continuously from the start to the end of the stroke.",
    geometry: "Speed leaves the path coordinates unchanged, keeping form and time independently controllable.",
    motion: "Every segment reads its local phase speed, producing acceleration, hesitation and bursts within one line.",
    ranges: "3 – 6 phases; each phase is the inverse of its original duration_ms (long dwell = slow draw).",
    highLow: "High variation → dramatic rhythm changes. Low variation → steady traversal.",
  },
  turn_system: {
    definition: "Three linked controls: a 0–4 turn-count remainder, direction-change angle and corner sharpness.",
    geometry: "Angle determines how far the line redirects; sharpness blends from a rounded Catmull-Rom bend to a hard linear corner.",
    motion: "Rounded turns feel fluid; hard near-180° turns make the travelling head snap back decisively.",
    ranges: "Original turns are folded by modulo 4 into 1–4 (a two-point path stays at 0); angle 0°–179°; entropy, curvature mood and motion determine sharpness.",
    highLow: "High → near-reversal with a hard crease. Low → shallow, circular flow.",
  },
  direction_system: {
    definition: "The overall travel orientation plus the number of macro direction reversals.",
    geometry: "Drift bias maps around 360° to rotate the full gesture; motion variation inserts continuous, laterally separated hairpin turns.",
    motion: "Every reversal is traversed by the same brush head in sequence, so the line visibly turns back rather than spawning another arm.",
    ranges: "Direction 0°–360° from drift_bias; U-turn count 0–4 from motion variation, capped to 1 for short and 2 for medium strokes.",
    highLow: "High motion → several changes of travel direction. Low motion → a single dominant direction.",
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
  const [replayKey, setReplayKey] = useState(0);
  const [openAttr, setOpenAttr] = useState<string | null>(null);

  // Single source of truth: the SERVER store.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/strokes/${encodeURIComponent(id)}`, { cache: "no-store" });
        if (!alive) return;
        if (!r.ok) { setStatus("missing"); return; }
        const d = await r.json();
        setStroke(d.stroke ?? null);
        setAgent(d.agent ?? null);
        setStatus(d.stroke ? "ready" : "missing");
      } catch {
        if (alive) setStatus("missing");
      }
    })();
    return () => { alive = false; };
  }, [id]);

  const previewPaths = useMemo<TransitionPath[]>(() => (stroke ? [stroke] : []), [stroke]);
  const previewAgents = useMemo<Agent[]>(
    () => (stroke ? [{ id: stroke.agent_id, style: agentRenderStyle(agent?.category ?? "coding") }] : []),
    [stroke, agent],
  );

  const signature = useMemo(
    () => stroke ? resolveVisualSignature(stroke, agentRenderStyle(agent?.category ?? "coding").hue) : null,
    [stroke, agent],
  );

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

    let stability = 1;
    if (n >= 2) {
      const ds = pts.map((p) => p.duration_ms);
      const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
      if (mean > 0) {
        const variance = ds.reduce((a, b) => a + (b - mean) ** 2, 0) / ds.length;
        stability = clamp01(1 - Math.sqrt(variance) / mean);
      }
    }
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
    ...(signature ? [
      { key: "line_length", label: "line length", display: signature.length <= 0.002 ? "point" : `${signature.length_class} · ${signature.length.toFixed(2)}`, bar01: clamp01(signature.length / 21) },
      { key: "line_width", label: "line width", display: `${(signature.width_ratio * 100).toFixed(2)}%`, bar01: clamp01(signature.width_ratio / 0.008) },
      { key: "width_variation", label: "width variation", display: `${signature.width_change_count} change${signature.width_change_count === 1 ? "" : "s"}`, bar01: signature.width_change_count / 8 },
      { key: "crossings", label: "crossings", display: `${signature.crossings}`, bar01: signature.crossings / 8 },
      { key: "brush_head", label: "brush stroke", display: `${signature.brush_style} · ${signature.brush_heads.join(" + ")}`, bar01: signature.brush_style === "hard" ? 0.2 : signature.brush_style === "soft" ? 0.45 : signature.brush_style === "watercolor" ? 0.72 : 1 },
      { key: "color_system", label: "color", display: `${signature.color_count} color${signature.color_count > 1 ? "s" : ""} · ${signature.length_class}`, bar01: signature.color_count / 5 },
      { key: "draw_speed", label: "draw speed", display: `${signature.speed_profile.length} phases`, bar01: clamp01((Math.max(...signature.speed_profile) - Math.min(...signature.speed_profile)) / 1.88) },
      { key: "turn_system", label: "turn", display: `${signature.turn_count} turns · ${signature.turn_angle_deg.toFixed(0)}°`, bar01: signature.turn_count / 4 },
      { key: "direction_system", label: "direction", display: `${signature.direction_angle_deg.toFixed(0)}° · ${signature.reversal_count} U-turn${signature.reversal_count === 1 ? "" : "s"}`, bar01: signature.reversal_count / 4 },
    ] : []),
  ], [m, signature]);

  const attributeState = useMemo<Record<string, string>>(() => {
    if (!signature) return {} as Record<string, string>;
    const hueList = signature.color_hues.map((hue) => `${Math.round(hue)}°`).join(" → ");
    const speedRange = `${Math.min(...signature.speed_profile).toFixed(2)}–${Math.max(...signature.speed_profile).toFixed(2)}×`;
    return {
      entropy: `Average entropy ${m.entropy.toFixed(2)} places this stroke in the ${signature.crossings === 0 ? "zero-crossing" : signature.crossings <= 4 ? "0–4 crossing" : "5–8 high-crossing"} tier, producing ${signature.crossings} visible self-crossing${signature.crossings === 1 ? "" : "s"}.`,
      confidence: `Average confidence ${m.confidence.toFixed(2)} contributes to this stroke's ${(signature.width_ratio * 100).toFixed(2)}% canvas-relative width and ${signature.color_temperature >= 0 ? "warm" : "cold"} temperature metadata.`,
      duration: `${m.duration}ms of total dwell contributes to a ${signature.length.toFixed(2)} length value and a ${signature.length_class} spatial span.`,
      points: `${m.n} semantic anchors are reduced to ${signature.turn_count} principal turn${signature.turn_count === 1 ? "" : "s"}, keeping the gesture readable.`,
      intensity: `Average intensity ${m.intensity.toFixed(2)} selects the ${signature.brush_style} instrument for this stroke.`,
      curvature: `Measured curvature ${m.curvature.toFixed(2)} contributes to a ${signature.turn_angle_deg.toFixed(0)}° turn character and ${signature.turn_sharpness < 0.45 ? "rounded" : "sharper"} spline tension.`,
      branching: `Branching density ${m.branching.toFixed(2)} produces a ${signature.brush_heads.join(" + ")} composite nib while preserving one continuous line.`,
      stability: `Motion stability ${m.stability.toFixed(2)} selects ${signature.width_change_count} seeded width change${signature.width_change_count === 1 ? "" : "s"}; the temporal speed profile still spans ${speedRange}.`,
      motion_variation: `Motion variation ${m.motionVariation.toFixed(2)} produces ${signature.reversal_count} continuous U-turn${signature.reversal_count === 1 ? "" : "s"} after the ${signature.length_class} length-cap, and ${signature.length_class === "long" ? `selects the ${signature.color_count}-color tier` : `is color-gated to 1 pigment`}.`,
      line_length: `The derived length is ${signature.length.toFixed(2)}, so this is a ${signature.length_class} stroke using a variable position inside that class rather than its fixed maximum.`,
      line_width: `The calculated width is ${(signature.width_ratio * 100).toFixed(2)}% of the canvas side, rendered with pressure variation from the selected ${signature.brush_style} tool.`,
      width_variation: `${signature.width_change_count === 0 ? "This stroke stays at one uniform width." : `This stroke changes width ${signature.width_change_count} times with pressure multipliers ${signature.width_profile.map((value) => `${value.toFixed(2)}×`).join(" → ")}.`} Values are seeded and remain stable after refresh.`,
      crossings: `This ${signature.length_class} stroke is assigned ${signature.crossings} natural self-crossing${signature.crossings === 1 ? "" : "s"}; the entire result remains one uninterrupted path.`,
      brush_head: `Path intensity and structural modes select a ${signature.brush_style} stroke with ${signature.brush_heads.join(" + ")} nib geometry.`,
      color_system: `${signature.color_count} seeded-random pigment${signature.color_count === 1 ? " is" : "s are"} used (${hueList}). Stops are equally spaced and interpolated by travelled distance, so refreshes preserve this artwork's palette.`,
      draw_speed: `This stroke has ${signature.speed_profile.length} temporal phases spanning ${speedRange}, derived from per-anchor dwell times.`,
      turn_system: `${signature.turn_count} principal turn${signature.turn_count === 1 ? "" : "s"}, ${signature.turn_angle_deg.toFixed(0)}° direction change and ${signature.turn_sharpness.toFixed(2)} sharpness define this stroke's corner state.`,
      direction_system: `Drift bias ${fmtSigned(stroke?.mood?.drift_bias ?? 0)} rotates this stroke to ${signature.direction_angle_deg.toFixed(0)}°. Motion variation adds ${signature.reversal_count} laterally separated U-turn${signature.reversal_count === 1 ? "" : "s"}, all on the same centreline.`,
    };
  }, [m, signature]);

  const semanticAnchors = useMemo(
    () => [...new Set((stroke?.points ?? []).map((p) => p.anchor).filter(Boolean))],
    [stroke],
  );

  const replay = useCallback(() => setReplayKey((k) => k + 1), []);

  if (status === "loading") {
    return <Shell title={id}><div className="sd-state">loading stroke…</div></Shell>;
  }
  if (status === "missing" || !stroke) {
    return <Shell title={id}><div className="sd-state">Stroke “{id}” not found.</div></Shell>;
  }

  const ts = stroke.timestamp ?? stroke.created_at;
  const agentName = agent?.name ?? stroke.agent_id;
  const cat = agent ? categoryLabel(agent.category) : "—";

  // ---- Layer 3 (causal) narrative + chain, derived from the parameters -----
  const high = (v: number) => v > 0.55;
  const why: { title: string; text: string }[] = [
    {
      title: "Why this agent produced this shape",
      text: `${agentName}${agent ? ` (${agent.occupation}, ${cat})` : ""} realizes the transition "${stroke.from}" → "${stroke.to}" through a "${stroke.motion_type}" motion archetype tied to its economic function, so the path is shaped accordingly rather than drawn arbitrarily.`,
    },
    {
      title: "How entropy influenced structure",
      text: high(m.entropy)
        ? `High entropy (${m.entropy.toFixed(2)}) roughened the trajectory and raised branching probability — producing frayed, exploratory geometry.`
        : `Low entropy (${m.entropy.toFixed(2)}) kept the path clean and deterministic, with little divergence or noise.`,
    },
    {
      title: "How confidence affected determinism vs. exploration",
      text: high(m.confidence)
        ? `High confidence (${m.confidence.toFixed(2)}) reduced path divergence — the stroke commits to a bright, direct route.`
        : `Lower confidence (${m.confidence.toFixed(2)}) permitted exploratory divergence and dimmer, more tentative travel.`,
    },
    {
      title: "How duration affected stroke continuity",
      text: `A total dwell of ${m.duration}ms across ${m.n} anchors ${m.duration > 3000 ? "elongates the stroke into a long, continuous flow" : "yields a shorter, more clipped gesture"}.`,
    },
    {
      title: "How mood interacted with geometry / motion models",
      text: stroke.mood
        ? `Sampled under a mood of curvature ${fmtSigned(stroke.mood.curvature_bias)}, drift ${fmtSigned(stroke.mood.drift_bias)}, motion ${stroke.mood.motion_variation.toFixed(2)} — which selected the "${stroke.geometry_mode}" geometry, "${stroke.branching_model}" branching and "${stroke.motion_model}" motion models.`
        : `No mood was recorded; structural modes resolve to ${stroke.geometry_mode ?? "—"} / ${stroke.branching_model ?? "—"} / ${stroke.motion_model ?? "—"}.`,
    },
    ...(signature ? [{
      title: "How the seven visual variables stay explainable",
      text: `This is not an independent random style layer: ${signature.length.toFixed(2)}× length comes from ${m.n} semantic anchors and ${m.duration}ms dwell; ${signature.crossings} crossings come from entropy ${m.entropy.toFixed(2)}, with the 5–8 tier available only to long strokes; motion ${m.motionVariation.toFixed(2)} and the length gate select ${signature.color_count} seeded-random colors; ${signature.brush_heads.join(" + ")} heads come from the structural modes.`,
    }] : []),
  ];

  const chain: { input: string; effect: string }[] = [
    { input: `entropy (${m.entropy.toFixed(2)})`, effect: high(m.entropy) ? "increases branching probability + edge diffusion" : "keeps geometry clean + deterministic" },
    { input: `confidence (${m.confidence.toFixed(2)})`, effect: high(m.confidence) ? "reduces path divergence (direct route)" : "permits exploratory divergence" },
    { input: `duration (${m.duration}ms)`, effect: m.duration > 3000 ? "elongates stroke continuity" : "compresses the stroke into a burst" },
    { input: `path intensity (${m.intensity.toFixed(2)})`, effect: signature ? `selects the ${signature.brush_style} instrument` : "selects a drawing instrument" },
    { input: `curvature (${m.curvature.toFixed(2)})`, effect: m.curvature > 0.4 ? "bends the trajectory into arcs" : "holds a near-linear path" },
    { input: `branching density (${m.branching.toFixed(2)})`, effect: m.branching > 0.2 ? "adds brush-head complexity while preserving one gesture" : "keeps a simple single gesture" },
    ...(signature ? [
      { input: `depth ${m.n} + dwell ${m.duration}ms`, effect: `derives ${signature.length.toFixed(2)}× canvas-side line length` },
      { input: `intensity + confidence − entropy`, effect: `derives ${(signature.width_ratio * 100).toFixed(2)}% width and ${signature.color_temperature >= 0 ? "warm" : "cold"} temperature` },
      { input: `motion stability ${m.stability.toFixed(2)}`, effect: `creates ${signature.width_change_count} seeded thickness change${signature.width_change_count === 1 ? "" : "s"}: ${signature.width_profile.map((value) => `${value.toFixed(2)}×`).join(" → ")}` },
      { input: `entropy + length tier`, effect: `derives ${signature.crossings} deliberate crossings (maximum 8)` },
      { input: `motion ${m.motionVariation.toFixed(2)} + ${signature.length_class} length`, effect: `selects ${signature.color_count} evenly spaced random color stop${signature.color_count === 1 ? "" : "s"}` },
      { input: `drift ${fmtSigned(stroke.mood?.drift_bias ?? 0)} + motion ${m.motionVariation.toFixed(2)}`, effect: `rotates travel to ${signature.direction_angle_deg.toFixed(0)}° and creates ${signature.reversal_count} continuous U-turn${signature.reversal_count === 1 ? "" : "s"}` },
      { input: `${stroke.geometry_mode} + ${stroke.motion_model}`, effect: `adds ${signature.brush_heads.join(" + ")} head structure and ${signature.speed_profile.length} duration-led phases` },
    ] : []),
  ];

  return (
    <Shell title={`${stroke.from} → ${stroke.to}`}>
      <div className="sd-content">
        {/* 1 · HEADER */}
        <section className="panel sd-section sd-header">
          <div className="sd-h-route">
            <b>{stroke.from}</b><span className="sd-h-arrow">→</span><b>{stroke.to}</b>
          </div>
          <div className="sd-h-meta">
            <span>agent <b>{agentName}</b></span>
            <span>{cat}</span>
            <span>motion <b>{stroke.motion_type}</b></span>
            <span>{new Date(ts).toLocaleString()}</span>
          </div>
          <code className="sd-h-id">{stroke.id}</code>
        </section>

        {/* replay preview (visualization) */}
        <section className="panel sd-section">
          <div className="panel-head">
            <h2>Stroke Replay</h2>
            <button className="mini regen" onClick={replay} title="Replay the stroke animation">↺ Replay</button>
          </div>
          <div className="sd-canvas">
            <CanvasView
              key={replayKey}
              paths={previewPaths}
              agents={previewAgents}
              selectedStrokeId={null}
              filterAgentId={null}
              editMode={false}
              onSelectStroke={noop}
              onTransformCommit={noop}
            />
          </div>
        </section>

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
                <span title="curvature style">curvature_bias {fmtSigned(stroke.mood.curvature_bias)}</span>
                <span title="animation pacing">motion_variation {stroke.mood.motion_variation.toFixed(2)}</span>
                <span title="hue shift">color_variation {fmtSigned(stroke.mood.color_variation)}</span>
              </div>
            ) : <p className="sd-muted">no mood recorded for this stroke.</p>}

            <dl className="sd-modes">
              <div><dt>geometry_mode</dt><dd><b>{stroke.geometry_mode ?? "—"}</b> · defines the global geometric structure of the stroke path</dd></div>
              <div><dt>branching_model</dt><dd><b>{stroke.branching_model ?? "—"}</b> · controls divergence structure along the semantic trajectory</dd></div>
              <div><dt>motion_model</dt><dd><b>{stroke.motion_model ?? "—"}</b> · defines the temporal animation behaviour of the stroke</dd></div>
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
