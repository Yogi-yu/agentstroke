"use client";

// ============================================================================
// Agent detail — PURPOSE + WORKFLOW, plus an EDITABLE per-agent stroke canvas.
// ----------------------------------------------------------------------------
// An agent is defined by WHY it exists and WHAT it routinely does. The center
// canvas shows the agent's own strokes and now supports FULL EDIT MODE (Issue 2):
// select a stroke, drag to translate, rotate (buttons / handle / R / Shift+R),
// reset, or delete. Every edit persists through the shared StrokeStore + server
// so it survives a refresh — no ephemeral edits.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import CanvasView, { type CanvasHandle } from "@/components/CanvasView";
import AgentChatPanel from "@/components/AgentChatPanel";
import AgentCreationForm from "@/components/AgentCreationForm";
import AgentDetailMobile from "@/components/AgentDetailMobile";
import type { Agent, StrokeTransform } from "@/lib/types";
import { agentRenderStyle, categoryHue, categoryLabel } from "@/lib/agents";
import { modelSpec } from "@/lib/openrouter/models";
import { IDENTITY_TRANSFORM } from "@/store/transformStore";
import { appStore, useApp } from "@/state/appStore";

const ROTATE_STEP = Math.PI / 24; // 7.5° per rotate press

/** null until mounted (SSR-safe), then true on ≤1024px viewports. */
function useIsMobile(query = "(max-width: 1024px)"): boolean | null {
  const [v, setV] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setV(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return v;
}

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const isMobile = useIsMobile();
  const { agents, strokes, ready, generating } = useApp();

  const [selectedStrokeId, setSelectedStrokeId] = useState<string | null>(null);
  const [editActive, setEditActive] = useState(false);
  const [transforms, setTransforms] = useState<Record<string, StrokeTransform>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteAgent, setConfirmDeleteAgent] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const canvasRef = useRef<CanvasHandle>(null);

  useEffect(() => {
    appStore.bootstrap();
    const t = setInterval(() => appStore.refresh(), 6000);
    return () => clearInterval(t);
  }, []);

  const agent = useMemo(() => agents.find((a) => a.id === id) ?? null, [agents, id]);
  const agentStrokes = useMemo(() => strokes.filter((s) => s.agent_id === id), [strokes, id]);
  const renderAgents = useMemo<Agent[]>(
    () => (agent ? [{ id: agent.id, style: agentRenderStyle(agent.category) }] : []),
    [agent],
  );

  // selection switching is locked while editing
  const onSelectStroke = useCallback(
    (sid: string | null) => {
      if (editActive) return;
      setSelectedStrokeId(sid);
    },
    [editActive],
  );

  // ---- edit mode (Issue 2) ----
  const enterEdit = useCallback((sid: string) => {
    setSelectedStrokeId(sid);
    setEditActive(true);
  }, []);
  const exitEdit = useCallback(() => setEditActive(false), []);

  // every transform writes back immediately: local mirror + server persistence
  const onTransformCommit = useCallback((sid: string, t: StrokeTransform) => {
    setTransforms((m) => ({ ...m, [sid]: t }));
    void appStore.persistTransform(sid, t);
  }, []);

  const saveAndExit = useCallback(() => {
    if (selectedStrokeId) {
      const t = transforms[selectedStrokeId] ?? canvasRef.current?.transformOf(selectedStrokeId) ?? IDENTITY_TRANSFORM;
      void appStore.persistTransform(selectedStrokeId, t);
    }
    exitEdit();
  }, [selectedStrokeId, transforms, exitEdit]);

  const rotate = useCallback(
    (dir: 1 | -1) => {
      if (selectedStrokeId) canvasRef.current?.rotateBy(selectedStrokeId, dir * ROTATE_STEP);
    },
    [selectedStrokeId],
  );

  const onResetTransform = useCallback(() => {
    if (!selectedStrokeId) return;
    canvasRef.current?.resetTransform(selectedStrokeId);
    setTransforms((m) => ({ ...m, [selectedStrokeId]: IDENTITY_TRANSFORM }));
    void appStore.persistTransform(selectedStrokeId, IDENTITY_TRANSFORM);
  }, [selectedStrokeId]);

  // ---- delete (permanent) ----
  const onConfirmDelete = useCallback(() => {
    const sid = confirmDeleteId;
    if (!sid) return;
    if (selectedStrokeId === sid) {
      setEditActive(false);
      setSelectedStrokeId(null);
    }
    void appStore.deleteStroke(sid);
    setConfirmDeleteId(null);
  }, [confirmDeleteId, selectedStrokeId]);

  // ---- keyboard: R / Shift+R rotate, ESC exits edit ----
  useEffect(() => {
    if (!editActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return exitEdit();
      if ((e.key === "r" || e.key === "R") && selectedStrokeId) {
        const tgt = e.target as HTMLElement | null;
        if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
        e.preventDefault();
        rotate(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editActive, selectedStrokeId, rotate, exitEdit]);

  const selectedInAgent = selectedStrokeId && agentStrokes.some((s) => s.id === selectedStrokeId);
  const confirmStroke = agentStrokes.find((s) => s.id === confirmDeleteId) ?? null;
  // Canvas is MANDATORY and must never be gated on agent/loading/edit state.
  // A missing agent is surfaced inline (info panel + creation lock), not by
  // swapping the canvas out.
  const notFound = ready && !agent;

  // Responsive split: ≤1024px gets a DEDICATED full-screen interaction layout,
  // not the desktop document grid. (null = not yet measured → render nothing to
  // avoid a layout flash / hydration mismatch.)
  if (isMobile === null) return <div className="detail-page" />;
  if (isMobile) return <AgentDetailMobile id={id} />;

  return (
    <div className="detail-page">
      <div className="detail-topbar">
        <Link href="/studio" className="back-link">← back to studio</Link>
        <div className="detail-title">{agent?.name ?? id}</div>
        <span className="back-link">{agent ? modelSpec(agent.model).label : ""}</span>
      </div>

      <div className="detail-grid">
        {/* LEFT — purpose + workflow ONLY */}
        <aside className="detail-col">
          {!agent && (
            <div className="panel detail-summary">
              <div className="detail-state">{notFound ? `Agent “${id}” not found.` : "loading agent…"}</div>
            </div>
          )}
          {agent && (
            <div className="panel detail-summary">
              <div className="dp-head">
                <span className="dp-dot" style={{ background: `hsl(${categoryHue(agent.category)},85%,60%)` }} />
                <div>
                  <div className="dp-name">{agent.name}</div>
                  <div className="dp-occupation">{agent.occupation}</div>
                  <div className="dp-id">{agent.id} · {categoryLabel(agent.category)}</div>
                </div>
              </div>

              <div className="dp-section">
                <span className="dp-label">economic function</span>
                <p className="dp-purpose">{agent.economic_function}</p>
                <div className="dp-tag-row">
                  <span className="tag" style={{ borderColor: `hsl(${categoryHue(agent.category)},60%,45%)` }}>
                    {agent.revenue_impact}
                  </span>
                </div>
              </div>

              <div className="dp-section">
                <span className="dp-label">economic profile</span>
                <div className="kv"><span>category</span><p>{categoryLabel(agent.category)}</p></div>
                <div className="kv"><span>real-world mapping</span><p>{agent.real_world_mapping}</p></div>
                <div className="kv"><span>task domain</span><p>{agent.task_domain}</p></div>
                <div className="kv"><span>revenue impact</span><p>{agent.revenue_impact}</p></div>
              </div>

              <div className="dp-section">
                <span className="dp-label">model</span>
                <p className="dp-personality">{modelSpec(agent.model).label} <span className="muted">({agent.model})</span></p>
              </div>

              <div className="dp-section">
                <button className="btn danger dp-delete" onClick={() => setConfirmDeleteAgent(true)}>
                  🗑 Delete agent
                </button>
              </div>
            </div>
          )}
        </aside>

        {/* CENTER — the MANDATORY canvas (always mounted) + agent-context creation. */}
        <section className="detail-canvas-col">
          <div className="detail-canvas">
            {/* StrokeCanvas is ALWAYS rendered — never gated on agent / loading /
                edit state. Until the agent loads it simply shows an empty canvas. */}
            <CanvasView
              ref={canvasRef}
              paths={agentStrokes}
              agents={renderAgents}
              selectedStrokeId={selectedStrokeId}
              filterAgentId={null}
              editMode={editActive}
              onSelectStroke={onSelectStroke}
              onTransformCommit={onTransformCommit}
            />

            {/* Edit toolbar (Issue 2) — move / rotate / delete the selected stroke. */}
            {agent && (
              <div className={`detail-edit-bar${editActive ? " editing" : ""}`}>
                {!editActive && selectedInAgent && (
                  <>
                    <button className="mini regen" onClick={() => enterEdit(selectedStrokeId!)}>✏ Edit</button>
                    <button className="mini reject" onClick={() => setConfirmDeleteId(selectedStrokeId)}>🗑 Delete</button>
                  </>
                )}
                {editActive && (
                  <>
                    <button className="mini" onClick={() => rotate(-1)} title="Rotate counter-clockwise">⟲</button>
                    <button className="mini" onClick={() => rotate(1)} title="Rotate clockwise">⟳</button>
                    <button className="mini regen" onClick={onResetTransform}>↺ Reset</button>
                    <button className="mini reject" onClick={() => setConfirmDeleteId(selectedStrokeId)}>🗑 Delete</button>
                    <button className="mini accept" onClick={saveAndExit}>✓ Save &amp; Exit</button>
                  </>
                )}
                {!editActive && !selectedInAgent && (
                  <span className="detail-edit-hint">click a stroke to select · then Edit to move / rotate / delete</span>
                )}
              </div>
            )}

            <div className="detail-canvas-hint">
              {editActive
                ? "edit mode · drag to move · handle or R / Shift+R to rotate · scroll to resize · ESC to exit"
                : `${agentStrokes.length} stroke(s) by this agent · style is emergent`}
            </div>
          </div>
          {/* Creation Panel is MANDATORY too — always present; it just locks
              until the agent resolves (creation requires a valid agent). */}
          <div className="panel detail-creation">
            <div className="panel-head">
              <h2>Create Stroke</h2>
              <span className="muted">A → B · in agent context</span>
            </div>
            <AgentCreationForm
              agentName={agent?.name ?? id}
              generating={generating}
              disabled={editActive || !agent}
              onCreate={(from, to) => { if (agent) void appStore.generate(from, to, agent.id); }}
            />
            <button
              className="btn danger detail-clear"
              disabled={editActive || agentStrokes.length === 0}
              onClick={() => setConfirmClear(true)}
            >
              Clear canvas ({agentStrokes.length})
            </button>
          </div>
        </section>

        {/* RIGHT — chat */}
        <aside className="detail-col">
          {agent && <AgentChatPanel agentId={agent.id} agentName={agent.name} />}
        </aside>
      </div>

      {/* Delete confirmation — permanent, global removal. */}
      {confirmStroke && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteId(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Delete stroke?</h3>
            <p className="modal-body">Are you sure you want to delete this stroke?</p>
            <p className="modal-target">
              <b>{confirmStroke.from}</b> → <b>{confirmStroke.to}</b>
            </p>
            <div className="modal-actions">
              <button className="mini" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
              <button className="mini reject danger" onClick={onConfirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete-agent confirmation — server removal (+ stroke cascade), then home. */}
      {confirmDeleteAgent && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteAgent(false)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Delete agent?</h3>
            <p className="modal-body">
              This removes <b>{agent?.name ?? id}</b>{agent ? ` (${agent.occupation})` : ""} and all of
              its strokes. This cannot be undone.
            </p>
            <div className="modal-actions">
              <button className="mini" onClick={() => setConfirmDeleteAgent(false)}>Cancel</button>
              <button
                className="mini reject danger"
                onClick={() => { void appStore.deleteAgent(id); setConfirmDeleteAgent(false); router.push("/"); }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear-canvas confirmation — wipes EVERY stroke from the canvas. */}
      {confirmClear && (
        <div className="modal-overlay" onClick={() => setConfirmClear(false)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Clear canvas?</h3>
            <p className="modal-body">
              This permanently removes all <b>{strokes.length}</b> stroke{strokes.length === 1 ? "" : "s"} from
              the canvas. This cannot be undone.
            </p>
            <div className="modal-actions">
              <button className="mini" onClick={() => setConfirmClear(false)}>Cancel</button>
              <button
                className="mini reject danger"
                onClick={() => { void appStore.clear(); setConfirmClear(false); }}
              >
                Clear canvas
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
