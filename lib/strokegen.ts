// ============================================================================
// Stroke Generation (Layer 1) — concept A → semantic transform → concept B.
// ----------------------------------------------------------------------------
// The A→B semantic transform is unchanged: the agent's model produces the
// intermediate concepts + per-step entropy/confidence. But the stroke now
// REFLECTS THE AGENT'S ECONOMIC FUNCTION: its category supplies a motion
// archetype + modulation (volatility, convergence, oscillation, branching) so a
// coding agent draws structured deterministic strokes, a trading agent volatile
// ones, a negotiation agent oscillatory-converging ones, and so on.
// Falls back to a deterministic synthetic path if OpenRouter is unavailable.
// ============================================================================

import type {
  AgentProfile,
  BranchingModel,
  GeometryMode,
  Mood,
  MotionModel,
  MotionType,
  TransitionPath,
  TransitionPoint,
} from "@/lib/types";
import { hashStr, makeRng, clamp01 } from "@/simulation/rng";
import { buildGeometryPath, assignBranches, motionPacing } from "@/engine/structuralModes";
import {
  generateMood,
  strokeVariationSeed,
  selectGeometryMode,
  selectBranchingModel,
  selectMotionModel,
  selectSemanticDepth,
} from "@/simulation/mood";
import { getOpenRouter } from "@/lib/openrouter/client";
import { modelSpec } from "@/lib/openrouter/models";
import { agentRegion, categoryStrokeProfile } from "@/lib/agents";
import { createVisualSignature } from "@/engine/visualSignature";

/** Closest legacy MotionType label for a structural geometry mode (UI/back-compat). */
const GEOMETRY_TO_MOTION: Record<GeometryMode, MotionType> = {
  linear: "direct",
  curved: "curved",
  spiral: "orbital",
  recursive: "fractal",
  oscillatory: "drift",
  fragmented: "fractal",
};

const TIMEOUT_MS = 15_000;
const TARGET_STEPS = 9;

const GEOMETRY_MODES: GeometryMode[] = ["linear", "curved", "spiral", "recursive", "oscillatory", "fragmented"];
const BRANCHING_MODES: BranchingModel[] = ["none", "binary", "tree", "chaotic", "delayed"];
const MOTION_MODELS: MotionModel[] = ["continuous", "segmented", "jitter", "wave", "burst"];

function avoidPrevious<T>(selected: T, previous: T | undefined, choices: readonly T[], seed: number): T {
  if (previous === undefined || selected !== previous) return selected;
  const alternatives = choices.filter((choice) => choice !== previous);
  return alternatives[seed % alternatives.length] ?? selected;
}

interface SemanticPath {
  anchors: string[];
  entropy: number[];
  confidence: number[];
}

const CONCEPT_BANK = [
  "association", "analogy", "abstraction", "contrast", "memory trace", "prior",
  "salience", "ambiguity", "recombination", "metaphor", "negation", "boundary",
  "resonance", "compression", "divergence", "convergence", "echo", "drift",
  "binding", "collapse", "inference", "gradient", "attractor", "threshold",
];

// ---- prompt + parsing (A→B semantic transform; unchanged) ------------------

function buildMessages(from: string, to: string) {
  const system = [
    "You are a semantic transition engine inside a stroke-generation art system — NOT a chatbot.",
    "Given a FROM concept and a TO concept, produce ONE semantic path: the ordered intermediate concepts a mind would pass through moving from FROM to TO, with per-step uncertainty and certainty.",
    "Return STRICT JSON only, no prose, matching exactly:",
    '{ "path": string[], "entropy": number[], "confidence": number[] }',
    `Rules: path has ~${TARGET_STEPS} concepts, first = FROM and last = TO; entropy & confidence are [0,1] arrays the SAME length as path. No coordinates.`,
  ].join("\n");
  const user = `FROM: ${from}\nTO: ${to}\nReturn the semantic path as strict JSON.`;
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

function extractJson(text: string): Record<string, unknown> {
  const t = text.trim();
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a !== -1 && b > a) return JSON.parse(t.slice(a, b + 1)) as Record<string, unknown>;
    throw new Error("reply was not valid JSON");
  }
}

function asStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : String(x))).map((s) => s.trim()).filter(Boolean);
}

