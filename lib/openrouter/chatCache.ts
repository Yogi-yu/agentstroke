// ============================================================================
// Agent-chat cache — cost control for repeated questions per agent.
// ----------------------------------------------------------------------------
// Key = `${agent_id}:${normalizedQuestion}`. A hit returns the stored reply
// without a model call. Process-wide globalThis singleton.
// ============================================================================

export interface ChatCacheEntry {
  response: string;
  model: string;
  timestamp: number;
  source: "model" | "fallback";
}

const MAX_ENTRIES = 500;
const TTL_MS = 1000 * 60 * 60 * 6; // 6h

const g = globalThis as unknown as { __agentChatCache?: Map<string, ChatCacheEntry> };

function store(): Map<string, ChatCacheEntry> {
  if (!g.__agentChatCache) g.__agentChatCache = new Map();
  return g.__agentChatCache;
}

export function chatCacheKey(agentId: string, question: string): string {
  return `${agentId}:${question.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export function getCachedChat(key: string): ChatCacheEntry | null {
  const e = store().get(key);
  if (!e) return null;
  if (Date.now() - e.timestamp > TTL_MS) {
    store().delete(key);
    return null;
  }
  return e;
}

export function setCachedChat(key: string, entry: ChatCacheEntry): void {
  const s = store();
  s.set(key, entry);
  if (s.size > MAX_ENTRIES) {
    const overflow = s.size - MAX_ENTRIES;
    let i = 0;
    for (const k of s.keys()) {
      if (i++ >= overflow) break;
      s.delete(k);
    }
  }
}
