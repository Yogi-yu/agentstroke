// ============================================================================
// POST /api/agentChat — agent identity chat (introspection interface).
// ----------------------------------------------------------------------------
// Input:  { agent_id, message, history? }
// The agent answers about its own identity, cognitive style and A→B stroke
// behavior via its bound OpenRouter model. Caches repeated questions per agent;
// trims history to the last 10 turns; falls back to a deterministic on-theme
// reply when OpenRouter is unavailable.
// Output: { agent_id, response, model, timestamp }
// ============================================================================

import { NextResponse } from "next/server";
import { getAgent, strokesForAgent } from "@/lib/store";
import { getOpenRouter } from "@/lib/openrouter/client";
import { modelSpec } from "@/lib/openrouter/models";
import {
  buildChatContext,
  buildChatMessages,
  syntheticChatReply,
  type ChatTurn,
} from "@/lib/openrouter/agentChat";
import { chatCacheKey, getCachedChat, setCachedChat } from "@/lib/openrouter/chatCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_HISTORY = 10;
const TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`chat timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const agent_id = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!agent_id) return NextResponse.json({ error: "agent_id is required" }, { status: 400 });
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  const agent = getAgent(agent_id);
  if (!agent) return NextResponse.json({ error: `unknown agent: ${agent_id}` }, { status: 404 });

  const history = Array.isArray(body.history)
    ? (body.history as unknown[])
        .filter(
          (t): t is ChatTurn =>
            !!t && typeof t === "object" &&
            (((t as ChatTurn).role === "user") || ((t as ChatTurn).role === "agent")) &&
            typeof (t as ChatTurn).text === "string",
        )
        .slice(-MAX_HISTORY)
    : [];

  const ctx = buildChatContext(strokesForAgent(agent_id));

  // cache repeated questions per agent
  const key = chatCacheKey(agent_id, message);
  const cached = getCachedChat(key);
  if (cached) {
    return NextResponse.json({
      agent_id,
      response: cached.response,
      model: cached.model,
      timestamp: cached.timestamp,
      cached: true,
      source: cached.source,
    });
  }

  let response: string;
  let source: "model" | "fallback";
  const openrouter = getOpenRouter();
  if (openrouter) {
    try {
      const spec = modelSpec(agent.model);
      const completion = await withTimeout(
        openrouter.chat.completions.create({
          model: agent.model,
          messages: buildChatMessages(agent, ctx, message, history),
          temperature: Math.min(spec.temperature, 0.8),
          max_tokens: 500,
        }),
        TIMEOUT_MS,
      );
      const content = completion.choices[0]?.message?.content?.trim() ?? "";
      if (!content) throw new Error("empty model reply");
      response = content;
      source = "model";
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[agentChat] ${agent.model} failed, using fallback:`, err instanceof Error ? err.message : err);
      }
      response = syntheticChatReply(agent, ctx, message);
      source = "fallback";
    }
  } else {
    response = syntheticChatReply(agent, ctx, message);
    source = "fallback";
  }

  const timestamp = Date.now();
  setCachedChat(key, { response, model: agent.model, timestamp, source });
  return NextResponse.json({ agent_id, response, model: agent.model, timestamp, cached: false, source });
}
