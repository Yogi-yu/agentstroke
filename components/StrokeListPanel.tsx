"use client";

// ============================================================================
// StrokeListPanel — LEFT PANEL · the generated A→B strokes.
// ----------------------------------------------------------------------------
// Lists every stroke on the canvas. Each card carries an action bar with the
// Action order: View Agent → Edit → Remove. Removal hides this visitor's canvas
// membership only; the original artwork remains available in the archive.
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
  /** Request removal from this canvas (opens the confirmation modal). */
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
          <Link className="sl-archive" href="/archive">Archive ↗</Link>
          <button
            className="sl-clear"
            disabled={locked || strokes.length === 0}
            onClick={onClear}
            title="Clear this canvas; keep all artworks in the archive"
          >
            Clear
          </button>
        </div>
      </div>
      <div className="card-list" ref={listRef}>
        {ordered.length === 0 && (
          <div className="cards-empty">
            Your canvas is empty. Restore a saved artwork from the Archive, or open an agent to create a new stroke.
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
                {s.generation_mode === "example" && <span>Example</span>}
                {s.generation_mode === "autonomous" && <span>Agent-authored</span>}
                {s.brush_treatment === "calligraphy" && <span>Calligraphy brush</span>}
              </div>
              <div className="sc-time">{new Date(s.created_at).toLocaleTimeString("en-US", { hour12: false })}</div>

              {/* Card actions — View Agent → Edit → Remove.
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
                  title="Remove from canvas; keep in archive"
                >
                  Remove from canvas
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
