"use client";

// ============================================================================
// StrokeListPanel — LEFT PANEL · the generated A→B strokes.
// ----------------------------------------------------------------------------
// Lists every stroke on the canvas. Each card carries an action bar with the
// REQUIRED order View Agent → Edit → Delete (Issue 4). "View Agent" is the CORE
// NAVIGATION ELEMENT → /agent/:agent_id and must not be removed. "Delete"
// triggers GLOBAL stroke removal (store + server + canvas) via a confirm modal.
// ============================================================================

import { useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import type { AgentProfile, TransitionPath } from "@/lib/types";
import { categoryHue } from "@/lib/agents";
import { orderStrokesForList } from "@/lib/strokeListOrder";

interface Props {
  strokes: TransitionPath[];
  agents: AgentProfile[];
  selectedStrokeId: string | null;
  /** When edit mode is active, selection switching is locked out. */
  locked?: boolean;
  onSelect: (id: string | null) => void;
  /** Enter edit mode on a stroke (selects + focuses it). */
  onEdit: (id: string) => void;
  /** Request GLOBAL deletion of a stroke (opens the confirmation modal). */
  onDelete: (id: string) => void;
  /** Clear ALL strokes from the canvas. */
  onClear: () => void;
}

export default function StrokeListPanel({
  strokes,
  agents,
  selectedStrokeId,
  locked,
  onSelect,
  onEdit,
  onDelete,
  onClear,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const nameById = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const catById = useMemo(() => new Map(agents.map((a) => [a.id, a.category])), [agents]);
  const ordered = useMemo(
    () => orderStrokesForList(strokes, selectedStrokeId),
    [strokes, selectedStrokeId],
  );
  const hasSelection = !!selectedStrokeId && ordered[0]?.id === selectedStrokeId;
  useEffect(() => {
    // Reveal the pinned card without moving the page, canvas or mobile tabs.
    // Data refreshes with the same selection must not reset manual scrolling.
    if (hasSelection && listRef.current) listRef.current.scrollTop = 0;
  }, [selectedStrokeId, hasSelection]);

  return (
    <div className="panel stroke-list">
      <div className="panel-head">
        <h2>Strokes</h2>
        <div className="sl-head-actions">
          <span className="muted">{strokes.length} on canvas</span>
          <button
            className="sl-clear"
            disabled={locked || strokes.length === 0}
            onClick={onClear}
            title="Clear all strokes from the canvas"
          >
            Clear
          </button>
        </div>
      </div>
      <div className="card-list" ref={listRef}>
        {ordered.length === 0 && (
          <div className="cards-empty">
            No strokes yet. Open an economic agent and enter creation mode (A → B).
          </div>
        )}
        {ordered.map((s) => {
          const sel = s.id === selectedStrokeId;
          const cat = catById.get(s.agent_id);
          const hue = cat ? categoryHue(cat) : 210;
          return (
            <div
              key={s.id}
              data-stroke-id={s.id}
              className={`stroke-card${sel ? " selected" : ""}${locked ? " locked" : ""}`}
              onClick={() => !locked && onSelect(sel ? null : s.id)}
            >
              <div className="sc-head">
                <span className="dot" style={{ background: `hsl(${hue},85%,60%)` }} />
                <span className="sc-route"><b>{s.from}</b> → <b>{s.to}</b></span>
                <Link
                  href={`/stroke/${s.id}`}
                  className="sc-detail"
                  onClick={(e) => e.stopPropagation()}
                  title="View stroke detail"
                >
                  View Detail ↗
                </Link>
              </div>
              <div className="sc-stats">
                <span>{nameById.get(s.agent_id) ?? s.agent_id}</span>
                <span>{s.motion_type}</span>
                <span>{s.points.length} pts</span>
              </div>
              <div className="sc-time">{new Date(s.created_at).toLocaleTimeString("en-US", { hour12: false })}</div>

              {/* Card actions — REQUIRED ORDER: View Agent → Edit → Delete (Issue 4).
                  "View Agent" is the core navigation element to /agent/:id. */}
              <div className="sc-actions" onClick={(e) => e.stopPropagation()}>
                <Link
                  href={`/agent/${s.agent_id}`}
                  className="sc-act sc-act-agent"
                  title={`View Agent — ${nameById.get(s.agent_id) ?? s.agent_id}`}
                >
                  View Agent ↗
                </Link>
                <button
                  className="sc-act sc-act-edit"
                  disabled={locked}
                  onClick={() => !locked && onEdit(s.id)}
                  title="Edit this stroke"
                >
                  Edit
                </button>
                <button
                  className="sc-act sc-act-delete"
                  disabled={locked}
                  onClick={() => !locked && onDelete(s.id)}
                  title="Delete this stroke"
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
