"use client";

// ============================================================================
// EconomicAgentPanel — the SINGLE unified agent system (right panel).
// ----------------------------------------------------------------------------
// Derives ENTIRELY from the server-authoritative agent pool (appStore mirrors
// GET /api/agents). Recruitment and timed creation belong to the server, never
// a browser timer. Durable activity survives an artwork leaving the live canvas.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { AgentProfile } from "@/lib/types";
import { AGENT_IDLE_TIMEOUT_MS, AGENT_POOL_MAX, AGENT_POOL_MIN, AUTO_STROKE_INTERVAL_MS, CANVAS_STROKE_LIMIT } from "@/lib/autopilotPolicy";
import { categoryHue, categoryLabel } from "@/lib/agents";
import { orderAgentsForSelection } from "@/lib/agentListOrder";
import { appStore, useApp } from "@/state/appStore";
import StorageNotice from "@/components/StorageNotice";

interface Props {
  /** Locked out while Edit Mode is active. */
  disabled?: boolean;
  /** Agent owning the currently-selected stroke — pinned first + highlighted. */
  highlightedAgentId?: string | null;
  /** Also reveal the author when switching between their different strokes. */
  selectedStrokeId?: string | null;
}

const JOINING_MS = 2500; // window during which a freshly-attracted agent flags itself

