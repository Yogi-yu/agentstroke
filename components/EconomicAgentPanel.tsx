"use client";

// ============================================================================
// EconomicAgentPanel — the SINGLE unified agent system (right panel).
// ----------------------------------------------------------------------------
// Derives ENTIRELY from the server-authoritative agent pool (appStore mirrors
// GET /api/agents). "Post Creative Task" attracts more agents over time (server
// POST); each card can delete its agent (server DELETE) behind a confirmation.
// Per-agent creative activity (stroke counts / idle) is computed from the live
// stroke list. View-only for navigation: a card opens its detail page (the sole
// creation entry point).
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { AgentProfile } from "@/lib/types";
import { DEFAULT_REWARD_SYSTEM } from "@/lib/types";
import { categoryHue, categoryLabel } from "@/lib/agents";
import { appStore, useApp } from "@/state/appStore";

interface Props {
  /** Locked out while Edit Mode is active. */
  disabled?: boolean;
  /** Agent owning the currently-selected stroke — highlighted + scrolled to. */
  highlightedAgentId?: string | null;
}

const JOINING_MS = 2500; // window during which a freshly-attracted agent flags itself
const reward = DEFAULT_REWARD_SYSTEM;

function fmtIdle(ms: number): string {
  if (ms < 1000) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

export default function EconomicAgentPanel({ disabled, highlightedAgentId }: Props) {
  const { agents, strokes, funding, capacity } = useApp();
  const [now, setNow] = useState(() => Date.now());
  const [confirmDelete, setConfirmDelete] = useState<AgentProfile | null>(null);
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());

  // 1s heartbeat so idle times + the "attracted" window stay live.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Scroll the highlighted agent (owner of the selected stroke) into view.
  useEffect(() => {
    if (!highlightedAgentId) return;
    cardRefs.current.get(highlightedAgentId)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [highlightedAgentId]);

  // Per-agent creative activity derived from the live stroke list.
  const activityById = useMemo(() => {
    const m = new Map<string, { count: number; last: number }>();
    for (const s of strokes) {
      const e = m.get(s.agent_id) ?? { count: 0, last: 0 };
      e.count += 1;
      e.last = Math.max(e.last, s.created_at);
      m.set(s.agent_id, e);
    }
    return m;
  }, [strokes]);

  const remaining = Math.max(0, capacity - agents.length);
  const taskDisabled = disabled || (remaining === 0 && !funding);

  // Activity-weighted ordering: contributors first, then by output, recency, category.
  //   1. has_strokes (>0) on top   2. stroke_count desc
  //   3. most recent activity       4. category
  const ordered = useMemo(
    () =>
      [...agents].sort((a, b) => {
        const aa = activityById.get(a.id);
        const bb = activityById.get(b.id);
        const ac = aa?.count ?? 0;
        const bc = bb?.count ?? 0;
        const aHas = ac > 0 ? 1 : 0;
        const bHas = bc > 0 ? 1 : 0;
        if (aHas !== bHas) return bHas - aHas; // P1: any strokes → top
        if (ac !== bc) return bc - ac; // P2: stroke_count desc
        const al = aa?.last ?? a.joined_at ?? 0;
        const bl = bb?.last ?? b.joined_at ?? 0;
        if (al !== bl) return bl - al; // P3: recent activity first
        return a.category.localeCompare(b.category); // P4: category
      }),
    [agents, activityById],
  );

  return (
    <div className="panel econ-panel">
      <div className="panel-head">
        <h2>Agents available</h2>
        <span className="muted">{agents.length} agents</span>
      </div>

      {/* Task bounty — posts a creative task that attracts more economic agents. */}
      <div className="econ-task">
        <button
          className={`task-btn${funding ? " active" : ""}`}
          disabled={taskDisabled}
          onClick={() => appStore.toggleFunding()}
          title="Post a creative task that attracts more economic agents"
        >
          {funding ? "Pause Task" : "Post Creative Task"}
        </button>

        <div className="econ-reward">
          <span className="econ-reward-main">${reward.per_creation_reward.toFixed(2)} per creation</span>
          {reward.revenue_share_enabled && (
            <span className="econ-reward-sub">Includes future revenue share</span>
          )}
        </div>

        {funding && (
          <div className="econ-task-status">
            <span className="econ-pulse" />
            task posted · attracting economic agents…
          </div>
        )}
        <div className="econ-task-sub">
          {remaining > 0
            ? `${remaining} economic agents available to attract`
            : "all economic agents attracted"}
        </div>
      </div>

      <div className={`econ-list${disabled ? " locked" : ""}`}>
        {ordered.map((a) => {
          const hue = categoryHue(a.category);
          const joining = now - (a.joined_at ?? 0) < JOINING_MS;
          const highlighted = a.id === highlightedAgentId;
          const act = activityById.get(a.id);
          const strokeCount = act?.count ?? 0;
          const lastActive = act?.last ?? a.joined_at ?? now;
          const idle = Math.max(0, now - lastActive);
          const cls =
            `econ-card${joining ? " joining" : ""}${highlighted ? " highlighted" : ""}` +
            `${disabled ? " locked" : ""}`;
          const setRef = (el: HTMLElement | null) => {
            if (el) cardRefs.current.set(a.id, el);
            else cardRefs.current.delete(a.id);
          };
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
                <span className="econ-idle" title="time since this agent last created">
                  idle {fmtIdle(idle)}
                </span>
                <span className="econ-status-group">
                  <span className={`econ-status${strokeCount > 0 ? " active" : ""}`}>
                    {strokeCount > 0 ? "● active" : "○ idle"}
                  </span>
                  {!disabled && (
                    <button
                      className="econ-del"
                      title={`Delete ${a.name}`}
                      aria-label={`Delete ${a.name}`}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirmDelete(a); }}
                    >
                      🗑
                    </button>
                  )}
                </span>
              </div>

              {joining && <div className="econ-joining">attracted to task…</div>}
            </>
          );
          // VIEW-ONLY: the whole card navigates to the detail page (the sole
          // creation entry point). Locked to a non-interactive card during edit.
          return disabled ? (
            <div
              key={a.id}
              ref={setRef}
              className={`${cls} static`}
              style={{ ["--agent-hue" as string]: `${hue}` }}
              aria-disabled
            >
              {inner}
            </div>
          ) : (
            <Link
              key={a.id}
              ref={setRef}
              href={`/agent/${a.id}`}
              className={cls}
              style={{ ["--agent-hue" as string]: `${hue}` }}
            >
              {inner}
            </Link>
          );
        })}
      </div>

      {/* Delete confirmation — server-authoritative removal (+ stroke cascade). */}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Delete agent?</h3>
            <p className="modal-body">
              This removes <b>{confirmDelete.name}</b> ({confirmDelete.occupation}) and all of its
              strokes from the canvas. This cannot be undone.
            </p>
            <div className="modal-actions">
              <button className="mini" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button
                className="mini reject danger"
                onClick={() => { void appStore.deleteAgent(confirmDelete.id); setConfirmDelete(null); }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
