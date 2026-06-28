"use client";

// ============================================================================
// StrokeInspector — the selected A→B stroke + EDIT MODE toggle.
// ----------------------------------------------------------------------------
// Header hosts the [Edit Mode] toggle (Issue 1). While editing, the stroke is
// draggable/rotatable on the canvas and a transform readout + reset appear here.
// ============================================================================

import { useMemo } from "react";
import type { StrokeTransform, TransitionPath } from "@/lib/types";

interface Props {
  stroke: TransitionPath;
  hue: number;
  agentName: string;
  editMode: boolean;
  transform: StrokeTransform;
  onToggleEdit: () => void;
  onResetTransform: () => void;
  onClose: () => void;
}

export default function StrokeInspector({
  stroke,
  hue,
  agentName,
  editMode,
  transform,
  onToggleEdit,
  onResetTransform,
  onClose,
}: Props) {
  const { entropyAvg, confidenceAvg, durationMs } = useMemo(() => {
    const pts = stroke.points;
    const n = pts.length || 1;
    return {
      entropyAvg: pts.reduce((a, q) => a + q.entropy, 0) / n,
      confidenceAvg: pts.reduce((a, q) => a + q.confidence, 0) / n,
      durationMs: pts.reduce((a, q) => a + q.duration_ms, 0),
    };
  }, [stroke]);

  return (
    <div className={`panel inspector${editMode ? " editing" : ""}`}>
      <div className="panel-head">
        <h2>Stroke {editMode && <em className="edit-flag">editing</em>}</h2>
        <div className="insp-head-actions">
          {/* Edit Mode ⇄ Save & Exit (Issue 2 · Step 2). While editing, this
              persists the stroke's transform and leaves edit mode. */}
          <button
            className={`mini ${editMode ? "accept" : "regen"}`}
            onClick={onToggleEdit}
            title={editMode ? "Persist changes and exit edit mode" : "Enter edit mode"}
          >
            {editMode ? "✓ Save & Exit" : "✏ Edit Mode"}
          </button>
          {!editMode && <button className="x" onClick={onClose}>✕</button>}
        </div>
      </div>

      <div className="inspector-body">
        <div className="insp-route">
          <span className="dot" style={{ background: `hsl(${hue},85%,60%)` }} />
          <b>{stroke.from}</b>
          <span className="arrow">→</span>
          <b>{stroke.to}</b>
        </div>

        <div className="insp-grid">
          <div><span>agent</span><i>{agentName}</i></div>
          <div><span>motion</span><i>{stroke.motion_type}</i></div>
          <div><span>entropy avg</span><i>{entropyAvg.toFixed(3)}</i></div>
          <div><span>confidence avg</span><i>{confidenceAvg.toFixed(3)}</i></div>
          <div><span>duration</span><i>{durationMs} ms</i></div>
          <div><span>points</span><i>{stroke.points.length}</i></div>
        </div>

        {editMode && (
          <div className="insp-transform">
            <div className="insp-label">transform</div>
            <div className="xf-grid">
              <span>x {transform.translation.x.toFixed(3)}</span>
              <span>y {transform.translation.y.toFixed(3)}</span>
              <span>rot {((transform.rotation * 180) / Math.PI).toFixed(0)}°</span>
              <span>scale {transform.scale.toFixed(2)}</span>
            </div>
            <button className="mini regen" onClick={onResetTransform}>↺ Reset transform</button>
            <p className="xf-hint">
              drag to move · drag the handle to rotate · <b>R</b> / <b>Shift+R</b> rotate ±7.5° · <b>scroll</b> to resize · <b>ESC</b> to exit
            </p>
          </div>
        )}

        {!editMode && stroke.geometry_mode && (
          <div className="insp-section">
            <div className="insp-label">structure · mood-selected</div>
            <div className="struct-grid">
              <span title="path geometry strategy">geometry <b>{stroke.geometry_mode}</b></span>
              <span title="branch topology strategy">branching <b>{stroke.branching_model}</b></span>
              <span title="motion / pacing strategy">motion <b>{stroke.motion_model}</b></span>
              <span title="number of semantic anchors">depth <b>{stroke.semantic_depth}</b></span>
            </div>
          </div>
        )}

        {!editMode && (
          <div className="insp-section">
            <div className="insp-label">semantic anchors</div>
            <div className="anchor-flow">
              {stroke.points.map((p, i) => (
                <span key={i} className="anchor-chip">{p.anchor}</span>
              ))}
            </div>
          </div>
        )}

        <div className="insp-foot">
          <code>{stroke.id}</code>
          <time>{new Date(stroke.created_at).toLocaleTimeString()}</time>
        </div>
      </div>
    </div>
  );
}
