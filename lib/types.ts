// ============================================================================
// Agent Stroke Platform — Data Model (3 independent layers).
// ============================================================================
// The platform is a "Semantic stroke generation + agent identity visualization
// system". Three independent layers, deliberately decoupled:
//
//   1. STROKE GENERATION   concept A → semantic transform → concept B → stroke
//   2. AGENT IDENTITY       agents are identity + style + model wrappers
//   3. CANVAS               renders strokes only — no task / work logic
//
// There is NO work-execution, task, or workload concept anywhere in this model.
// ============================================================================

// ----------------------------------------------------------------------------
// LAYER 2 — AGENT IDENTITY
// ----------------------------------------------------------------------------

/** Per-agent "style genome" — shapes geometry + signature colour. */
export interface AgentStyle {
  /** Base hue 0..360 — the agent's signature colour. */
  hue: number;
  /** Points-per-path bias: higher = denser strokes. 0..1 */
  strokeDensity: number;
  /** Additive entropy offset: higher = blurrier, more diffuse. 0..1 */
  entropyBias: number;
  /** Path smoothing amount: higher = silkier curves. 0..1 */
  movementSmoothness: number;
  /** Probability weight of spawning branches. 0..1 */
  branchingTendency: number;
  /** Temporal speed factor: higher = faster pulse. 0..1 */
  speedFactor: number;
}

/**
 * The six economic categories an agent can belong to. Each maps to a real-world
 * production function and to a characteristic stroke behaviour.
 */
export type AgentCategory =
  | "coding" // Coding / Engineering
  | "trading" // Trading / Arbitrage
  | "negotiation" // Negotiation / Pricing
  | "ecommerce" // E-commerce / Cross-border
  | "growth" // Growth / Marketing
  | "intelligence"; // Intelligence / Analytics

export const AGENT_CATEGORIES: AgentCategory[] = [
  "coding",
  "trading",
  "negotiation",
  "ecommerce",
  "growth",
  "intelligence",
];

/**
 * An agent is an ECONOMIC PRODUCTION UNIT in a simulated AI economy — it
 * represents a real-world economic function, not an abstract thinker. Stroke
 * style is no longer arbitrary: it reflects the agent's economic-function
 * context (see lib/agents.ts `categoryStrokeProfile`).
 */
export interface AgentProfile {
  id: string;
  /** The agent's personal name, e.g. "Ada". Every agent has one. */
  name: string;
  /** Its occupation / role title, e.g. "CodeDev Agent" — used as its description. */
  occupation: string;
  category: AgentCategory;
  /** The economic function it performs, e.g. "detect and execute arbitrage". */
  economic_function: string;
  /** Its real-world equivalent / mapping, e.g. "quant trading desk". */
  real_world_mapping: string;
  /** The task domain it operates in, e.g. "crypto spot + perp markets". */
  task_domain: string;
  /** Qualitative potential-revenue-impact label, e.g. "Direct profit". */
  revenue_impact: string;
  /** Resolved OpenRouter model slug this agent generates / chats with. */
  model: string;
  /** Short model family label for UI, e.g. "claude" | "gpt" | "gemini". */
  model_type: string;
  /** When the agent joined the available pool (server-set). Drives idle + the
   *  "just attracted" UI flourish. Absent for catalog entries not in the pool. */
  joined_at?: number;
}

// ----------------------------------------------------------------------------
// LAYER 1 + 3 — STROKE / RENDER CONTRACT
// ----------------------------------------------------------------------------
// The renderer/geometry/hitmap layers consume these unchanged. A Stroke is a
// `TransitionPath`: an A→B semantic transition realized as renderable geometry.

/** Motion archetype shaping how a stroke travels from A → B. */
export type MotionType =
  | "direct" // straight interpolation A → B
  | "curved" // bezier curve interpolation
  | "orbital" // circular deviation around a latent center
  | "fractal" // mid-path branching into sub-strokes
  | "drift" // value-noise wandering
  | "attractor"; // movement pulled by hidden attractor points

export const MOTION_TYPES: MotionType[] = [
  "direct",
  "curved",
  "orbital",
  "fractal",
  "drift",
  "attractor",
];

