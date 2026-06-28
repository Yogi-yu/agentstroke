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
    definition: "Activation magnitude along the path — drives opacity and glow energy.",
    geometry: "Higher intensity thickens the visible mass and widens the glow halo.",
    motion: "Stronger comet pulse and brighter motion trails.",
    ranges: "0.0 – 1.0 · typical ~0.2 – 0.8.",
    highLow: "High → blazing, energetic. Low → faint, restrained.",
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
    geometry: "Higher density fans the stroke into tree-like divergence.",
    motion: "Multiple secondary pulses ride the spurs.",
    ranges: "0.0 (none) – 1.0+ (dense fan).",
    highLow: "High → bushy, exploratory. Low → single clean line.",
  },
  stability: {
    definition: "Uniformity of per-step pacing — the inverse of temporal variance.",
    geometry: "Stable pacing yields evenly-spaced structure; unstable pacing clusters and gaps it.",
    motion: "Steady, predictable travel versus lurching, irregular motion.",
    ranges: "0.0 (erratic) – 1.0 (metronomic).",
    highLow: "High → smooth, calm. Low → jittery, bursty.",
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
    return { n, entropy, confidence, intensity, duration, branching, curvature, stability };
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
  ], [m]);

  const semanticAnchors = useMemo(
    () => (stroke?.points ?? []).map((p) => p.anchor).filter(Boolean),
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
  ];

  const chain: { input: string; effect: string }[] = [
    { input: `entropy (${m.entropy.toFixed(2)})`, effect: high(m.entropy) ? "increases branching probability + edge diffusion" : "keeps geometry clean + deterministic" },
    { input: `confidence (${m.confidence.toFixed(2)})`, effect: high(m.confidence) ? "reduces path divergence (direct route)" : "permits exploratory divergence" },
    { input: `duration (${m.duration}ms)`, effect: m.duration > 3000 ? "elongates stroke continuity" : "compresses the stroke into a burst" },
    { input: `path intensity (${m.intensity.toFixed(2)})`, effect: high(m.intensity) ? "raises opacity + glow energy" : "keeps the stroke faint + restrained" },
    { input: `curvature (${m.curvature.toFixed(2)})`, effect: m.curvature > 0.4 ? "bends the trajectory into arcs" : "holds a near-linear path" },
    { input: `branching density (${m.branching.toFixed(2)})`, effect: m.branching > 0.2 ? "spawns sub-branch spurs" : "stays a single clean line" },
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
            <h2>Core Generative Attributes</h2>
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
        <Link href="/" className="back-link">← back to canvas</Link>
        <div className="detail-title">{title}</div>
        <span className="back-link" />
      </div>
      {children}
    </div>
  );
}