function asNums(v: unknown, len: number): number[] {
  const arr = Array.isArray(v) ? v : [];
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    const raw = typeof arr[i] === "number" ? (arr[i] as number) : Number(arr[i]);
    out.push(clamp01(Number.isFinite(raw) ? raw : 0.5));
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

async function modelSemanticPath(agent: AgentProfile, from: string, to: string): Promise<SemanticPath> {
  const openrouter = getOpenRouter();
  if (!openrouter) throw new Error("OPENROUTER_API_KEY not configured");
  const spec = modelSpec(agent.model);
  const completion = await withTimeout(
    openrouter.chat.completions.create({
      model: agent.model,
      messages: buildMessages(from, to),
      temperature: spec.temperature,
      max_tokens: 700,
      response_format: { type: "json_object" },
    }),
    TIMEOUT_MS,
  );
  const content = completion.choices[0]?.message?.content ?? "";
  if (!content) throw new Error("empty reply");
  const obj = extractJson(content);
  let anchors = asStrings(obj.path ?? obj.anchors ?? obj.semantic_path);
  if (anchors.length < 2) anchors = [from, to];
  anchors[0] = from;
  anchors[anchors.length - 1] = to;
  return {
    anchors,
    entropy: asNums(obj.entropy ?? obj.entropy_profile, anchors.length),
    confidence: asNums(obj.confidence ?? obj.confidence_profile, anchors.length),
  };
}

/** Deterministic fallback path (no model) — system never breaks without a key. */
function syntheticSemanticPath(agent: AgentProfile, from: string, to: string): SemanticPath {
  const seed = hashStr(`${agent.id}|${from}->${to}`) >>> 0;
  const rng = makeRng(seed);
  const n = TARGET_STEPS;
  const anchors: string[] = [];
  const entropy: number[] = [];
  const confidence: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    anchors.push(i === 0 ? from : i === n - 1 ? to : CONCEPT_BANK[Math.floor(rng() * CONCEPT_BANK.length)]);
    const hump = Math.sin(t * Math.PI);
    entropy.push(clamp01(0.2 + hump * 0.4 + (rng() - 0.5) * 0.25));
    confidence.push(clamp01(0.3 + t * 0.45 + (rng() - 0.5) * 0.2));
  }
  return { anchors, entropy, confidence };
}

/**
 * SEMANTIC PATH RESTRUCTURING (mood-driven). Resamples the base semantic path to
 * `depth` anchors: subsampling when the path is too long, and inserting DETOUR
 * concepts (frequency set by mood) when expanding. Scalars are interpolated to
 * match. So a different mood changes the number of intermediate anchors + the
 * detour density → a structurally different semantic trajectory.
 */
function restructureSemantic(sem: SemanticPath, depth: number, mood: Mood, seed: number): SemanticPath {
  const src = sem.anchors;
  if (src.length === depth && depth >= 2) return sem;
  const rng = makeRng((seed ^ 0x5e3adef) >>> 0);
  const detourFreq = Math.min(0.85, mood.motion_variation * 0.5 + Math.abs(mood.entropy_shift) * 0.4);
  const expanding = depth > src.length;

  const anchors: string[] = [];
  const entropy: number[] = [];
  const confidence: number[] = [];
  const sE = (i: number) => sem.entropy[i] ?? 0.5;
  const sC = (i: number) => sem.confidence[i] ?? 0.5;

  for (let i = 0; i < depth; i++) {
    if (i === 0) { anchors.push(src[0]); entropy.push(sE(0)); confidence.push(sC(0)); continue; }
    if (i === depth - 1) {
      anchors.push(src[src.length - 1]);
      entropy.push(sE(src.length - 1));
      confidence.push(sC(src.length - 1));
      continue;
    }
    const t = i / (depth - 1);
    const srcPos = t * (src.length - 1);
    const lo = Math.floor(srcPos);
    const hi = Math.min(src.length - 1, lo + 1);
    const f = srcPos - lo;
    const useDetour = expanding && rng() < detourFreq;
    anchors.push(useDetour ? CONCEPT_BANK[Math.floor(rng() * CONCEPT_BANK.length)] : (src[Math.round(srcPos)] ?? `t${i}`));
    entropy.push(clamp01(sE(lo) * (1 - f) + sE(hi) * f + (useDetour ? 0.12 : 0)));
    confidence.push(clamp01(sC(lo) * (1 - f) + sC(hi) * f));
  }
  return { anchors, entropy, confidence };
}

// ---- projection — stroke reflects the agent's ECONOMIC FUNCTION -------------

function strokeWidth(entropy: number, intensity: number, confidence: number): number {
  const base = 0.3 * (1 - entropy) + 0.4 * intensity + 0.3 * confidence;
  return Math.max(0.5, Math.min(6, 0.5 + base * 5.5));
}

/** Stable identity seed for an agent + A→B pair (mood-independent). */
function baseSeed(agentId: string, from: string, to: string): number {
  return hashStr(`${agentId}|${from}|${to}`) >>> 0;
}

