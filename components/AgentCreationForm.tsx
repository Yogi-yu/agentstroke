"use client";

// ============================================================================
// AgentCreationForm — invite an agent to choose and draw its own journey.
// ----------------------------------------------------------------------------
// This is NOT a standalone generator: it always runs in the context of a
// specific economic agent (it is rendered inside that agent's card / detail
// page). The agent's economic role shapes the resulting stroke server-side.
// ============================================================================

interface Props {
  agentName: string;
  generating: boolean;
  /** Locked out while Edit Mode is active. */
  disabled?: boolean;
  error?: string;
  onCreate: () => void;
  /** Optional — render an exit affordance (used inside an agent card). */
  onExit?: () => void;
}

export default function AgentCreationForm({ agentName, generating, disabled, error, onCreate, onExit }: Props) {
  const submit = () => {
    if (generating || disabled) return;
    onCreate();
  };

  return (
    <div className="creation-form">
      <div className="creation-head">
        <span className="creation-label">autonomous creation · {agentName}</span>
        {onExit && (
          <button className="creation-exit" onClick={onExit} title="Exit creation mode" aria-label="Exit creation mode">
            ✕
          </button>
        )}
      </div>
      <p className="creation-note">The agent chooses where to begin, where to end, and every step in between. Each step is one English word. Brief and extended journeys become distinctly short and long strokes.</p>
      {error && <p className="creation-error" role="alert">{error}</p>}
      <button
        type="button"
        className="btn primary creation-run"
        disabled={disabled || generating}
        onClick={submit}
      >
        {generating ? "Agent is creating…" : "✦ Let agent create"}
      </button>
    </div>
  );
}
