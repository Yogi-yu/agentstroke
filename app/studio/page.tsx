"use client";

// ============================================================================
// Home — Semantic stroke generation + agent identity visualization.
// ----------------------------------------------------------------------------
// State-machine driven UI (UIState + EditModeState). Canvas renders strokes;
// left = stroke list/inspector (with Edit Mode); right = generator + agent list.
// Cinematic mode hides ALL UI but the canvas + an exit button.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import CanvasView, { type CanvasHandle } from "@/components/CanvasView";
import StrokeListPanel from "@/components/StrokeListPanel";
import StrokeInspector from "@/components/StrokeInspector";
import EconomicAgentPanel from "@/components/EconomicAgentPanel";
import TrailRetentionControl from "@/components/TrailRetentionControl";
import CanvasPlaybackControls from "@/components/CanvasPlaybackControls";
import StorageNotice from "@/components/StorageNotice";
import type { Agent, EditModeState, StrokeTransform, UIState } from "@/lib/types";
import { agentRenderStyle } from "@/lib/agents";
import { IDENTITY_TRANSFORM } from "@/store/transformStore";
import { appStore, useApp } from "@/state/appStore";
import { readCanvasDisplayMode, type CanvasDisplayMode } from "@/engine/canvasPresentation";
import { ANIMATED_TRAIL_RETENTION, clampTrailRetention } from "@/engine/meteorTrail";
import { DEFAULT_MOTION_SPEED, DEFAULT_SPHERE_CONTROLS, clampMotionSpeed, type SphereViewControls } from "@/engine/playbackControls";

const ROTATE_STEP = Math.PI / 24; // 7.5° per keyboard rotate press

