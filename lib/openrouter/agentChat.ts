// ============================================================================
// Agent Chat — identity introspection interface (NOT a generic chatbot).
// ----------------------------------------------------------------------------
// An agent answers questions about ITSELF: its identity, cognitive style, the
// way it generates strokes, and the A→B semantic transitions it favours. Powers
// POST /api/agentChat. Falls back to a deterministic on-theme reply when
// OpenRouter is unavailable so the panel never dies.
// ============================================================================

import type { AgentProfile, TransitionPath } from "@/lib/types";

export interface ChatTurn {
  role: "user" | "agent";
  text: string;
}

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Compact, identity-grounded context the agent reasons about. */
export interface AgentChatContext {
  recent_transitions: string[]; // e.g. "chaos → order"
  stroke_count: number;
}

/** Summarize an agent's recent strokes into A→B transition lines. */
export function buildChatContext(strokes: TransitionPath[]): AgentChatContext {
  return {
    recent_transitions: strokes.slice(-5).map((s) => `${s.from} → ${s.to}`),
    stroke_count: strokes.length,
  };
}

/** Assemble the system/user/history prompt for an economic-function reply. */
export function buildChatMessages(
  agent: AgentProfile,
  ctx: AgentChatContext,
  message: string,
  history: ChatTurn[] = [],
): ChatCompletionMessage[] {
  const system = [
    `You are ${agent.name}, a ${agent.occupation} — an economic production unit in a simulated AI economy.`,
    "You are NOT an abstract thinker and NOT a general assistant. Answer ONLY as this agent,",
    "grounded in your ECONOMIC FUNCTION. You exist to produce real economic value. You also",
    "generate A→B strokes whose shape reflects your economic function. Speak in the first",
    "person, stay in character, and keep answers concise.",
    "",
    "=== YOUR ECONOMIC IDENTITY ===",
    `category: ${agent.category}`,
    `economic_function: ${agent.economic_function}`,
    `real_world_mapping: ${agent.real_world_mapping}`,
    `task_domain: ${agent.task_domain}`,
    `revenue_impact: ${agent.revenue_impact}`,
    `model: ${agent.model} (${agent.model_type})`,
    "",
    "=== YOUR RECENT STROKE RESULTS ===",
    ctx.recent_transitions.length
      ? ctx.recent_transitions.map((t) => `  - ${t}`).join("\n")
      : "  (none yet)",
    `total strokes generated: ${ctx.stroke_count}`,
  ].join("\n");

  const messages: ChatCompletionMessage[] = [{ role: "system", content: system }];
  for (const t of history) messages.push({ role: t.role === "user" ? "user" : "assistant", content: t.text });
  messages.push({ role: "user", content: message });
  return messages;
}

/** Deterministic, on-theme fallback when OpenRouter is unavailable. */
export function syntheticChatReply(agent: AgentProfile, ctx: AgentChatContext, message: string): string {
  const q = message.toLowerCase();
  const recent = ctx.recent_transitions[ctx.recent_transitions.length - 1];
  if (/who are you|economic function|what do you do|purpose|introduce/.test(q)) {
    return `I am ${agent.name}, the ${agent.occupation}. My economic function: ${agent.economic_function}. I map to a ${agent.real_world_mapping} in the real world.`;
  }
  if (/revenue|profit|money|impact|value/.test(q)) {
    return `My revenue impact is "${agent.revenue_impact}". I operate in ${agent.task_domain} to ${agent.economic_function.toLowerCase()}.`;
  }
  if (/domain|market|operate|where/.test(q)) {
    return `My task domain is ${agent.task_domain}. As a ${agent.category} agent I act like a ${agent.real_world_mapping}.`;
  }
  if (/stroke|transition|path|a to b|generate/.test(q)) {
    return `I move from a concept A to a concept B in a way that reflects my work as a ${agent.category} agent.${recent ? ` Most recently I produced ${recent}.` : ""}`;
  }
  return `I am ${agent.name}, the ${agent.occupation} — ${agent.economic_function}. Ask about my economic function, domain, or revenue impact.`;
}
