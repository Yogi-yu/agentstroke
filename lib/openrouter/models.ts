// ============================================================================
// Model Registry — the 10 supported OpenRouter models + their "species" persona.
// ----------------------------------------------------------------------------
// Each model is a different "thinking species": its `persona` text is injected
// into the system prompt (Requirement #7 — behavior differentiation) and its
// `temperature` shapes the decoding personality. `family` is used by the router.
// ============================================================================

import type { OpenRouterModel } from "@/lib/types";
import { OPENROUTER_MODELS } from "@/lib/types";

export type ModelFamily =
  | "gpt"
  | "claude"
  | "gemini"
  | "llama"
  | "qwen"
  | "mistral"
  | "mixtral"
  | "deepseek";

export interface ModelSpec {
  id: OpenRouterModel;
  family: ModelFamily;
  /** Short human label for UI / logs. */
  label: string;
  /** Decoding personality — higher = more divergent / jumpy paths. */
  temperature: number;
  /**
   * Behavior fingerprint injected into the system prompt. Encodes how this
   * species *thinks* its way from A → B (chain length, smoothness, noise).
   */
  persona: string;
}

export const MODEL_SPECS: Record<OpenRouterModel, ModelSpec> = {
  "openai/gpt-4o-mini": {
    id: "openai/gpt-4o-mini",
    family: "gpt",
    label: "GPT-4o mini",
    temperature: 0.4,
    persona: "Executes work in structured, efficient steps with clean reasoning.",
  },
  "openai/gpt-4o": {
    id: "openai/gpt-4o",
    family: "gpt",
    label: "GPT-4o",
    temperature: 0.4,
    persona: "Executes work in structured, deliberate steps; each step earns its place.",
  },
  "anthropic/claude-sonnet-4.6": {
    id: "anthropic/claude-sonnet-4.6",
    family: "claude",
    label: "Claude Sonnet 4.6",
    temperature: 0.6,
    persona: "Executes work in long, well-connected reasoning chains with high continuity.",
  },
  "google/gemini-2.5-pro": {
    id: "google/gemini-2.5-pro",
    family: "gemini",
    label: "Gemini 2.5 Pro",
    temperature: 0.7,
    persona: "Executes work by exploring broadly before converging on a result.",
  },
  "meta-llama/llama-3.1-70b-instruct": {
    id: "meta-llama/llama-3.1-70b-instruct",
    family: "llama",
    label: "Llama 3.1 70B",
    temperature: 0.7,
    persona: "Executes work through exploratory, branching investigation.",
  },
  "deepseek/deepseek-chat-v3.1": {
    id: "deepseek/deepseek-chat-v3.1",
    family: "deepseek",
    label: "DeepSeek V3.1",
    temperature: 0.4,
    persona: "Executes work by decomposing it into ordered, deductive sub-steps.",
  },
};

export const SUPPORTED_MODELS: OpenRouterModel[] = [...OPENROUTER_MODELS];

// --- family inference + defaults (robust to any slug, e.g. gpt-4o-mini) -------

/** Infer the species family from any model slug. */
export function familyOf(id: string): ModelFamily {
  const s = id.toLowerCase();
  if (s.includes("mixtral")) return "mixtral";
  if (s.includes("mistral")) return "mistral";
  if (s.includes("gpt") || s.includes("openai") || s.includes("o1") || s.includes("o3")) return "gpt";
  if (s.includes("claude") || s.includes("anthropic")) return "claude";
  if (s.includes("gemini") || s.includes("google")) return "gemini";
  if (s.includes("llama") || s.includes("meta")) return "llama";
  if (s.includes("qwen")) return "qwen";
  if (s.includes("deepseek")) return "deepseek";
  return "gpt";
}

const FAMILY_DEFAULTS: Record<ModelFamily, { temperature: number; persona: string }> = {
  gpt: { temperature: 0.4, persona: MODEL_SPECS["openai/gpt-4o"].persona },
  claude: { temperature: 0.6, persona: MODEL_SPECS["anthropic/claude-sonnet-4.6"].persona },
  gemini: { temperature: 0.7, persona: MODEL_SPECS["google/gemini-2.5-pro"].persona },
  llama: { temperature: 0.7, persona: MODEL_SPECS["meta-llama/llama-3.1-70b-instruct"].persona },
  qwen: { temperature: 0.6, persona: "Executes work through cultural and linguistic associations." },
  mistral: { temperature: 0.6, persona: "Executes work in balanced, contrastive steps." },
  mixtral: { temperature: 0.9, persona: "Executes work in divergent, recombinant bursts." },
  deepseek: { temperature: 0.4, persona: MODEL_SPECS["deepseek/deepseek-chat-v3.1"].persona },
};

/** Signature hue per family — drives stroke color (Requirement: color by model). */
export const FAMILY_HUE: Record<ModelFamily, number> = {
  gpt: 210, // blue
  claude: 280, // purple
  gemini: 140, // green
  llama: 30, // orange
  deepseek: 350, // red
  qwen: 50, // amber
  mistral: 190, // cyan
  mixtral: 320, // magenta
};

/** Hue 0..360 for any model slug, derived from its family. */
export function modelHue(id: string): number {
  return FAMILY_HUE[familyOf(id)];
}

/** Resolve a full spec for any slug; registered models use their curated spec,
 *  unknown-but-valid slugs (e.g. gpt-4o-mini) get a family-derived spec. */
export function modelSpec(id: string): ModelSpec {
  const known = (MODEL_SPECS as Record<string, ModelSpec>)[id];
  if (known) return known;
  const family = familyOf(id);
  const d = FAMILY_DEFAULTS[family];
  return { id: id as OpenRouterModel, family, label: id, temperature: d.temperature, persona: d.persona };
}

export function isSupportedModel(id: string): id is OpenRouterModel {
  return id in MODEL_SPECS;
}
