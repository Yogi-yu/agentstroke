// ============================================================================
// OpenRouter client (Requirement #4) — OpenAI SDK in compat mode.
// ----------------------------------------------------------------------------
// OpenRouter exposes an OpenAI-compatible API, so we drive it with the official
// `openai` SDK pointed at OpenRouter's baseURL with the required headers.
//
//   Authorization: Bearer <OPENROUTER_API_KEY>   (set by the SDK from apiKey)
//   HTTP-Referer:  <site url>                      (attribution)
//   X-Title:       Noema · Agent Snapshot
//
// Returns null when no API key is configured, so callers transparently fall back
// to the synthetic engine (Requirement #6 — never break the system).
// ============================================================================

import OpenAI from "openai";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

let client: OpenAI | null = null;

export function getOpenRouter(): OpenAI | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  if (!client) {
    client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://agent-stroke.local",
        "X-Title": "Noema · Agent Snapshot",
      },
    });
  }
  return client;
}

export function hasOpenRouterKey(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}
