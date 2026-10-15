"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Agent, StrokeTransform, TransitionPath } from "@/lib/types";
import { StrokeRenderer } from "@/render/strokeRenderer";
import { MeteorRenderer } from "@/render/meteorRenderer";
import { getStrokePlayback, strokeDistanceAtTime, type StrokePlaybackTiming } from "@/engine/strokePlayback";
import { hashStr } from "@/simulation/rng";
import { skyDisplayView, type SkyDisplayBox } from "@/engine/skyLayout";
import { canvasPresentation, type CanvasDisplayMode } from "@/engine/canvasPresentation";
import { strokeDisplayView } from "@/engine/strokeDisplayView";
import { ANIMATED_TRAIL_RETENTION, clampTrailRetention } from "@/engine/meteorTrail";
import { StrokeStore } from "@/state/strokeStore";
import { StrokeEditor } from "@/canvas/StrokeEditor";
import { IDENTITY_TRANSFORM } from "@/store/transformStore";
import {
  type CanvasTransformState,
  DEFAULT_CANVAS_TRANSFORM,
  isDefaultTransform,
  screenToWorld,
  zoomAt,
} from "@/store/canvasTransform";

// Edit-mode "zoom" RESIZES the selected stroke (its transform.scale, about its
// centroid) so the new size persists via the normal commit/Save & Exit pipeline
// — it is NOT a throwaway camera zoom.
const STROKE_MIN_SCALE = 0.2;
const STROKE_MAX_SCALE = 4.0;
const clampStrokeScale = (s: number) => Math.max(STROKE_MIN_SCALE, Math.min(STROKE_MAX_SCALE, s));

export interface CanvasHandle {
  resetTransform: (id: string) => void;
  /** Rotate the stroke by a relative angle (radians) about its centroid — keyboard rotate steps. */
  rotateBy: (id: string, deltaRadians: number) => void;
  /** Current committed transform for a stroke (used by Save & Exit persistence). */
  transformOf: (id: string) => StrokeTransform;
}

interface Props {
  paths: TransitionPath[];
  agents: Agent[];
  selectedStrokeId: string | null;
  /** Agent Filter Mode: when set (and no stroke focused), show only this agent's strokes. */
  filterAgentId: string | null;
  editMode: boolean;
  onSelectStroke: (id: string | null) => void;
  onTransformCommit: (id: string, t: StrokeTransform) => void;
  /** Touch-first: long-pressing a stroke requests entering edit mode on it. */
  onRequestEdit?: (id: string) => void;
  /** Presentation-only positions for a multi-agent sky; never persisted. */
  displayLayout?: ReadonlyMap<string, SkyDisplayBox>;
  /** Static reveals every stroke completely, with a frozen star background. */
  displayMode?: CanvasDisplayMode;
  /** Live Animated tail preference, independent of the stroke's own attributes. */
  trailRetention?: number;
  /** Controlled time fraction. Omit for the continuously animated star field. */
  playback?: {
    progress: number;
    playing: boolean;
    speed: number;
    /** Increment when seeking or replaying to reset the independent clock. */
    replayKey: number;
    onProgress: (progress: number) => void;
  };
}

