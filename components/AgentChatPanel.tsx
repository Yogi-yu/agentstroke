"use client";

// ============================================================================
// AgentChatPanel — agent identity chat (restored).
// ----------------------------------------------------------------------------
// Talk to an agent about its identity and independently authored journeys.
// Quick-question buttons + free text; replies stream into model-labeled bubbles.
// Not a generic assistant — an identity reflection interface.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { agentChat, useAgentChat } from "@/state/agentChatStore";

interface Props {
  agentId: string;
  agentName: string;
}

const QUICK_PROMPTS: ReadonlyArray<{ label: string; prompt: string }> = [
  { label: "What is your purpose?", prompt: "What is your purpose?" },
  { label: "Why did you generate this stroke?", prompt: "Describe your recorded stroke journey and how it relates to your work. Distinguish your own choices from any fixed example; do not invent an unrecorded rationale." },
  { label: "Explain your economic function", prompt: "Explain your economic function and the real-world role you map to." },
  { label: "Describe your working behavior", prompt: "Describe your working behavior and cognitive style." },
];

export default function AgentChatPanel({ agentId, agentName }: Props) {
  const state = useAgentChat(agentId);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages]);

  const send = useCallback(
    (text: string) => {
      if (!text.trim() || state.loading) return;
      void agentChat.send(agentId, text);
    },
    [agentId, state.loading],
  );

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      send(draft);
      setDraft("");
    },
    [draft, send],
  );

  return (
    <div className="panel chat-panel">
      <div className="panel-head">
        <h2>Chat · {agentName}</h2>
        <span className="muted">identity reflection</span>
      </div>

      <div className="chat-quick">
        {QUICK_PROMPTS.map((q) => (
          <button
            key={q.label}
            type="button"
            className="chat-quick-btn"
            disabled={state.loading}
            onClick={() => send(q.prompt)}
            title={q.prompt}
          >
            {q.label}
          </button>
        ))}
      </div>

      <div className="chat-log" ref={scrollRef}>
        {state.messages.length === 0 && (
          <div className="chat-empty">
            Ask this agent about its identity, the words it chooses, or the
            journeys it creates.
          </div>
        )}
        {state.messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            {m.role === "agent" && <span className="chat-model">{m.model ?? agentName}</span>}
            <div className={`chat-bubble ${m.role}${m.error ? " error" : ""}`}>
              {m.pending ? (
                <span className="chat-typing"><i /><i /><i /></span>
              ) : (
                m.text
              )}
            </div>
          </div>
        ))}
      </div>

      <form className="chat-input" onSubmit={onSubmit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask this agent anything..."
          aria-label="Ask this agent anything"
        />
        <button className="btn primary chat-send" type="submit" disabled={state.loading || !draft.trim()}>
          {state.loading ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}
