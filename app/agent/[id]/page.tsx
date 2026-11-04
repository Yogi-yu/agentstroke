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
import StrokePlayerPanel from "@/components/StrokePlayerPanel";
import StorageNotice from "@/components/StorageNotice";
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
  const { agents, strokes, ready, generating, generationError } = useApp();

  const [selectedStrokeId, setSelectedStrokeId] = useState<string | null>(null);
  const [previewStrokeId, setPreviewStrokeId] = useState<string | null>(null);
  const [editActive, setEditActive] = useState(false);
  const [transforms, setTransforms] = useState<Record<string, StrokeTransform>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteAgent, setConfirmDeleteAgent] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [mutating, setMutating] = useState(false);
  const transformRequests = useRef(new Map<string, number>());
  const canvasRef = useRef<CanvasHandle>(null);
  const canvasColumnRef = useRef<HTMLElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void appStore.bootstrap();
  }, []);

  useEffect(() => {
    const reconcile = () => {
      // A live remote update must not interrupt an in-progress local gesture.
      if (!editActive && document.visibilityState !== "hidden") void appStore.refresh(true);
    };
    const timer = setInterval(reconcile, 6000);
    window.addEventListener("focus", reconcile);
    window.addEventListener("pageshow", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    if (!editActive) reconcile();
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("pageshow", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
    };
  }, [editActive]);

  const agent = useMemo(() => agents.find((a) => a.id === id) ?? null, [agents, id]);
  const agentStrokes = useMemo(() => strokes.filter((s) => s.agent_id === id), [strokes, id]);
  const previewStroke = useMemo(() => agentStrokes.find((stroke) => stroke.id === previewStrokeId) ?? null, [agentStrokes, previewStrokeId]);
  const renderAgents = useMemo<Agent[]>(
    () => (agent ? [{ id: agent.id, style: agentRenderStyle(agent.category) }] : []),
    [agent],
  );

  // selection switching is locked while editing
  const onSelectStroke = useCallback(
    (sid: string | null) => {
      if (editActive) return;
      setSelectedStrokeId(sid);
      setPreviewStrokeId(sid);
    },
    [editActive],
  );

  useEffect(() => {
    setSelectedStrokeId(null);
    setPreviewStrokeId(null);
    setEditActive(false);
  }, [id]);

  useEffect(() => {
    if (previewStrokeId && !isMobile) playerRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [previewStrokeId, isMobile]);

  const closePlayback = useCallback(() => {
    setPreviewStrokeId(null);
    setSelectedStrokeId(null);
    canvasColumnRef.current?.scrollTo({ top: 0 });
  }, []);

  // ---- edit mode (Issue 2) ----
  const enterEdit = useCallback((sid: string) => {
    setSelectedStrokeId(sid);
    setPreviewStrokeId(null);
    setEditActive(true);
    canvasColumnRef.current?.scrollTo({ top: 0 });
  }, []);
  const exitEdit = useCallback(() => setEditActive(false), []);

  // Live gestures remain responsive; failed database writes visibly roll back.
  const saveTransform = useCallback(async (sid: string, t: StrokeTransform, immediately = false) => {
    const request = (transformRequests.current.get(sid) ?? 0) + 1;
    transformRequests.current.set(sid, request);
    setTransforms((m) => ({ ...m, [sid]: t }));
    const saved = await appStore.persistTransform(sid, t, immediately);
    if (!saved && transformRequests.current.get(sid) === request) {
      const confirmed = appStore.getSnapshot().strokes.find((stroke) => stroke.id === sid)?.transform ?? IDENTITY_TRANSFORM;
      canvasRef.current?.restoreTransform(sid, confirmed);
      setTransforms((m) => ({ ...m, [sid]: confirmed }));
    }
    return saved;
  }, []);
  const onTransformCommit = useCallback((sid: string, t: StrokeTransform) => { void saveTransform(sid, t); }, [saveTransform]);

  const saveAndExit = useCallback(async () => {
    if (mutating) return;
    setMutating(true);
    try {
      if (selectedStrokeId) {
        const t = transforms[selectedStrokeId] ?? canvasRef.current?.transformOf(selectedStrokeId) ?? IDENTITY_TRANSFORM;
        if (!await saveTransform(selectedStrokeId, t, true)) return;
      }
      exitEdit();
    } finally { setMutating(false); }
  }, [selectedStrokeId, transforms, exitEdit, mutating, saveTransform]);

  const rotate = useCallback(
    (dir: 1 | -1) => {
      if (selectedStrokeId) canvasRef.current?.rotateBy(selectedStrokeId, dir * ROTATE_STEP);
    },
    [selectedStrokeId],
  );

  const onResetTransform = useCallback(() => {
    if (!selectedStrokeId) return;
    canvasRef.current?.resetTransform(selectedStrokeId);
    void saveTransform(selectedStrokeId, IDENTITY_TRANSFORM);
  }, [selectedStrokeId, saveTransform]);

  // ---- remove from this canvas, retaining the archived original ----
  const onConfirmDelete = useCallback(async () => {
    const sid = confirmDeleteId;
    if (!sid || mutating) return;
    setMutating(true);
    try {
      if (!await appStore.deleteStroke(sid)) return;
      if (selectedStrokeId === sid) { setEditActive(false); setSelectedStrokeId(null); }
      if (previewStrokeId === sid) setPreviewStrokeId(null);
      setConfirmDeleteId(null);
    } finally { setMutating(false); }
  }, [confirmDeleteId, selectedStrokeId, previewStrokeId, mutating]);

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
      <StorageNotice />
      <div className="detail-topbar">
        <Link href="/studio" className="back-link">← back to studio</Link>
        <div className="detail-title">{agent?.name ?? id}</div>
        <span className="back-link">{agent ? modelSpec(agent.model).label : ""}</span>
      </div>

      <div className="detail-grid">
        {/* LEFT — stroke selection, purpose and workflow */}
        <aside className="detail-col">
          {!agent && (
            <div className="panel detail-summary">
              <div className="detail-state">{notFound ? `Agent “${id}” not found.` : "loading agent…"}</div>
            </div>
          )}
          {agent && (
            <section className="panel agent-stroke-list">
              <div className="panel-head"><h2>Strokes</h2><span className="muted">{agentStrokes.length}</span></div>
              <div className="agent-stroke-options" aria-label="Agent strokes">
                {agentStrokes.length ? [...agentStrokes].reverse().map((stroke) => (
                  <button type="button" key={stroke.id} className={`agent-stroke-option${previewStrokeId === stroke.id ? " active" : ""}`} aria-pressed={previewStrokeId === stroke.id} disabled={editActive} onClick={() => onSelectStroke(stroke.id)}>
                    <span>{stroke.from} <span aria-hidden="true">→</span> {stroke.to}</span>
                    <small>{stroke.motion_type} · {new Date(stroke.timestamp ?? stroke.created_at).toLocaleTimeString("en-US", { hour12: false })}</small>
                  </button>
                )) : <p className="agent-stroke-empty">Create a stroke to watch its journey here.</p>}
              </div>
            </section>
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
                  Remove available agent
                </button>
              </div>
            </div>
          )}
        </aside>

        {/* CENTER — the MANDATORY canvas (always mounted) + agent-context creation. */}
        <section ref={canvasColumnRef} className={`detail-canvas-col${previewStroke ? " has-stroke-player" : ""}`}>
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
                    <button className="mini reject" onClick={() => setConfirmDeleteId(selectedStrokeId)}>Remove from canvas</button>
                  </>
                )}
                {editActive && (
                  <>
                    <button className="mini" onClick={() => rotate(-1)} title="Rotate counter-clockwise">⟲</button>
                    <button className="mini" onClick={() => rotate(1)} title="Rotate clockwise">⟳</button>
                    <button className="mini regen" onClick={onResetTransform}>↺ Reset</button>
                    <button className="mini reject" disabled={mutating} onClick={() => setConfirmDeleteId(selectedStrokeId)}>Remove from canvas</button>
                    <button className="mini accept" disabled={mutating} onClick={saveAndExit}>{mutating ? "Saving…" : "✓ Save & Exit"}</button>
                  </>
                )}
                {!editActive && !selectedInAgent && (
                  <span className="detail-edit-hint">click a stroke to watch its playback · Edit to move / rotate</span>
                )}
              </div>
            )}

            <div className="detail-canvas-hint">
              {editActive
                ? "edit mode · drag to move · handle or R / Shift+R to rotate · scroll to resize · ESC to exit"
                : `${agentStrokes.length} stroke(s) by this agent · style is emergent`}
            </div>
          </div>
          {previewStroke && !editActive && (
            <div ref={playerRef} className="agent-inline-player">
              <StrokePlayerPanel
                stroke={previewStroke}
                agent={agent}
                onClose={closePlayback}
                strokeOptions={agentStrokes}
                onSelectStroke={onSelectStroke}
                actions={<>
                  <button type="button" className="sd-playback-button" onClick={() => enterEdit(previewStroke.id)}>Edit</button>
                  <button type="button" className="sd-playback-button" onClick={() => setConfirmDeleteId(previewStroke.id)}>Remove from canvas</button>
                </>}
              />
            </div>
          )}
          {/* Creation Panel is MANDATORY too — always present; it just locks
              until the agent resolves (creation requires a valid agent). */}
          <div className="panel detail-creation">
            <div className="panel-head">
              <h2>Create Stroke</h2>
              <span className="muted">Agent-led exploration</span>
            </div>
            <AgentCreationForm
              agentName={agent?.name ?? id}
              generating={generating}
              error={generationError}
              disabled={editActive || !agent}
              onCreate={() => { if (agent) void appStore.generateAutonomous(agent.id); }}
            />
            <button
              className="btn danger detail-clear"
              disabled={editActive || strokes.length === 0}
              onClick={() => setConfirmClear(true)}
            >
              Clear shared canvas ({strokes.length})
            </button>
          </div>
        </section>

        {/* RIGHT — chat */}
        <aside className="detail-col">
          {agent && <AgentChatPanel agentId={agent.id} agentName={agent.name} />}
        </aside>
      </div>

      {/* Canvas visibility changes never delete archived artworks. */}
      {confirmStroke && (
        <div className="modal-overlay" onClick={() => { if (!mutating) setConfirmDeleteId(null); }}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Remove from shared canvas?</h3>
            <p className="modal-body">This hides the stroke from the shared Snapshot canvas for everyone. Its original stays saved in the Archive and can be restored.</p>
            <p className="modal-target">
              <b>{confirmStroke.from}</b> → <b>{confirmStroke.to}</b>
            </p>
            <StorageNotice />
            <div className="modal-actions">
              <button className="mini" disabled={mutating} onClick={() => setConfirmDeleteId(null)}>Cancel</button>
              <button className="mini reject danger" disabled={mutating} onClick={onConfirmDelete}>{mutating ? "Removing…" : "Remove from canvas"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Agent pool membership never cascades to artwork deletion. */}
      {confirmDeleteAgent && (
        <div className="modal-overlay" onClick={() => { if (!mutating) setConfirmDeleteAgent(false); }}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Remove available agent?</h3>
            <p className="modal-body">
              This removes <b>{agent?.name ?? id}</b>{agent ? ` (${agent.occupation})` : ""} from the shared available pool for everyone.
              All artworks stay on the shared canvas and in the Archive. Anyone can attract this agent again later.
            </p>
            <StorageNotice />
            <div className="modal-actions">
              <button className="mini" disabled={mutating} onClick={() => setConfirmDeleteAgent(false)}>Cancel</button>
              <button
                className="mini reject danger"
                disabled={mutating}
                onClick={async () => {
                  setMutating(true);
                  try { if (await appStore.deleteAgent(id)) { setConfirmDeleteAgent(false); router.push("/studio"); } }
                  finally { setMutating(false); }
                }}
              >
                {mutating ? "Removing…" : "Remove agent"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clearing affects every visitor's shared view; archived artwork stays. */}
      {confirmClear && (
        <div className="modal-overlay" onClick={() => { if (!mutating) setConfirmClear(false); }}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Clear shared canvas for everyone?</h3>
            <p className="modal-body">
              This hides all <b>{strokes.length}</b> stroke{strokes.length === 1 ? "" : "s"} from
              the shared Snapshot and Sky canvases on every device. All artworks stay in the <Link href="/archive">Archive</Link> and can be restored. This affects all visitors.
            </p>
            <StorageNotice />
            <div className="modal-actions">
              <button className="mini" disabled={mutating} onClick={() => setConfirmClear(false)}>Cancel</button>
              <button
                className="mini reject danger"
                disabled={mutating}
                onClick={async () => {
                  setMutating(true);
                  try { if (await appStore.clear()) { setConfirmClear(false); setEditActive(false); setSelectedStrokeId(null); setPreviewStrokeId(null); setTransforms({}); } }
                  finally { setMutating(false); }
                }}
              >
                {mutating ? "Clearing…" : "Clear canvas"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
