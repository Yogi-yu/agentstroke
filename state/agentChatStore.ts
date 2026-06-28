// ============================================================================
// agentChatStore (client) — per-agent chat state for AgentChatPanel.
// ----------------------------------------------------------------------------
// Holds the conversation per agent (so navigating between agents keeps each
// thread), caches repeated questions, and trims sent history to the last 10
// turns. Mirrors the codebase's external-store pattern.
// ============================================================================

import { useSyncExternalStore } from "react";

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  model?: string;
  timestamp: number;
  pending?: boolean;
  error?: boolean;
}

export interface AgentChatState {
  messages: ChatMessage[];
  loading: boolean;
  active_agent_id: string;
}

const EMPTY_STATE: AgentChatState = Object.freeze({ messages: [], loading: false, active_agent_id: "" });
const HISTORY_LIMIT = 10;

type Listener = () => void;

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

interface PerAgent {
  messages: ChatMessage[];
  loading: boolean;
}

class AgentChatStore {
  private byAgent = new Map<string, PerAgent>();
  private cache = new Map<string, { text: string; model?: string }>();
  private listeners = new Set<Listener>();
  private snapshots = new Map<string, AgentChatState>();

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  };

  private emit(agentId: string): void {
    this.snapshots.delete(agentId);
    this.listeners.forEach((l) => l());
  }

  getSnapshot = (agentId: string): AgentChatState => {
    if (!agentId) return EMPTY_STATE;
    const cached = this.snapshots.get(agentId);
    if (cached) return cached;
    const pa = this.byAgent.get(agentId);
    const snap: AgentChatState = pa
      ? { messages: pa.messages, loading: pa.loading, active_agent_id: agentId }
      : { messages: [], loading: false, active_agent_id: agentId };
    this.snapshots.set(agentId, snap);
    return snap;
  };

  private ensure(agentId: string): PerAgent {
    let pa = this.byAgent.get(agentId);
    if (!pa) {
      pa = { messages: [], loading: false };
      this.byAgent.set(agentId, pa);
    }
    return pa;
  }

  private set(agentId: string, messages: ChatMessage[], loading: boolean): void {
    const pa = this.ensure(agentId);
    pa.messages = messages;
    pa.loading = loading;
    this.emit(agentId);
  }

  async send(agentId: string, message: string): Promise<void> {
    const text = message.trim();
    if (!text) return;
    const pa = this.ensure(agentId);
    const userMsg: ChatMessage = { id: nextId("u"), role: "user", text, timestamp: Date.now() };
    const pendingMsg: ChatMessage = { id: nextId("a"), role: "agent", text: "", timestamp: Date.now(), pending: true };
    this.set(agentId, [...pa.messages, userMsg, pendingMsg], true);

    const cacheKey = `${agentId}::${text.toLowerCase().replace(/\s+/g, " ")}`;
    const hit = this.cache.get(cacheKey);
    if (hit) {
      this.resolve(agentId, pendingMsg.id, hit.text, hit.model, false);
      return;
    }

    const history = pa.messages
      .filter((m) => !m.pending)
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ role: m.role, text: m.text }));

    try {
      const res = await fetch("/api/agentChat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, message: text, history }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { response?: string; model?: string };
      const reply = (data.response ?? "").trim() || "(no response)";
      this.cache.set(cacheKey, { text: reply, model: data.model });
      this.resolve(agentId, pendingMsg.id, reply, data.model, false);
    } catch {
      this.resolve(agentId, pendingMsg.id, "⚠ Could not reach the agent. Try again.", undefined, true);
    }
  }

  private resolve(agentId: string, pendingId: string, text: string, model: string | undefined, error: boolean): void {
    const pa = this.ensure(agentId);
    const messages = pa.messages.map((m) =>
      m.id === pendingId ? { ...m, text, model, pending: false, error, timestamp: Date.now() } : m,
    );
    this.set(agentId, messages, false);
  }
}

export const agentChat = new AgentChatStore();

export function useAgentChat(agentId: string): AgentChatState {
  return useSyncExternalStore(
    agentChat.subscribe,
    () => agentChat.getSnapshot(agentId),
    () => EMPTY_STATE,
  );
}