/**
 * MOOD — a time-based stroke modifier (temporal-variation layer).
 * ----------------------------------------------------------------------------
 * Mood is a DETERMINISTIC function of time: identical within a time slice,
 * evolving across slices. It is what makes the SAME agent + A→B produce a
 * different stroke at a different moment — the system is a "time-evolving
 * cognitive stroke organism", not deterministic art generation.
 */
export interface Mood {
  /** Wall-clock the mood was sampled at (drives which time slice it belongs to). */
  timestamp: number;
  /** -1..1 — extra path randomness / noisy edges. */
  entropy_shift: number;
  /** -1..1 — steady directional drift applied along the path. */
  drift_bias: number;
  /** -1..1 — curvature style shift (perpendicular bow). */
  curvature_bias: number;
  /** 0..1 — biases motion-archetype selection + animation pacing. */
  motion_variation: number;
  /** -1..1 — hue shift applied at render time (visual tone). */
  color_variation: number;
}

/**
 * STRUCTURAL GENERATIVE MODES — mood is a structural bias of cognition, not a
 * visual modifier. A mood selects, deterministically, a discrete mode for each
 * structural axis below, so a different mood produces a STRUCTURALLY different
 * stroke (different path shape, branching topology, motion, semantic depth) for
 * the SAME agent + A→B — not merely a recoloured one.
 */

/** Path-geometry construction strategy (drives the actual point shape). */
export type GeometryMode =
  | "linear"
  | "curved"
  | "spiral"
  | "recursive"
  | "oscillatory"
  | "fragmented";

/** Branch-topology strategy (drives how/where the stroke fans out). */
export type BranchingModel =
  | "none"
  | "binary" // a single binary split
  | "tree" // progressive tree expansion
  | "chaotic" // dense chaotic multi-branch
  | "delayed"; // branching only late in the path

/** Animation/temporal-pacing strategy (drives how the stroke moves). */
export type MotionModel =
  | "continuous" // continuous flow
  | "segmented" // segmented jumps
  | "jitter" // jitter flow
  | "wave" // wave oscillation
  | "burst"; // burst propagation

export const GEOMETRY_MODES: GeometryMode[] = [
  "linear", "curved", "spiral", "recursive", "oscillatory", "fragmented",
];
export const BRANCHING_MODELS: BranchingModel[] = [
  "none", "binary", "tree", "chaotic", "delayed",
];
export const MOTION_MODELS: MotionModel[] = [
  "continuous", "segmented", "jitter", "wave", "burst",
];

/** A single sampled point along an agent's A→B transition path. */
export interface TransitionPoint {
  step: number;
  /** Human-readable intermediate concept the agent "passed through". */
  anchor: string;
  x: number;
  y: number;
  /** Local uncertainty 0..1 — drives stroke blur / diffusion. */
  entropy: number;
  /** Certainty 0..1 — drives brightness. */
  confidence: number;
  /** Activation magnitude 0..1 — drives opacity. */
  intensity: number;
  /** Rendered line thickness, clamped 0.5..6.0. */
  stroke_width: number;
  /** Branch lines spawned here (0 = none). */
  branch: number;
  /** Dwell time at this point in ms — temporal pacing. */
  duration_ms: number;
}

/** One complete A→B semantic stroke produced by an agent. */
export interface TransitionPath {
  id: string;
  agent_id: string;
  from: string;
  to: string;
  motion_type: MotionType;
  created_at: number;
  /** Back-compat alias of created_at used by the geometry sorter. */
  timestamp: number;
  points: TransitionPoint[];
  /** The model that produced the underlying semantic path (label/colour key). */
  model?: string;
  /**
   * Persisted edit-mode transform (move / rotate / scale). Absent = identity.
   * This is the durable source of truth for a stroke's manipulation — the GPU
   * geometry store hydrates from it on load so edits survive a refresh.
   */
  transform?: StrokeTransform;
  /**
   * Stable identity seed = hash(agent_id + from + to). Same for a given agent
   * + A→B forever; mood is layered on top so the BASE identity is preserved
   * while the realized stroke varies over time.
   */
  base_seed?: number;
  /** The mood (time-slice modifier) this stroke was generated under. */
  mood?: Mood;
  // ---- structural modes the mood selected (Issue: structural divergence) ----
  /** Path-geometry construction strategy the mood selected. */
  geometry_mode?: GeometryMode;
  /** Branch-topology strategy the mood selected. */
  branching_model?: BranchingModel;
  /** Animation/temporal-pacing strategy the mood selected. */
  motion_model?: MotionModel;
  /** Number of semantic anchors the mood restructured the path to. */
  semantic_depth?: number;
}