export default function Home() {
  const { agents, strokes, ready, resetRevision } = useApp();

  // ---- global UI state (Feature 5) ----
  const [ui, setUI] = useState<UIState>({
    cinematic_mode: false,
    selected_agent: null,
    selected_stroke: null,
    highlighted_agent_id: null,
    active_mobile_tab: "canvas",
  });
  // ---- edit mode state (Issue 1) ----
  const [edit, setEdit] = useState<EditModeState>({ active: false, selected_stroke_id: null });
  const [transforms, setTransforms] = useState<Record<string, StrokeTransform>>({});
  const transformRequests = useRef(new Map<string, number>());
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef<CanvasHandle>(null);
  const [displayMode, setDisplayMode] = useState<CanvasDisplayMode>("animated");
  const [trailRetention, setTrailRetention] = useState(ANIMATED_TRAIL_RETENTION);
  const [motionSpeed, setMotionSpeed] = useState(DEFAULT_MOTION_SPEED);
  const [sphereControls, setSphereControls] = useState<SphereViewControls>({ ...DEFAULT_SPHERE_CONTROLS });

  useEffect(() => {
    try {
      setDisplayMode(readCanvasDisplayMode(localStorage.getItem("noema.snapshot.display-mode")));
    } catch { /* A disabled browser storage must not prevent changing modes. */ }
    try {
      const saved = localStorage.getItem("noema.snapshot.trail-retention");
      if (saved !== null && saved.trim() !== "") setTrailRetention(clampTrailRetention(Number(saved)));
    } catch { /* Retention remains usable when browser storage is unavailable. */ }
    try {
      const saved = localStorage.getItem("noema.snapshot.motion-speed");
      if (saved !== null && saved.trim() !== "") setMotionSpeed(clampMotionSpeed(Number(saved)));
    } catch { /* Motion remains usable without storage. */ }
  }, []);
  const changeDisplayMode = useCallback((mode: CanvasDisplayMode) => {
    if (edit.active) return;
    setDisplayMode(mode);
    try { localStorage.setItem("noema.snapshot.display-mode", mode); } catch { /* Session-only mode is still usable. */ }
  }, [edit.active]);
  const changeTrailRetention = (value: number) => {
    const retention = clampTrailRetention(value);
    setTrailRetention(retention);
    try { localStorage.setItem("noema.snapshot.trail-retention", String(retention)); } catch { /* Keep the live session preference. */ }
  };
  const changeMotionSpeed = (value: number) => {
    const speed = clampMotionSpeed(value);
    setMotionSpeed(speed);
    try { localStorage.setItem("noema.snapshot.motion-speed", String(speed)); } catch { /* Session-only preference. */ }
  };

  const setCinematic = (on: boolean) => setUI((s) => ({ ...s, cinematic_mode: on }));
  const setMobileTab = (tab: UIState["active_mobile_tab"]) =>
    setUI((s) => ({ ...s, active_mobile_tab: tab }));

  // selection switching is locked while editing. Selecting a stroke also
  // highlights its owning agent in the right panel (Issue 3 — agent coupling).
  const setSelectedStroke = useCallback(
    (id: string | null) => {
      if (edit.active) return; // disable switching to other strokes
      const agentId = id ? strokes.find((s) => s.id === id)?.agent_id ?? null : null;
      setUI((s) => ({ ...s, selected_stroke: id, highlighted_agent_id: agentId }));
    },
    [edit.active, strokes],
  );

  useEffect(() => {
    void appStore.bootstrap();
  }, []);

  useEffect(() => {
    // Renderer preserves the active local preview, but remote removals/clears
    // must still reach an editor instead of trapping it behind a failed save.
    const sync = () => {
      if (document.visibilityState !== "hidden") void appStore.refresh(true);
    };
    const t = setInterval(sync, 3000);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);


  // ---- render adapters: colour is DERIVED from id (emergent), not authored ----
  const renderAgents = useMemo<Agent[]>(
    () => agents.map((a) => ({ id: a.id, style: agentRenderStyle(a.category) })),
    [agents],
  );

  // ---- hide from this canvas; artworks remain in the archive ----
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const clearingRef = useRef(false);

  const resetCanvasUI = useCallback(() => {
    setUI((s) => ({
      ...s,
      selected_agent: null,
      selected_stroke: null,
      highlighted_agent_id: null,
    }));
    setEdit({ active: false, selected_stroke_id: null });
    setTransforms({});
    setConfirmDeleteId(null);
    setConfirmClear(false);
    setClearError(null);
  }, []);

  // A reset in another tab must also discard stale inspectors and edit state.
  useEffect(() => {
    resetCanvasUI();
  }, [resetRevision, resetCanvasUI]);

  useEffect(() => {
    if (ready && edit.active && edit.selected_stroke_id && !strokes.some(stroke => stroke.id === edit.selected_stroke_id)) resetCanvasUI();
  }, [ready, edit.active, edit.selected_stroke_id, strokes, resetCanvasUI]);

  // ---- edit mode controls ----
  const enterEdit = useCallback(
    (id?: string) => {
      const target = id ?? ui.selected_stroke;
      if (!target) return;
      // Geometry editing stays on the original plane. Rotating the sphere is
      // a presentation-only camera gesture, never a persisted stroke edit.
      if (displayMode === "sphere") changeDisplayMode("animated");
      setTransforms({});
      setUI((s) => ({ ...s, selected_stroke: target }));
      setEdit({ active: true, selected_stroke_id: target });
    },
    [ui.selected_stroke, displayMode, changeDisplayMode],
  );
  const exitEdit = useCallback(() => setEdit({ active: false, selected_stroke_id: null }), []);

  // Touch-first: long-pressing a stroke enters edit mode; on mobile, jump to the
  // Canvas tab so the user can immediately drag / pinch / rotate it.
  const onRequestEdit = useCallback((id: string) => {
    if (displayMode === "sphere") changeDisplayMode("animated");
    setTransforms({});
    setUI((s) => ({ ...s, selected_stroke: id, active_mobile_tab: "canvas" }));
    setEdit({ active: true, selected_stroke_id: id });
  }, [displayMode, changeDisplayMode]);

  const saveTransform = useCallback(async (id: string, t: StrokeTransform, immediately = false) => {
    const request = (transformRequests.current.get(id) ?? 0) + 1;
    transformRequests.current.set(id, request);
    setTransforms((m) => ({ ...m, [id]: t }));
    const saved = await appStore.persistTransform(id, t, immediately);
    if (!saved && transformRequests.current.get(id) === request) {
      const confirmed = appStore.getSnapshot().strokes.find((stroke) => stroke.id === id)?.transform ?? IDENTITY_TRANSFORM;
      canvasRef.current?.restoreTransform(id, confirmed);
      setTransforms((m) => ({ ...m, [id]: confirmed }));
    }
    return saved;
  }, []);
  const onTransformCommit = useCallback((id: string, t: StrokeTransform) => { void saveTransform(id, t); }, [saveTransform]);

  // "Save & Exit" (Issue 2 · Step 2): persist the focused stroke's transform,
  // then leave edit mode and re-enable normal interaction.
  const saveAndExit = useCallback(async () => {
    if (saving) return;
    const id = edit.selected_stroke_id;
    setSaving(true);
    try {
      if (id) {
        const t = transforms[id] ?? canvasRef.current?.transformOf(id) ?? IDENTITY_TRANSFORM;
        if (!await saveTransform(id, t, true)) return;
      }
      exitEdit();
    } finally {
      setSaving(false);
    }
  }, [edit.selected_stroke_id, transforms, exitEdit, saveTransform, saving]);

  const onToggleEdit = useCallback(() => {
    if (edit.active) saveAndExit();
    else enterEdit();
  }, [edit.active, saveAndExit, enterEdit]);

  const onResetTransform = useCallback(() => {
    const id = edit.selected_stroke_id;
    if (!id) return;
    canvasRef.current?.resetTransform(id);
    void saveTransform(id, IDENTITY_TRANSFORM);
  }, [edit.selected_stroke_id, saveTransform]);

  // ---- delete handlers ----
  const onRequestDelete = useCallback((id: string) => { appStore.dismissStorageError(); setConfirmDeleteId(id); }, []);
  const onConfirmDelete = useCallback(async () => {
    const id = confirmDeleteId;
    if (!id || removing) return;
    setRemoving(true);
    try {
      if (!await appStore.deleteStroke(id)) return;
      if (edit.selected_stroke_id === id) exitEdit();
      setUI((s) => s.selected_stroke === id ? { ...s, selected_stroke: null, highlighted_agent_id: null } : s);
      setConfirmDeleteId(null);
    } finally { setRemoving(false); }
  }, [confirmDeleteId, edit.selected_stroke_id, exitEdit, removing]);

  // ---- keyboard layer ----
  // Edit active: R / Shift+R rotate, ESC exits edit. Otherwise ESC exits cinematic.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (edit.active) exitEdit();
        else if (ui.cinematic_mode) setCinematic(false);
        return;
      }
      if (edit.active && (e.key === "r" || e.key === "R")) {
        const id = edit.selected_stroke_id;
        if (!id) return;
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        e.preventDefault();
        canvasRef.current?.rotateBy(id, (e.shiftKey ? -1 : 1) * ROTATE_STEP);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [edit.active, edit.selected_stroke_id, ui.cinematic_mode, exitEdit]);

  // Creation does NOT happen on this page — it lives solely on the agent detail
  // page (the only valid creation entry point). This page is view + inspect.
  // Clearing hides this visitor's Snapshot and Sky views, never the archive.
  const onRequestClear = useCallback(() => {
    setClearError(null);
    setConfirmClear(true);
  }, []);
  const onConfirmClear = useCallback(async () => {
    if (clearingRef.current) return;
    clearingRef.current = true;
    setClearing(true);
    setClearError(null);
    try {
      const succeeded = await appStore.clear();
      if (!succeeded) {
        setClearError("Could not clear the strokes. Please try again.");
        return;
      }
      resetCanvasUI();
    } catch {
      setClearError("Could not clear the strokes. Please try again.");
    } finally {
      clearingRef.current = false;
      setClearing(false);
    }
  }, [resetCanvasUI]);

  const selectedStroke = useMemo(
    () => strokes.find((s) => s.id === ui.selected_stroke) ?? null,
    [strokes, ui.selected_stroke],
  );
  const selAgent = agents.find((a) => a.id === selectedStroke?.agent_id);
  const selHue = selAgent ? agentRenderStyle(selAgent.category).hue : 210;
  // Inspector readout: prefer the live local edit, else the stroke's PERSISTED
  // transform (so it's correct immediately after a refresh), else identity.
  const selTransform =
    (ui.selected_stroke && transforms[ui.selected_stroke]) ||
    selectedStroke?.transform ||
    IDENTITY_TRANSFORM;

  const confirmStroke = useMemo(
    () => strokes.find((s) => s.id === confirmDeleteId) ?? null,
    [strokes, confirmDeleteId],
  );

  const cinematic = ui.cinematic_mode;

  return (
    <main className={`app${cinematic ? " cinematic" : ""}`} data-mtab={ui.active_mobile_tab} data-canvas-mode={displayMode}>
      {/* Mobile-only top bar (≤1024px): app title + mode indicator + tab switcher. */}
      {!cinematic && (
        <header className="mobile-topbar">
          <div className="mtb-brand">
            <span className="brand-mark">✦</span>
            <Link href="/" className="studio-home-link">Noema</Link>
            <span className="brand-name">EXP 001 · Agent Snapshot</span>
            <Link href="/protocol" className="studio-protocol-link">Protocol</Link>
            <Link href="/sky" className="studio-protocol-link" aria-label="Sky · 10 or 20 strokes" title="Sky · 10 or 20 strokes">Sky</Link>
            <Link href="/deck" className="studio-protocol-link">Deck</Link>
            {edit.active && <span className="mtb-mode">editing</span>}
          </div>
          <nav className="mtb-tabs" role="tablist" aria-label="View">
            {(["strokes", "canvas", "agents"] as const).map((tab) => (
              <button
                key={tab}
                role="tab"
                aria-selected={ui.active_mobile_tab === tab}
                className={`mtb-tab${ui.active_mobile_tab === tab ? " active" : ""}`}
                onClick={() => setMobileTab(tab)}
              >
                {tab === "strokes" ? "Strokes" : tab === "canvas" ? "Canvas" : "Agents"}
              </button>
            ))}
          </nav>
        </header>
      )}

      <div className="canvas-stage">
        <CanvasView
          ref={canvasRef}
          paths={strokes}
          agents={renderAgents}
          selectedStrokeId={ui.selected_stroke}
          filterAgentId={null}
          editMode={edit.active}
          onSelectStroke={setSelectedStroke}
          onTransformCommit={onTransformCommit}
          onRequestEdit={onRequestEdit}
          displayMode={displayMode}
          trailRetention={trailRetention}
          motionSpeed={motionSpeed}
          sphereControls={sphereControls}
        />

        {!cinematic && (
          <div className="snapshot-display-controls" role="group" aria-label="Canvas display mode">
            <button type="button" disabled={edit.active} aria-pressed={displayMode === "animated"} onClick={() => changeDisplayMode("animated")}>Animated</button>
            <button type="button" disabled={edit.active} aria-pressed={displayMode === "static"} onClick={() => changeDisplayMode("static")}>Static · Final form</button>
            <button type="button" disabled={edit.active} aria-pressed={displayMode === "sphere"} onClick={() => changeDisplayMode("sphere")}>Sphere</button>
          </div>
        )}

        {!cinematic && (
          <CanvasPlaybackControls displayMode={displayMode} editMode={edit.active}
            trailRetention={trailRetention} onTrailRetentionChange={changeTrailRetention}
            motionSpeed={motionSpeed} onMotionSpeedChange={changeMotionSpeed}
            sphereControls={sphereControls} onSphereControlsChange={setSphereControls}>
          <TrailRetentionControl value={trailRetention} onChange={changeTrailRetention} editMode={edit.active} displayMode={displayMode} />
          </CanvasPlaybackControls>
        )}

        {!cinematic && (
          <div className="topbar">
            <div className="brand studio-brand">
              <span className="brand-mark">✦</span>
              <Link href="/" className="studio-home-link">Noema</Link>
              <span className="brand-sub">SHARED CANVAS · NO LOGIN</span>
            </div>
            <div className="topbar-actions">
              <Link href="/sky" className="ghost">Sky</Link>
              <Link href="/protocol" className="ghost">Protocol</Link>
              <Link href="/deck" className="ghost">Deck</Link>
              <button className="ghost" onClick={() => setCinematic(true)}>Cinematic mode</button>
            </div>
          </div>
        )}

        {!cinematic && (
          <div className="hint">
            {!ready
              ? "loading…"
              : edit.active
                ? "edit mode · drag to move · handle or R / Shift+R to rotate · scroll to resize · SPACE / middle-drag to pan · ESC to exit"
                : displayMode === "sphere"
                  ? "sphere view · drag to rotate · click a visible stroke to inspect · edit on the flat canvas"
                : ui.selected_stroke
                  ? "stroke focus — click Edit Mode to transform it"
                  : "post a creative task to attract agents · open an agent to create strokes · click a stroke to inspect"}
          </div>
        )}

        {cinematic && (
          <button className="cinematic-exit" onClick={() => setCinematic(false)}>
            Exit Cinematic Mode
          </button>
        )}

        {/* Mobile edit bar — touch-first exit/reset while editing on the canvas. */}
        {edit.active && (
          <div className="mobile-edit-bar">
            <button className="meb-btn" onClick={onResetTransform}>↺ Reset</button>
            <span className="meb-hint">drag to move · pinch to resize / rotate</span>
            <button className="meb-btn primary" disabled={saving} onClick={saveAndExit}>{saving ? "Saving…" : "✓ Done"}</button>
          </div>
        )}
      </div>

      {!cinematic && (
        <aside className="sidebar left">
          <StorageNotice />
          {selectedStroke && (
            <StrokeInspector
              stroke={selectedStroke}
              hue={selHue}
              agentName={selAgent?.name ?? selectedStroke.agent_id}
              editMode={edit.active}
              transform={selTransform}
              onToggleEdit={onToggleEdit}
              onResetTransform={onResetTransform}
              onClose={() => setSelectedStroke(null)}
            />
          )}
          <StrokeListPanel
            strokes={strokes}
            agents={agents}
            selectedStrokeId={ui.selected_stroke}
            locked={edit.active}
            onSelect={setSelectedStroke}
            onEdit={enterEdit}
            onDelete={onRequestDelete}
            onClear={onRequestClear}
          />
        </aside>
      )}

      {!cinematic && (
        <aside className="sidebar right">
          <EconomicAgentPanel
            disabled={edit.active}
            highlightedAgentId={selectedStroke?.agent_id ?? null}
            selectedStrokeId={selectedStroke?.id ?? null}
          />
        </aside>
      )}

      {/* View-only removal; the original artwork is always retained. */}
      {confirmStroke && (
        <div className="modal-overlay" onClick={() => { if (!removing) setConfirmDeleteId(null); }}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Remove from canvas?</h3>
            <p className="modal-body">This removes the stroke from the shared canvas for everyone. The original stays saved in the Archive and can be restored.</p>
            <p className="modal-target">
              <b>{confirmStroke.from}</b> → <b>{confirmStroke.to}</b>
            </p>
            <StorageNotice />
            <div className="modal-actions">
              <button className="mini" disabled={removing} onClick={() => setConfirmDeleteId(null)}>Cancel</button>
              <button className="mini reject danger" disabled={removing} onClick={onConfirmDelete}>{removing ? "Removing…" : "Remove from canvas"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Clear-canvas confirmation — clears Snapshot and Sky, retaining agents. */}
      {confirmClear && (
        <div className="modal-overlay" onClick={() => { if (!clearing) setConfirmClear(false); }}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Clear the shared canvas?</h3>
            <p className="modal-body">
              This hides the visible strokes in <b>Agent Snapshot and Sky for everyone</b> and stops the current Sky batch.
              Every artwork stays saved in the <Link href="/archive">Archive</Link>, where you can restore it.
              The shared agent pool is not changed. This does not delete any artwork.
            </p>
            {clearError && <p className="modal-body" role="alert">{clearError}</p>}
            <div className="modal-actions">
              <button className="mini" disabled={clearing} onClick={() => setConfirmClear(false)}>Cancel</button>
              <button className="mini reject danger" disabled={clearing} onClick={onConfirmClear}>
                {clearing ? "Clearing…" : "Clear canvas"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