function fmtIdle(ms: number): string {
  if (ms < 1000) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

export default function EconomicAgentPanel({ disabled, highlightedAgentId, selectedStrokeId }: Props) {
  const { agents, strokes, automation } = useApp();
  const [now, setNow] = useState(() => Date.now());
  const [confirmDelete, setConfirmDelete] = useState<AgentProfile | null>(null);
  const [confirmClearAgents, setConfirmClearAgents] = useState(false);
  const [changingAgents, setChangingAgents] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Display-only clock: it never records activity or triggers recruitment.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Only reset this list when the selected stroke or author changes, never on
  // idle ticks or data refresh. Scrolling a card can move outer containers.
  useEffect(() => {
    if (!highlightedAgentId) return;
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [highlightedAgentId, selectedStrokeId]);

  // Prefer durable lifetime activity; old responses can fall back to the view.
  const activityById = useMemo(() => {
    const m = new Map<string, { count: number; last: number }>();
    for (const s of strokes) {
      const e = m.get(s.agent_id) ?? { count: 0, last: 0 };
      e.count += 1;
      e.last = Math.max(e.last, s.created_at);
      m.set(s.agent_id, e);
    }
    for (const a of agents) {
      const visible = m.get(a.id);
      m.set(a.id, {
        count: a.creative_count ?? visible?.count ?? 0,
        last: a.last_active_at ?? visible?.last ?? a.joined_at ?? 0,
      });
    }
    return m;
  }, [strokes, agents]);

  const minAgents = automation?.minAgents ?? AGENT_POOL_MIN;
  const maxAgents = automation?.maxAgents ?? AGENT_POOL_MAX;
  const idleTimeoutMs = automation?.idleTimeoutMs ?? AGENT_IDLE_TIMEOUT_MS;
  const intervalMinutes = (automation?.generationIntervalMs ?? AUTO_STROKE_INTERVAL_MS) / 60_000;
  const nextIn = automation?.nextGenerationAt ? Math.max(0, automation.nextGenerationAt - now) : null;
  const automationLabel = !automation ? "Connecting to studio…"
    : !automation.enabled ? "Automatic creation is disabled"
    : automation.generating ? "A new agent is drawing…"
    : !automation.running ? "Waiting for the studio to resume"
    : nextIn === null ? "Preparing the next creation"
    : nextIn > 0 ? `Next creation in ${fmtIdle(nextIn)}`
    : "Waiting for the next server tick";
  const retiredAuthorSelected = highlightedAgentId && !agents.some(a => a.id === highlightedAgentId);

  // The selected stroke's author leads; other agents keep their activity order.
  const ordered = useMemo(
    () => orderAgentsForSelection(agents, activityById, highlightedAgentId),
    [agents, activityById, highlightedAgentId],
  );

  return (
    <div className="panel econ-panel">
      <div className="panel-head">
        <h2>Agents available</h2>
        <div className="econ-head-actions">
          <span className="muted">{agents.length} agents</span>
          <button
            className="econ-clear-agents"
            disabled={disabled || agents.length === 0}
            onClick={() => { appStore.dismissStorageError(); setConfirmClearAgents(true); }}
          >
            Clear all
          </button>
        </div>
      </div>

      {/* Read-only server status. Multiple viewers cannot create extra jobs. */}
      <div className="econ-task">
        <div className="econ-reward">
          <span className="econ-reward-main">Autonomous studio</span>
          <span className="econ-reward-sub">{minAgents}–{maxAgents} live agents · automatic recruitment</span>
        </div>
        <div className="econ-task-status">
          {automation?.running && <span className="econ-pulse" />}
          {automationLabel}
        </div>
        <div className="econ-task-sub">
          A fresh agent creates one stroke every {intervalMinutes} minutes.
          Agents leave after {idleTimeoutMs / 60_000} minutes without creative or chat activity.
        </div>
        <div className="econ-task-sub">
          The canvas keeps {automation?.canvasLimit ?? CANVAS_STROKE_LIMIT} strokes. Oldest arrivals move to Archive as new work arrives.
          Automatic creation pauses while the service sleeps.
        </div>
        {automation?.lastError && <p className="econ-task-sub" role="alert">{automation.lastError}</p>}
        {retiredAuthorSelected && <Link className="econ-task-sub" href={`/agent/${highlightedAgentId}`}>Selected author is outside the live pool · View profile ↗</Link>}
      </div>

      <div ref={listRef} className={`econ-list${disabled ? " locked" : ""}`}>
        {ordered.map((a) => {
          const hue = categoryHue(a.category);
          const joining = now - (a.joined_at ?? 0) < JOINING_MS;
          const highlighted = a.id === highlightedAgentId;
          const act = activityById.get(a.id);
          const strokeCount = act?.count ?? 0;
          const lastActive = a.last_active_at ?? act?.last ?? a.joined_at ?? now;
          const idle = Math.max(0, now - lastActive);
          const cls =
            `econ-card${joining ? " joining" : ""}${highlighted ? " highlighted" : ""}` +
            `${disabled ? " locked" : ""}`;
          const inner = (
            <>
              {/* TOP ROW: name · model · stroke badge (top-right) */}
              <div className="econ-top">
                <div className="econ-id-group">
                  <span className="dot" style={{ background: `hsl(${hue},85%,60%)` }} />
                  <span className="econ-name">{a.name}</span>
                  <span className="econ-model">{a.model_type}</span>
                </div>
                <span
                  className={`stroke-badge${strokeCount > 0 ? " active" : " muted"}`}
                  title={`${strokeCount} stroke${strokeCount === 1 ? "" : "s"} created`}
                >
                  ✦ {strokeCount} stroke{strokeCount === 1 ? "" : "s"}
                </span>
              </div>

              {/* BODY: description · category · economic function */}
              <div className="econ-occupation">{a.occupation}</div>
              <div className="econ-cat-row">
                <span className="econ-cat">{categoryLabel(a.category)}</span>
                <span className="econ-rev" style={{ borderColor: `hsl(${hue},60%,45%)` }}>
                  {a.revenue_impact}
                </span>
              </div>
              <div className="econ-fn">{a.economic_function}</div>

              {/* FOOTER: idle time · activity status */}
              <div className="econ-footer">
                <span className="econ-idle" title="Time since the agent last created, chatted, or joined; page views do not count">
                  idle {fmtIdle(idle)}
                </span>
                <span className="econ-status-group">
                  <span className={`econ-status${idle < idleTimeoutMs ? " active" : ""}`}>
                    {idle >= idleTimeoutMs ? "○ retiring" : "● available"}
                  </span>
                  {!disabled && (
                    <button
                      className="econ-del"
                      title={`Remove ${a.name} from the shared agent pool`}
                      aria-label={`Remove ${a.name} from the shared agent pool`}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); appStore.dismissStorageError(); setConfirmDelete(a); }}
                    >
                      🗑
                    </button>
                  )}
                </span>
              </div>

              {joining && <div className="econ-joining">joining the studio…</div>}
            </>
          );
          // VIEW-ONLY: the whole card navigates to the detail page (the sole
          // creation entry point). Locked to a non-interactive card during edit.
          return disabled ? (
            <div
              key={a.id}
              data-agent-id={a.id}
              className={`${cls} static`}
              style={{ ["--agent-hue" as string]: `${hue}` }}
              aria-disabled
            >
              {inner}
            </div>
          ) : (
            <Link
              key={a.id}
              data-agent-id={a.id}
              href={`/agent/${a.id}`}
              className={cls}
              style={{ ["--agent-hue" as string]: `${hue}` }}
            >
              {inner}
            </Link>
          );
        })}
      </div>

      {/* Pool membership changes do not delete an agent's artwork. */}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => { if (!changingAgents) setConfirmDelete(null); }}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Remove available agent?</h3>
            <p className="modal-body">
              This removes <b>{confirmDelete.name}</b> ({confirmDelete.occupation}) from the shared agent pool for everyone.
              Its artworks and authorship remain saved in the Archive. Canvas works continue their normal rotation.
              Automatic recruitment may fill the vacancy at the next server check.
            </p>
            <StorageNotice />
            <div className="modal-actions">
              <button className="mini" disabled={changingAgents} onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button
                className="mini reject danger"
                disabled={changingAgents}
                onClick={async () => {
                  setChangingAgents(true);
                  try { if (await appStore.deleteAgent(confirmDelete.id)) setConfirmDelete(null); }
                  finally { setChangingAgents(false); }
                }}
              >
                {changingAgents ? "Removing…" : "Remove agent"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmClearAgents && (
        <div className="modal-overlay" onClick={() => { if (!changingAgents) setConfirmClearAgents(false); }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="clear-agents-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="clear-agents-title" className="modal-title">Clear all agents?</h3>
            <p className="modal-body">
              This removes all <b>{agents.length}</b> agents from the shared pool for everyone. All artworks remain saved with their original provenance. Automatic recruitment will refill the live pool at the next server check; this does not pause the studio.
            </p>
            <StorageNotice />
            <div className="modal-actions">
              <button className="mini" disabled={changingAgents} onClick={() => setConfirmClearAgents(false)}>Cancel</button>
              <button
                className="mini reject danger"
                disabled={changingAgents}
                onClick={async () => {
                  setChangingAgents(true);
                  try { if (await appStore.clearAgents()) setConfirmClearAgents(false); }
                  finally { setChangingAgents(false); }
                }}
              >
                {changingAgents ? "Clearing…" : "Clear available agents"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