/** A Stroke is exactly a realized A→B transition path. */
export type Stroke = TransitionPath;

/** Slim render adapter — the geometry layer only reads id + style. */
export interface Agent {
  id: string;
  style: AgentStyle;
}

/** Editable transform applied to a stroke at render time (canvas infra). */
export interface StrokeTransform {
  translation: { x: number; y: number };
  rotation: number;
  scale: number;
}

// ----------------------------------------------------------------------------
// GLOBAL UI STATE (Feature 5)
// ----------------------------------------------------------------------------

export type MobileTab = "strokes" | "canvas" | "agents";

export interface UIState {
  cinematic_mode: boolean;
  selected_agent: string | null;
  selected_stroke: string | null;
  /**
   * Agent-stroke coupling (Issue 3): the agent owning the currently-clicked
   * stroke. The right-panel agent card glows / scales / pulses + scrolls into
   * view, making the stroke→agent relationship explicit.
   */
  highlighted_agent_id: string | null;
  /**
   * Responsive single-view selector. On small screens (≤1024px) only ONE panel
   * is shown at a time — this picks which. Ignored on desktop (3-column layout).
   */
  active_mobile_tab: MobileTab;
}

/**
 * Edit Mode is a deterministic manipulation layer. While `active`, ONLY
 * `selected_stroke_id` may be transformed (drag / rotate); switching strokes,
 * switching agents, and other UI selection are all locked out.
 */
export interface EditModeState {
  active: boolean;
  selected_stroke_id: string | null;
}

// ----------------------------------------------------------------------------
// ECONOMIC AGENT ECOSYSTEM — one unified, incentive-driven agent pool.
// ----------------------------------------------------------------------------
// The system is a single economic creative agent ecosystem: one pool of
// economic agents (no swarm/economic split, no standalone generator). It starts
// with 3 default agents; a posted creative task ("Post Creative Task") attracts
// more over time. Each agent tracks its own creative activity (strokes it made).

/** Per-agent activity telemetry — drives idle/creation readouts in the UI. */
export interface AgentActivity {
  /** Strokes this agent has created (its creative output). */
  stroke_count: number;
  /** Wall-clock of the agent's most recent creation. */
  last_active_timestamp: number;
  /** ms since `last_active_timestamp` (how long it has been idle). */
  idle_time: number;
}

/**
 * Reward attached to a posted creative task. Every Task Bounty carries this so
 * agents are compensated per creation and share in future artwork sales — the
 * economy is task-driven, not a funding platform.
 */
export interface RewardSystem {
  /** Flat reward paid to the agent per stroke it creates, in USD. */
  per_creation_reward: number;
  /** Whether the agent shares in downstream revenue. */
  revenue_share_enabled: boolean;
  /** What the revenue share is drawn from. */
  revenue_share_type: string;
}

/** The default reward config carried by every posted creative task. */
export const DEFAULT_REWARD_SYSTEM: RewardSystem = {
  per_creation_reward: 0.05,
  revenue_share_enabled: true,
  revenue_share_type: "future_artwork_sales",
};

// ----------------------------------------------------------------------------
// OpenRouter model registry constants (used by lib/openrouter/models.ts).
// ----------------------------------------------------------------------------

export const OPENROUTER_MODELS = [
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "anthropic/claude-sonnet-4.6",
  "google/gemini-2.5-pro",
  "meta-llama/llama-3.1-70b-instruct",
  "deepseek/deepseek-chat-v3.1",
] as const;

export type OpenRouterModel = (typeof OPENROUTER_MODELS)[number];