/**
 * Realize a semantic path as a STRUCTURALLY mood-determined stroke. The mood
 * selects a geometry mode, a branching model, and a motion model (and earlier,
 * the semantic depth); those choices — not just colour — define the path shape,
 * branch topology, and movement. base_seed fixes identity; the variation seed
 * (which folds in the full mood) makes every structural draw evolve over time.
 */
function project(
  agent: AgentProfile,
  sem: SemanticPath,
  from: string,
  to: string,
  model: string,
  base_seed: number,
  mood: Mood,
  timestamp: number,
  seed: number,
  previous?: TransitionPath,
): TransitionPath {
  const anchors = sem.anchors;
  const n = anchors.length;
  const profile = categoryStrokeProfile(agent.category);
  const rng = makeRng(seed);

  // ---- mood selects the STRUCTURE (not appearance) ----
  // Adjacent-generation contrast is a hard constraint. Mood still proposes
  // each mode, but a direct repeat is deterministically redirected to another
  // valid mode rather than being allowed to produce the same visual grammar.
  const geometry_mode = avoidPrevious(selectGeometryMode(mood, seed), previous?.geometry_mode, GEOMETRY_MODES, seed ^ 0x6e0a);
  const branching_model = avoidPrevious(selectBranchingModel(mood, seed), previous?.branching_model, BRANCHING_MODES, seed ^ 0x1b7a);
  const motion_model = avoidPrevious(selectMotionModel(mood, seed), previous?.motion_model, MOTION_MODELS, seed ^ 0x4c0d);

  // each agent occupies its own latent region (stable per id); the exact
  // start/end within it shift per bucket via the variation seed.
  const region = agentRegion(agent.id);
  const start = { x: 0.12 + region * 0.2, y: 0.2 + rng() * 0.6 };
  const end = { x: 0.7 + rng() * 0.18, y: 0.2 + rng() * 0.6 };

  // 1. PATH GEOMETRY — the selected mode constructs the actual point shape.
  const geo = buildGeometryPath(geometry_mode, { start, end, count: n, seed, mood });
  // directional bias / spatial drift applied across ALL modes (mood item #1).
  const driftAng = mood.drift_bias * Math.PI;
  const drift = { x: Math.cos(driftAng), y: Math.sin(driftAng) };
  const driftMag = Math.abs(mood.drift_bias) * 0.18;

  // 2. BRANCHING TOPOLOGY — the selected model lays out branch counts per anchor.
  const branches = assignBranches(branching_model, { count: n, seed, mood });

  // 3. MOTION — the selected model sets the temporal pacing multiplier per anchor.
  const pacing = motionPacing(motion_model, n, seed);

  // scalar fields still reflect the agent's economic function + the mood energy.
  const eEnergy = Math.abs(mood.entropy_shift);
  const volatility = profile.volatility + eEnergy * 0.4;
  const widthVariance = 0.1 + eEnergy * 0.6;

  const points: TransitionPoint[] = geo.map((pos, step) => {
    const t = n > 1 ? step / (n - 1) : 0;
    const baseE = sem.entropy[step] ?? 0.5;

    const x = clamp01(pos.x + drift.x * driftMag * t);
    const y = clamp01(pos.y + drift.y * driftMag * t);

    let entropy = baseE * profile.entropyScale;
    if (profile.oscillate > 0) entropy += profile.oscillate * Math.sin(t * Math.PI * 4) * (1 - t) * 0.5;
    if (profile.converge > 0) entropy *= 1 - profile.converge * t * 0.6;
    entropy += mood.entropy_shift * 0.22;
    entropy += (rng() - 0.5) * volatility;
    entropy = clamp01(entropy);

    let confidence = sem.confidence[step] ?? 0.5;
    if (profile.converge > 0) confidence = confidence + profile.converge * t * 0.3;
    confidence = clamp01(confidence);

    const intensity = clamp01(0.25 + confidence * 0.5 + (1 - entropy) * 0.25);

    // branch topology comes from the selected branching model (not probability).
    const branch = branches[step] ?? 0;

    const duration_ms = Math.round((120 + entropy * 380) * (1.4 - profile.style.speedFactor) * pacing[step]);

    const widthBase = strokeWidth(entropy, intensity, confidence);
    const stroke_width = Math.max(0.5, Math.min(6, widthBase * (1 + (rng() - 0.5) * widthVariance)));

    return {
      step,
      anchor: anchors[step] ?? `t${step}`,
      x,
      y,
      entropy,
      confidence,
      intensity,
      stroke_width,
      branch,
      duration_ms,
    };
  });
  const visual_signature = createVisualSignature({
    points,
    mood,
    baseHue: profile.style.hue,
    // Palettes and pressure profiles must vary per creation. Using base_seed
    // here made repeated A→B generations silently reuse those attributes.
    seed,
    geometryMode: geometry_mode,
    motionModel: motion_model,
  });

  return {
    id: `stroke-${timestamp}-${agent.id}`,
    agent_id: agent.id,
    from,
    to,
    motion_type: GEOMETRY_TO_MOTION[geometry_mode],
    created_at: timestamp,
    timestamp,
    points,
    model,
    base_seed,
    variation_seed: seed,
    mood,
    geometry_mode,
    branching_model,
    motion_model,
    semantic_depth: n,
    visual_signature,
  };
}