const CanvasView = forwardRef<CanvasHandle, Props>(function CanvasView({
  paths,
  agents,
  selectedStrokeId,
  filterAgentId,
  editMode,
  onSelectStroke,
  onTransformCommit,
  onRequestEdit,
  playback,
  displayLayout,
  displayMode = "animated",
  trailRetention = ANIMATED_TRAIL_RETENTION,
}: Props, ref) {
  useImperativeHandle(ref, () => ({
    resetTransform(id: string) {
      storeRef.current.updateTransform(id, IDENTITY_TRANSFORM);
      setTick((t) => t + 1);
    },
    rotateBy(id: string, deltaRadians: number) {
      const store = storeRef.current;
      const base = store.transformOf(id);
      const next = { ...base, rotation: base.rotation + deltaRadians };
      store.updateTransform(id, next); // recomputes block + flags dirty GPU range
      onTransformCommit(id, next);
      setTick((t) => t + 1);
    },
    transformOf(id: string) {
      return storeRef.current.transformOf(id);
    },
  }), [onTransformCommit]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const brushCanvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<StrokeRenderer | null>(null);
  const brushRendererRef = useRef<MeteorRenderer | null>(null);
  const playbackRef = useRef(playback);
  const displayLayoutRef = useRef(displayLayout);
  const displayModeRef = useRef(displayMode);
  const trailRetentionRef = useRef(clampTrailRetention(trailRetention));
  const storeRef = useRef<StrokeStore>(new StrokeStore());
  const editorRef = useRef<StrokeEditor | null>(null);
  const selIdRef = useRef<string | null>(selectedStrokeId);
  const filterAgentRef = useRef<string | null>(filterAgentId);
  const editRef = useRef<boolean>(editMode);
  const lastStructRev = useRef<number>(-1);
  // Edit Mode view transform (zoom + pan). Lives in a ref so the rAF render
  // loop reads the latest value every frame without re-subscribing; setTick
  // forces the React overlay/indicator to reflect it after a gesture.
  const viewRef = useRef<CanvasTransformState>({ ...DEFAULT_CANVAS_TRANSFORM });
  const spaceRef = useRef<boolean>(false); // SPACE held → pan gesture armed
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null); // long-press → edit
  const longPressCleanupRef = useRef<(() => void) | null>(null);
  const pathsRef = useRef(paths);
  const agentsRef = useRef(agents);
  const brushDirtyRef = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0); // re-render overlay during gestures

  selIdRef.current = selectedStrokeId;
  filterAgentRef.current = filterAgentId;
  editRef.current = editMode;
  pathsRef.current = paths;
  agentsRef.current = agents;
  playbackRef.current = playback;
  displayLayoutRef.current = displayLayout;
  displayModeRef.current = displayMode;
  trailRetentionRef.current = clampTrailRetention(trailRetention);

  // mount renderer + animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    const brushCanvas = brushCanvasRef.current;
    if (!canvas || !brushCanvas) return;
    let renderer: StrokeRenderer;
    try {
      renderer = new StrokeRenderer(canvas);
    } catch {
      setError("Could not initialize the WebGL2 renderer. Check your browser and graphics settings.");
      return;
    }
    rendererRef.current = renderer;
    editorRef.current = new StrokeEditor(storeRef.current);

    brushRendererRef.current = new MeteorRenderer(brushCanvas);

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      renderer.resize(parent.clientWidth, parent.clientHeight, dpr);
      canvas.style.width = `${parent.clientWidth}px`;
      canvas.style.height = `${parent.clientHeight}px`;
      brushRendererRef.current?.resize(parent.clientWidth, parent.clientHeight, dpr);
      brushDirtyRef.current = true;
    };
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    resize();

    // Stars and meteor ribbons use separate layers; both share the same clock
    // in controlled playback so a paused frame remains completely still.
    renderer.upload(new Float32Array(0), 0);
    lastStructRev.current = storeRef.current.structureRevision;

    let raf = 0;
    let previousTime = 0;
    let initialPaths = true;
    let controlledClock: { id: string; key: number; progress: number } | null = null;
    const flights = new Map<string, { elapsed: number; timing: StrokePlaybackTiming }>();
    const distances = new Map<string, number>();
    const opacities = new Map<string, number>();
    let fittedControls: ReturnType<StrokeStore["controlPointsOf"]> | null = null;
    let fittedView = { ...DEFAULT_CANVAS_TRANSFORM };
    let layoutSource: ReadonlyMap<string, SkyDisplayBox> | undefined;
    let layoutRevision = -1;
    const layoutViews = new Map<string, CanvasTransformState>();
    const readableViews = new Map<string, CanvasTransformState>();
    let lastPresentation: ReturnType<typeof canvasPresentation> | null = null;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const visibilityChanged = () => { previousTime = 0; };
    document.addEventListener("visibilitychange", visibilityChanged);
    const loop = (now: number) => {
      const delta = previousTime === 0 ? 0 : Math.max(0, now - previousTime);
      previousTime = now;
      const store = storeRef.current;
      const d = store.takeDirty();
      if (d) brushDirtyRef.current = true;
      const controls = playbackRef.current;
      const layout = displayLayoutRef.current;
      const presentation = canvasPresentation({
        displayMode: displayModeRef.current,
        controlled: !!controls,
        editing: editRef.current,
        reducedMotion: reducedMotion.matches,
        arranged: !!layout,
      });
      const visiblePaths = pathsRef.current;
      if (layout !== layoutSource || layoutRevision !== store.structureRevision || d) {
        brushDirtyRef.current = true;
        layoutViews.clear();
        layoutSource = layout;
        layoutRevision = store.structureRevision;
        if (layout) for (const path of visiblePaths) {
          const box = layout.get(path.id);
          if (box) layoutViews.set(path.id, skyDisplayView(store.controlPointsOf(path.id), box));
        }
      }
      const unchangedStatic = presentation === "static" && lastPresentation === "static" && !brushDirtyRef.current;
      lastPresentation = presentation;
      if (unchangedStatic) {
        // Static mode is also inexpensive: don't repaint an identical material
        // surface on every frame. Data, resize, selection or edits invalidate it.
        raf = requestAnimationFrame(loop);
        return;
      }
      if (!controls && !layout && brushDirtyRef.current) {
        readableViews.clear();
        const viewport = { width: canvas.clientWidth, height: canvas.clientHeight };
        for (const path of visiblePaths) {
          readableViews.set(path.id, strokeDisplayView(
            store.controlPointsOf(path.id), store.transformOf(path.id), viewport, viewRef.current,
          ));
        }
      }
      const ids = new Set(visiblePaths.map((path) => path.id));
      for (const id of flights.keys()) if (!ids.has(id)) flights.delete(id);
      distances.clear();
      opacities.clear();
      let frameTime = presentation === "static" || reducedMotion.matches ? 0 : now;
      for (const path of visiblePaths) {
        let flight = flights.get(path.id);
        if (!flight) {
          const timing = getStrokePlayback(path);
          // Existing constellations have staggered arrivals. New creations
          // always start at zero when they first enter this canvas.
          const age = Date.now() - path.created_at;
          const elapsed = !layout && initialPaths && age > 30000
            ? (hashStr(path.id) % 1000) / 1000 * timing.durationMs : 0;
          flight = { elapsed, timing };
          flights.set(path.id, flight);
        }
        let timeProgress: number;
        if (presentation === "static" || presentation === "complete") {
          timeProgress = 1;
        } else if (controls) {
          const reset = !controlledClock || controlledClock.id !== path.id || controlledClock.key !== controls.replayKey;
          if (reset) {
            controlledClock = { id: path.id, key: controls.replayKey, progress: controls.progress };
          }
          // Accumulate independently of React commits: slow UI renders must
          // not drop elapsed frames or change a stroke's intrinsic duration.
          const clock = controlledClock!;
          clock.progress = Math.max(0, Math.min(1, !controls.playing
            ? controls.progress
            : clock.progress + (reset ? 0 : delta * controls.speed / flight.timing.durationMs)));
          timeProgress = clock.progress;
          frameTime = timeProgress * flight.timing.durationMs;
          if (controls.playing && path === visiblePaths[0]) controls.onProgress(timeProgress);
        } else if (presentation === "sky") {
          // A comparison sky keeps all ten results visible after arrival.
          // Replaying it resets only this local clock, not model generation.
          flight.elapsed += delta;
          timeProgress = Math.min(1, flight.elapsed / flight.timing.durationMs);
        } else {
          flight.elapsed += delta;
          const cycle = flight.timing.durationMs + 1800;
          const cycleTime = flight.elapsed % cycle;
          timeProgress = Math.min(1, cycleTime / flight.timing.durationMs);
          // Let the arrived meteor burn out before its next flight, instead
          // of keeping a stationary dot and abruptly deleting the whole trail.
          const fade = Math.max(0, Math.min(1, (cycleTime - flight.timing.durationMs) / 1400));
          const arrival = Math.min(1, cycleTime / 180);
          opacities.set(path.id, arrival * (1 - fade * fade * (3 - 2 * fade)));
        }
        distances.set(path.id, strokeDistanceAtTime(timeProgress, flight.timing));
      }
      if (visiblePaths.length) initialPaths = false;
      let renderView = viewRef.current;
      if (controls && visiblePaths[0]) {
        const points = store.controlPointsOf(visiblePaths[0].id);
        if (points !== fittedControls) {
          fittedControls = points;
          if (points.length) {
            const xs = points.map((point) => point.x);
            const ys = points.map((point) => point.y);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            const scale = Math.min(12, 0.78 / Math.max(0.001, maxX - minX), 0.66 / Math.max(0.001, maxY - minY));
            fittedView = { scale, translateX: 0.5 - (minX + maxX) * 0.5 * scale, translateY: 0.5 - (minY + maxY) * 0.5 * scale };
          }
        }
        renderView = fittedView;
      }
      renderer.render(frameTime, -1, -1, renderView);
      if (brushRendererRef.current) {
        brushRendererRef.current.draw(
          frameTime,
          pathsRef.current,
          agentsRef.current,
          store,
          selIdRef.current,
          filterAgentRef.current,
          renderView,
          distances,
          { retainTrace: presentation !== "animated", trailRetention: trailRetentionRef.current, opacityById: opacities,
            viewById: controls ? undefined : layout ? layoutViews : readableViews },
        );
        brushDirtyRef.current = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", visibilityChanged);
      ro.disconnect();
      renderer.dispose();
      brushRendererRef.current?.dispose();
      rendererRef.current = null;
      brushRendererRef.current = null;
    };
  }, []);

  // structural rebuild on data change → full upload
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const store = storeRef.current;
    store.setData(paths, agents);
    renderer.upload(new Float32Array(0), 0);
    brushDirtyRef.current = true;
    lastStructRev.current = store.structureRevision;
    setTick((t) => t + 1);
  }, [paths, agents]);

  // Leaving Edit Mode resets the view to default (scale 1, translate 0,0) so
  // zoom never persists into normal (untransformed) canvas interaction.
  useEffect(() => {
    if (!editMode) {
      viewRef.current = { ...DEFAULT_CANVAS_TRANSFORM };
      brushDirtyRef.current = true;
      setTick((t) => t + 1);
    }
  }, [editMode]);

  useEffect(() => {
    brushDirtyRef.current = true;
  }, [selectedStrokeId, filterAgentId, !!playback, displayLayout, displayMode, trailRetention]);

  // ---- wheel / trackpad-pinch zoom (Edit Mode only) ----
  // Resizes the SELECTED stroke (persists), rather than a throwaway camera zoom.
  // Attached natively so we can preventDefault the page scroll.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (!editRef.current || !selIdRef.current) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015); // smooth multiplicative resize
      scaleSelectedStroke(factor);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // ---- two-finger pinch + pan (touch) ----
  // EDIT MODE  → pinch resizes the selected stroke (persists).
  // VIEW MODE  → pinch zooms the CAMERA + two-finger drag pans it (mobile canvas
  //              navigation). One-finger tap still selects, so this never blocks
  //              selection. Camera view resets when entering/leaving edit mode.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let lastDist = 0;
    let lastMid = { x: 0, y: 0 };
    let lastAngle = 0;
    const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const angle = (a: Touch, b: Touch) => Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
    const midNorm = (a: Touch, b: Touch) =>
      toNorm((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    const onStart = (e: TouchEvent) => {
      if (playbackRef.current) return;
      if (e.touches.length !== 2) return;
      e.preventDefault();
      clearLongPress(); // a second finger cancels any pending long-press-to-edit
      lastDist = dist(e.touches[0], e.touches[1]);
      lastMid = midNorm(e.touches[0], e.touches[1]);
      lastAngle = angle(e.touches[0], e.touches[1]);
    };
    const onMove = (e: TouchEvent) => {
      if (playbackRef.current) return;
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const d = dist(e.touches[0], e.touches[1]);
      const mid = midNorm(e.touches[0], e.touches[1]);
      const ang = angle(e.touches[0], e.touches[1]);
      if (lastDist > 0) {
        const factor = d / lastDist;
        if (editRef.current && selIdRef.current) {
          // EDIT: pinch resizes the stroke, two-finger twist rotates it.
          scaleSelectedStroke(factor);
          let dA = ang - lastAngle;
          if (dA > Math.PI) dA -= 2 * Math.PI;
          else if (dA < -Math.PI) dA += 2 * Math.PI;
          rotateSelectedStroke(dA);
        } else {
          // VIEW: pinch zooms the camera about the midpoint; drift pans it.
          viewRef.current = zoomAt(viewRef.current, mid, viewRef.current.scale * factor);
          viewRef.current = {
            scale: viewRef.current.scale,
            translateX: viewRef.current.translateX + (mid.x - lastMid.x),
            translateY: viewRef.current.translateY + (mid.y - lastMid.y),
          };
          brushDirtyRef.current = true;
        }
        setTick((t) => t + 1);
      }
      lastDist = d;
      lastMid = mid;
      lastAngle = ang;
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) lastDist = 0;
    };
    canvas.addEventListener("touchstart", onStart, { passive: false });
    canvas.addEventListener("touchmove", onMove, { passive: false });
    canvas.addEventListener("touchend", onEnd);
    return () => {
      canvas.removeEventListener("touchstart", onStart);
      canvas.removeEventListener("touchmove", onMove);
      canvas.removeEventListener("touchend", onEnd);
    };
  }, []);

  // ---- SPACE-to-pan arming (Edit Mode only) ----
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && editRef.current && !isTyping(e.target)) {
        if (!spaceRef.current) setTick((t) => t + 1); // refresh cursor
        spaceRef.current = true;
        e.preventDefault(); // stop page scroll while panning
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && spaceRef.current) {
        spaceRef.current = false;
        setTick((t) => t + 1);
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // ---- pointer → normalized SCREEN space ([0,1] of the canvas viewport) ----
  const toNorm = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
  };

  // ---- pointer → normalized WORLD space (inverse of the view transform) ----
  // Readability enlargement is centered on the moving stroke centroid: a drag
  // still moves that centroid 1:1 through the common camera, and uniform local
  // enlargement preserves rotation angles. Do not divide drag deltas by the
  // readability gain. Hit-testing uses the renderer's actual per-stroke view.
  const toWorld = (clientX: number, clientY: number) =>
    screenToWorld(toNorm(clientX, clientY), viewRef.current);

  // ---- resize the SELECTED stroke (persisted) ----
  // Multiplies the stroke's transform.scale about its centroid, then commits so
  // the new size survives Save & Exit + a refresh (this is the zoom-persists fix).
  const scaleSelectedStroke = (factor: number) => {
    const id = selIdRef.current;
    if (!id) return;
    const store = storeRef.current;
    const base = store.transformOf(id);
    const scale = clampStrokeScale(base.scale * factor);
    if (scale === base.scale) return;
    const next = { ...base, scale };
    store.updateTransform(id, next); // live geometry + GPU range
    onTransformCommit(id, next); // mirror + (debounced) persistence
    setTick((t) => t + 1);
  };

  // Rotate the selected stroke by a delta (two-finger rotate gesture), persisted.
  const rotateSelectedStroke = (delta: number) => {
    const id = selIdRef.current;
    if (!id || !delta) return;
    const store = storeRef.current;
    const base = store.transformOf(id);
    const next = { ...base, rotation: base.rotation + delta };
    store.updateTransform(id, next);
    onTransformCommit(id, next);
    setTick((t) => t + 1);
  };

  const clearLongPress = () => {
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; }
    if (longPressCleanupRef.current) { longPressCleanupRef.current(); longPressCleanupRef.current = null; }
  };

  const resetSelectedStrokeScale = () => {
    const id = selIdRef.current;
    if (!id) return;
    const store = storeRef.current;
    const base = store.transformOf(id);
    if (base.scale !== 1) {
      const next = { ...base, scale: 1 };
      store.updateTransform(id, next);
      onTransformCommit(id, next);
    }
    // also recentre the camera pan back to default
    viewRef.current = { ...DEFAULT_CANVAS_TRANSFORM };
    brushDirtyRef.current = true;
    setTick((t) => t + 1);
  };

  const beginGesture = (mode: "drag" | "rotate", id: string, clientX: number, clientY: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    const p = toWorld(clientX, clientY);
    if (mode === "drag") editor.beginDrag(id, p);
    else editor.beginRotate(id, p);

    const onMove = (ev: PointerEvent) => {
      editor.move(toWorld(ev.clientX, ev.clientY));
      setTick((t) => t + 1);
    };
    const onUp = () => {
      const res = editor.end();
      if (res) onTransformCommit(res.id, res.transform);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setTick((t) => t + 1);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ---- pan gesture (canvas drag): SPACE-held or middle-mouse, Edit Mode only ----
  const beginPan = (clientX: number, clientY: number) => {
    const startScreen = toNorm(clientX, clientY);
    const startView = { ...viewRef.current };
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    const onMove = (ev: PointerEvent) => {
      const s = toNorm(ev.clientX, ev.clientY);
      // pan in screen space → translate moves 1:1 with the pointer delta
      viewRef.current = {
        scale: startView.scale,
        translateX: startView.translateX + (s.x - startScreen.x),
        translateY: startView.translateY + (s.y - startScreen.y),
      };
      brushDirtyRef.current = true;
      setTick((t) => t + 1);
    };
    const onUp = () => {
      document.body.style.cursor = prevCursor;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    // Player canvases are inspect-only: let vertical swipes scroll the panel.
    if (playbackRef.current) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Pick the exact visible, rounded ribbon in screen pixels. The old
    // control-point hitmap also selected invisible corners/future geometry.
    const hit = brushRendererRef.current?.hitTest(
      e.clientX - rect.left, e.clientY - rect.top, e.pointerType === "touch" ? 18 : 10,
    ) ?? null;

    // EDIT MODE: this is a TRANSFORMED COORDINATE WORKSPACE.
    if (editRef.current) {
      // Pan takes priority over edit-drag when armed (SPACE or middle mouse).
      if (spaceRef.current || e.button === 1) {
        e.preventDefault();
        beginPan(e.clientX, e.clientY);
        return;
      }
      // EDIT MODE LOCK: selection switching is disabled. The only edit gesture
      // permitted is dragging the stroke currently being edited; clicks on other
      // strokes or empty canvas are ignored (and never exit edit mode).
      const editingId = selIdRef.current;
      if (!editingId) return;
      if (hit === editingId) beginGesture("drag", editingId, e.clientX, e.clientY);
      return; // swallow everything else — no focus/selection leakage
    }

    // VIEW MODE: tap selects the stroke; a long press over it enters edit mode
    // (touch-first). The select fires immediately so a quick tap still selects.
    onSelectStroke(hit);

    clearLongPress();
    if (hit && onRequestEdit) {
      const sx = e.clientX, sy = e.clientY;
      longPressRef.current = setTimeout(() => {
        clearLongPress();
        onRequestEdit(hit);
      }, 500);
      // any meaningful move, release, or second finger cancels the long press
      const onMoveCancel = (ev: PointerEvent) => {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 12) clearLongPress();
      };
      const onEndCancel = () => clearLongPress();
      window.addEventListener("pointermove", onMoveCancel);
      window.addEventListener("pointerup", onEndCancel);
      window.addEventListener("pointercancel", onEndCancel);
      longPressCleanupRef.current = () => {
        window.removeEventListener("pointermove", onMoveCancel);
        window.removeEventListener("pointerup", onEndCancel);
        window.removeEventListener("pointercancel", onEndCancel);
      };
    }
  };

  // ---- editable-node overlay (selected stroke) ----
  const store = storeRef.current;
  const wrap = wrapRef.current;
  let overlay: React.ReactNode = null;
  if (editMode && selectedStrokeId && wrap) {
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    const pts = store.controlPointsOf(selectedStrokeId);
    const v = displayLayout?.get(selectedStrokeId)
      ? skyDisplayView(pts, displayLayout.get(selectedStrokeId)!)
      : strokeDisplayView(pts, store.transformOf(selectedStrokeId), { width: W, height: H }, viewRef.current);
    // The overlay lives in SCREEN space, so map each world control point through
    // the view transform: screen = world * scale + translate (then to px).
    const sx = (wx: number) => (wx * v.scale + v.translateX) * W;
    const sy = (wy: number) => (wy * v.scale + v.translateY) * H;
    const pivot = store.pivotOf(selectedStrokeId);
    if (pts.length && pivot) {
      const px = sx(pivot.x);
      const py = sy(pivot.y);
      const ROT_RADIUS = 46; // px — rotation gizmo ring radius (screen-space)
      const handleX = px;
      const handleY = py - ROT_RADIUS;
      // transform bounding region (optional visual aid), in screen px
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const q of pts) {
        const qx = sx(q.x), qy = sy(q.y);
        minX = Math.min(minX, qx); minY = Math.min(minY, qy);
        maxX = Math.max(maxX, qx); maxY = Math.max(maxY, qy);
      }
      overlay = (
        <svg className="editor-overlay editing" width={W} height={H}>
          <rect
            className="editor-bounds"
            x={minX} y={minY}
            width={maxX - minX} height={maxY - minY}
          />
          <polyline
            className="editor-outline"
            points={pts.map((q) => `${sx(q.x)},${sy(q.y)}`).join(" ")}
          />
          {pts.map((q, i) => (
            <circle key={i} className="editor-node" cx={sx(q.x)} cy={sy(q.y)} r={3.5} />
          ))}
          {/* rotation gizmo — ring the handle sweeps around the centroid */}
          <circle className="editor-rot-ring" cx={px} cy={py} r={ROT_RADIUS} />
          <line className="editor-rot-arm" x1={px} y1={py} x2={handleX} y2={handleY} />
          <circle
            className="editor-rot-handle"
            cx={handleX}
            cy={handleY}
            r={8}
            onPointerDown={(e) => {
              e.stopPropagation();
              beginGesture("rotate", selectedStrokeId, e.clientX, e.clientY);
            }}
          />
          <circle className="editor-pivot" cx={px} cy={py} r={3} />
        </svg>
      );
    }
  }

  if (error) {
    return (
      <div className="webgl-error">
        <p>⚠ WebGL2 unavailable</p>
        <code>{error}</code>
        <span>This renderer requires a WebGL2-capable browser/GPU.</span>
      </div>
    );
  }

  const view = viewRef.current;
  const editCursor = spaceRef.current ? "grab" : "move";
  // HUD reflects the SELECTED stroke's size (its transform.scale), not a camera.
  const strokeScale = editMode && selectedStrokeId
    ? storeRef.current.transformOf(selectedStrokeId).scale
    : 1;
  const resetDisabled = strokeScale === 1 && isDefaultTransform(view);

  return (
    <div ref={wrapRef} className="canvas-wrap" data-display-mode={displayMode}>
      <canvas
        ref={canvasRef}
        onPointerDown={onCanvasPointerDown}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          cursor: playback ? "default" : editMode ? editCursor : "crosshair",
          // never let the browser claim canvas touches → our pinch/pan + tap work
          touchAction: playback ? "pan-y" : "none",
        }}
      />
      <canvas
        ref={brushCanvasRef}
        className="meteor-canvas"
        aria-hidden="true"
      />
      {overlay}
      {editMode && selectedStrokeId && (
        <div className="zoom-hud">
          <button
            className="zoom-btn"
            onClick={() => scaleSelectedStroke(1 / 1.2)}
            disabled={strokeScale <= STROKE_MIN_SCALE + 1e-3}
            title="Shrink stroke"
            aria-label="Shrink stroke"
          >
            −
          </button>
          <span className="zoom-level">{Math.round(strokeScale * 100)}%</span>
          <button
            className="zoom-btn"
            onClick={() => scaleSelectedStroke(1.2)}
            disabled={strokeScale >= STROKE_MAX_SCALE - 1e-3}
            title="Grow stroke"
            aria-label="Grow stroke"
          >
            +
          </button>
          <button
            className="zoom-reset"
            onClick={resetSelectedStrokeScale}
            disabled={resetDisabled}
            title="Reset stroke size"
          >
            ↺ Reset
          </button>
        </div>
      )}
    </div>
  );
});

export default CanvasView;
