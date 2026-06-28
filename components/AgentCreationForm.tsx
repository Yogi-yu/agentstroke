"use client";

// ============================================================================
// AgentCreationForm — agent-context A → B stroke creation.
// ----------------------------------------------------------------------------
// This is NOT a standalone generator: it always runs in the context of a
// specific economic agent (it is rendered inside that agent's card / detail
// page). The agent's economic role shapes the resulting stroke server-side.
// ============================================================================

import { useState } from "react";

interface Props {
  agentName: string;
  generating: boolean;
  /** Locked out while Edit Mode is active. */
  disabled?: boolean;
  onCreate: (from: string, to: string) => void;
  /** Optional — render an exit affordance (used inside an agent card). */
  onExit?: () => void;
}

export default function AgentCreationForm({ agentName, generating, disabled, onCreate, onExit }: Props) {
  const [from, setFrom] = useState("chaos");
  const [to, setTo] = useState("order");

  const submit = () => {
    if (!from.trim() || !to.trim() || generating || disabled) return;
    onCreate(from.trim(), to.trim());
  };

  return (
    <div className="creation-form">
      <div className="creation-head">
        <span className="creation-label">creation mode · {agentName}</span>
        {onExit && (
          <button className="creation-exit" onClick={onExit} title="Exit creation mode" aria-label="Exit creation mode">
            ✕
          </button>
        )}
      </div>
      <div className="creation-row">
        <label className="gen-field">
          <span>concept A</span>
          <input
            value={from}
            disabled={disabled}
            onChange={(e) => setFrom(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="concept A"
          />
        </label>
        <div className="gen-arrow">→</div>
        <label className="gen-field">
          <span>concept B</span>
          <input
            value={to}
            disabled={disabled}
            onChange={(e) => setTo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="concept B"
          />
        </label>
      </div>
      <button
        className="btn primary creation-run"
        disabled={disabled || generating || !from.trim() || !to.trim()}
        onClick={submit}
      >
        {generating ? "creating…" : "✦ Create Stroke"}
      </button>
    </div>
  );
}
