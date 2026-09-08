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
import type { Agent, EditModeState, StrokeTransform, UIState } from "@/lib/types";
import { agentRenderStyle } from "@/lib/agents";
import { IDENTITY_TRANSFORM } from "@/store/transformStore";
import { appStore, useApp } from "@/state/appStore";

const ROTATE_STEP = Math.PI / 24; // 7.5° per keyboard rotate press

export default function Home() {
  const { agents, strokes, ready } = useApp();

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
  const canvasRef = useRef<CanvasHandle>(null);

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
    appStore.bootstrap();
    const t = setInterval(() => appStore.refresh(), 6000);
    return () => clearInterval(t);
  }, []);


  // ---- render adapters: colour is DERIVED from id (emergent), not authored ----
  const renderAgents = useMemo<Agent[]>(
    () => agents.map((a) => ({ id: a.id, style: agentRenderStyle(a.category) })),
    [agents],
  );

  // ---- delete (Issue 1) — confirmation-gated, then GLOBAL removal ----
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  // ---- edit mode controls ----
  const enterEdit = useCallback(
    (id?: string) => {
      const target = id ?? ui.selected_stroke;
      if (!target) return;
      setUI((s) => ({ ...s, selected_stroke: target }));
      setEdit({ active: true, selected_stroke_id: target });
    },
    [ui.selected_stroke],
  );
  const exitEdit = useCallback(() => setEdit({ active: false, selected_stroke_id: null }), []);

  // Touch-first: long-pressing a stroke enters edit mode; on mobile, jump to the
  // Canvas tab so the user can immediately drag / pinch / rotate it.
  const onRequestEdit = useCallback((id: string) => {
    setUI((s) => ({ ...s, selected_stroke: id, active_mobile_tab: "canvas" }));
    setEdit({ active: true, selected_stroke_id: id });
  }, []);

  // Every edit operation (drag / rotate / keyboard) writes back immediately:
  // local mirror for live UI + server for durability across refresh (Issue 2).
  const onTransformCommit = useCallback((id: string, t: StrokeTransform) => {
    setTransforms((m) => ({ ...m, [id]: t }));
    void appStore.persistTransform(id, t);
  }, []);

  // "Save & Exit" (Issue 2 · Step 2): persist the focused stroke's transform,
  // then leave edit mode and re-enable normal interaction.
  const saveAndExit = useCallback(() => {
    const id = edit.selected_stroke_id;
    if (id) {
      const t = transforms[id] ?? canvasRef.current?.transformOf(id) ?? IDENTITY_TRANSFORM;
      void appStore.persistTransform(id, t);
    }
    exitEdit();
  }, [edit.selected_stroke_id, transforms, exitEdit]);

  const onToggleEdit = useCallback(() => {
    if (edit.active) saveAndExit();
    else enterEdit();
  }, [edit.active, saveAndExit, enterEdit]);

  const onResetTransform = useCallback(() => {
    const id = edit.selected_stroke_id;
    if (!id) return;
    canvasRef.current?.resetTransform(id);
    setTransforms((m) => ({ ...m, [id]: IDENTITY_TRANSFORM }));
    void appStore.persistTransform(id, IDENTITY_TRANSFORM);
  }, [edit.selected_stroke_id]);

  // ---- delete handlers ----
  const onRequestDelete = useCallback((id: string) => setConfirmDeleteId(id), []);
  const onConfirmDelete = useCallback(() => {
    const id = confirmDeleteId;
    if (!id) return;
    if (edit.selected_stroke_id === id) exitEdit();
    setUI((s) =>
      s.selected_stroke === id ? { ...s, selected_stroke: null, highlighted_agent_id: null } : s,
    );
    void appStore.deleteStroke(id);
    setConfirmDeleteId(null);
  }, [confirmDeleteId, edit.selected_stroke_id, exitEdit]);

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
  // Clearing the canvas is gated behind a confirmation (it wipes every stroke).
  const onRequestClear = useCallback(() => setConfirmClear(true), []);
  const onConfirmClear = useCallback(() => {
    setUI((s) => ({ ...s, selected_stroke: null }));
    exitEdit();
    void appStore.clear();
    setConfirmClear(false);
  }, [exitEdit]);

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
    <main className={`app${cinematic ? " cinematic" : ""}`} data-mtab={ui.active_mobile_tab}>
      {/* Mobile-only top bar (≤1024px): app title + mode indicator + tab switcher. */}
      {!cinematic && (
        <header className="mobile-topbar">
          <div className="mtb-brand">
            <span className="brand-mark">✦</span>
            <Link href="/" className="studio-home-link">Noema</Link>
            <span className="brand-name">EXP 001 · Agent Snapshot</span>
            <Link href="/protocol" className="studio-protocol-link">Protocol</Link>
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
        />

        {!cinematic && (
          <div className="topbar">
            <div className="brand studio-brand">
              <span className="brand-mark">✦</span>
              <Link href="/" className="studio-home-link">Noema</Link>
              <span className="brand-sub">EXPERIMENT 001 · AGENT SNAPSHOT</span>
            </div>
            <div className="topbar-actions">
              <Link href="/protocol" className="ghost">Protocol</Link>
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
            <button className="meb-btn primary" onClick={saveAndExit}>✓ Done</button>
          </div>
        )}
      </div>

      {!cinematic && (
        <aside className="sidebar left">
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
            highlightedAgentId={ui.highlighted_agent_id}
          />
        </aside>
      )}

      {/* Delete confirmation (Issue 1) — gates the GLOBAL stroke removal. */}
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
              <button className="mini reject danger" onClick={onConfirmClear}>Clear canvas</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