/**
 * Generate one A→B stroke for an agent at a moment in time.
 *
 *   stroke = generate(agent, from, to, mood(timestamp, agent, from, to, seed))
 *
 * The agent's real model performs the (stable) semantic transform; base_seed
 * fixes the stroke's identity; the CONTINUOUS mood — unique for every timestamp
 * — selects the geometry / branching / motion / semantic structure, so the SAME
 * agent + A→B is structurally different at every distinct moment. Falls back to
 * a deterministic synthetic path when no model key is configured.
 */
export async function generateStroke(
  agent: AgentProfile,
  from: string,
  to: string,
  timestamp: number = Date.now(),
  previous?: TransitionPath,
): Promise<TransitionPath> {
  // base_seed = the stable identity = the stroke_seed fed into the mood context.
  const base_seed = baseSeed(agent.id, from, to);
  // CONTINUOUS mood: unique per timestamp, derived from the full context.
  let baseSem: SemanticPath;
  try {
    baseSem = await modelSemanticPath(agent, from, to);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[strokegen] ${agent.model} failed, using synthetic path:`, err instanceof Error ? err.message : err);
    }
    baseSem = syntheticSemanticPath(agent, from, to);
  }

  const family = (stroke: TransitionPath) => {
    const signature = stroke.visual_signature;
    if (!signature) return "legacy";
    if (signature.crossings > 0) return "woven";
    if (signature.reversal_count > 0) return "hairpin";
    return `open:${stroke.geometry_mode ?? "unknown"}`;
  };
  const directionSector = (stroke: TransitionPath) => Math.floor((stroke.visual_signature?.direction_angle_deg ?? 0) / 45) % 8;
  const widthTier = (stroke: TransitionPath) => {
    const count = stroke.visual_signature?.width_change_count ?? 0;
    return count === 0 ? 0 : count <= 3 ? 1 : 2;
  };
  const visualDifferenceScore = (candidate: TransitionPath) => {
    if (!previous?.visual_signature || !candidate.visual_signature) return 99;
    const a = candidate.visual_signature;
    const b = previous.visual_signature;
    return [
      family(candidate) !== family(previous),
      a.brush_style !== b.brush_style,
      a.length_class !== b.length_class,
      a.crossings !== b.crossings,
      a.reversal_count !== b.reversal_count,
      a.turn_count !== b.turn_count,
      widthTier(candidate) !== widthTier(previous),
      a.color_count !== b.color_count,
      directionSector(candidate) !== directionSector(previous),
    ].filter(Boolean).length;
  };

  // The model is called once. Candidate resampling below is local and cheap:
  // it varies mood, semantic restructuring and every derived visual attribute.
  let best: TransitionPath | null = null;
  let bestScore = -1;
  for (let attempt = 0; attempt < 72; attempt++) {
    const candidateTimestamp = timestamp + attempt;
    const mood = generateMood(candidateTimestamp, agent.id, from, to, base_seed);
    const seed = strokeVariationSeed(agent.id, from, to, candidateTimestamp, mood);
    let depth = selectSemanticDepth(mood, seed);
    if (previous?.semantic_depth === depth) depth = 4 + ((depth - 3 + (seed % 9)) % 10);
    const sem = restructureSemantic(baseSem, depth, mood, seed);
    const candidate = project(agent, sem, from, to, agent.model, base_seed, mood, candidateTimestamp, seed, previous);
    const score = visualDifferenceScore(candidate);
    if (score > bestScore) { best = candidate; bestScore = score; }
    // All nine visible families differ, while the three structural modes and
    // semantic depth are already individually protected inside this candidate.
    if (score === 9) return candidate;
  }

  // Structural modes, depth and all seeded continuous profiles are guaranteed
  // distinct even in the vanishingly unlikely event that every categorical
  // facet cannot differ simultaneously because of a physical length gate.
  return best!;
}
