"use client";

// ============================================================================
// AgentChatPanel — agent identity chat (restored).
// ----------------------------------------------------------------------------
// Talk to an agent about its identity, cognitive style and A→B stroke behavior.
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
  { label: "What's your economic function?", prompt: "What is your economic function and what real-world role do you map to?" },
  { label: "How do you make money?", prompt: "What is your revenue impact and how do you create economic value?" },
  { label: "What's your task domain?", prompt: "What market or domain do you operate in?" },
  { label: "How do you generate strokes?", prompt: "How does your economic function shape the strokes you generate from A to B?" },
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
            Ask this agent about its identity, cognitive style, or the A→B
            transitions it prefers.
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
