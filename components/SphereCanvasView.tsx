"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Agent, TransitionPath } from "@/lib/types";
import type { CanvasHandle } from "./CanvasView";
import { StrokeStore } from "@/state/strokeStore";
import { MeteorRenderer, type MeteorStrokeSource } from "@/render/meteorRenderer";
import { SphereRenderer } from "@/render/sphereRenderer";
import { getStrokePlayback, strokeDistanceAtTime, type StrokePlaybackTiming } from "@/engine/strokePlayback";
import { clampTrailRetention, ANIMATED_TRAIL_RETENTION } from "@/engine/meteorTrail";
import { clampSphereZoom, sphereRadius, type SphereRotation } from "@/engine/sphereProjection";
import { sphereStrokeControls, SPHERE_ATLAS_WIDTH, SPHERE_ATLAS_HEIGHT } from "@/engine/sphereLayout";
import { DEFAULT_CANVAS_TRANSFORM } from "@/store/canvasTransform";
import { hashStr } from "@/simulation/rng";
import { DEFAULT_MOTION_SPEED, scaledMotionDelta, type SphereViewControls } from "@/engine/playbackControls";

interface Props {
  paths: TransitionPath[];
  agents: Agent[];
  selectedStrokeId: string | null;
  filterAgentId: string | null;
  onSelectStroke: (id: string | null) => void;
  trailRetention?: number;
  motionSpeed?: number;
  sphereControls?: SphereViewControls;
  /** Arranged Sky replays start together at zero; open canvases are staggered. */
  staggerExisting?: boolean;
}
const INITIAL_ROTATION: SphereRotation = { yaw: 0, pitch: -0.18 };
const clampPitch = (n: number) => Math.max(-Math.PI / 2, Math.min(Math.PI / 2, n));

/** Uses the real meteor brush atlas. No new artwork, synthetic paths or writes. */
const SphereCanvasView = forwardRef<CanvasHandle, Props>(function SphereCanvasView({
  paths, agents, selectedStrokeId, filterAgentId, onSelectStroke,
  trailRetention = ANIMATED_TRAIL_RETENTION,
  motionSpeed = DEFAULT_MOTION_SPEED, sphereControls, staggerExisting = true,
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SphereRenderer | null>(null);
  const brushRef = useRef<MeteorRenderer | null>(null);
  const storeRef = useRef(new StrokeStore());
  const dataRef = useRef({ paths, agents, filterAgentId, trailRetention, motionSpeed, staggerExisting });
  const rotation = useRef({ ...INITIAL_ROTATION });
  const homeRotation = useRef({ ...INITIAL_ROTATION });
  const zoom = useRef(1);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const autoRef = useRef(true);
  const playingRef = useRef(true);
  const dirtyRef = useRef(true);
  const [autoRotate, setAutoRotate] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  dataRef.current = { paths, agents, filterAgentId, trailRetention, motionSpeed, staggerExisting };
  autoRef.current = sphereControls?.autoRotate ?? autoRotate;
  playingRef.current = sphereControls?.playing ?? playing;
  useEffect(() => {
    rotation.current = { ...homeRotation.current };
    zoom.current = 1;
  }, [sphereControls?.resetKey]);

  // Sphere is inspect-only. Editing switches back to the planar workspace.
  useImperativeHandle(ref, () => ({
    transformOf: id => storeRef.current.transformOf(id),
    restoreTransform: (id, transform) => { storeRef.current.updateTransform(id, transform); dirtyRef.current = true; },
    resetTransform: () => {},
    rotateBy: () => {},
  }), []);

  useEffect(() => {
    storeRef.current.setData(paths, agents);
    dirtyRef.current = true;
  }, [paths, agents]);
  useEffect(() => { dirtyRef.current = true; }, [filterAgentId, trailRetention]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const atlas = document.createElement("canvas");
    let renderer: SphereRenderer;
    let brush: MeteorRenderer;
    try {
      renderer = new SphereRenderer(canvas);
      brush = new MeteorRenderer(atlas);
      brush.resize(SPHERE_ATLAS_WIDTH, SPHERE_ATLAS_HEIGHT, 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not initialize the sphere renderer.");
      return;
    }
    rendererRef.current = renderer;
    brushRef.current = brush;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reducedMotion.matches) { setAutoRotate(false); setPlaying(false); }
    const preferenceChanged = () => {
      if (reducedMotion.matches) { setAutoRotate(false); setPlaying(false); }
      dirtyRef.current = true;
    };
    reducedMotion.addEventListener("change", preferenceChanged);
    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      renderer.resize(parent.clientWidth, parent.clientHeight, window.devicePixelRatio || 1);
      dirtyRef.current = true;
    };
    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    resize();

    const cache = new Map<string, { original: ReturnType<StrokeStore["controlPointsOf"]>; surface: ReturnType<typeof sphereStrokeControls> }>();
    const surfaceStore: MeteorStrokeSource = {
      transformOf: id => storeRef.current.transformOf(id),
      controlPointsOf: id => {
        const original = storeRef.current.controlPointsOf(id);
        let entry = cache.get(id);
        if (!entry || entry.original !== original) {
          entry = { original, surface: sphereStrokeControls(id, original) };
          cache.set(id, entry);
        }
        return entry.surface;
      },
    };
    const flights = new Map<string, { elapsed: number; timing: StrokePlaybackTiming }>();
    const progress = new Map<string, number>();
    const opacity = new Map<string, number>();
    let firstFrame = true;
    let oriented = false;
    let previous = 0;
    let raf = 0;
    let previousPlaying = playingRef.current;
    const visibilityChanged = () => { previous = 0; };
    document.addEventListener("visibilitychange", visibilityChanged);
    const loop = (now: number) => {
      const delta = previous && !document.hidden ? Math.min(100, now - previous) : 0;
      previous = now;
      const data = dataRef.current;
      const motionDelta = scaledMotionDelta(delta, data.motionSpeed);
      // Open toward an actual work, not an arbitrary empty rear hemisphere.
      // Later arrivals never move the user's camera or change stored geometry.
      if (!oriented && data.paths.length) {
        const first = surfaceStore.controlPointsOf(data.paths[0].id);
        if (first.length) {
          const u = (Math.min(...first.map(p => p.x)) + Math.max(...first.map(p => p.x))) / 2;
          const v = (Math.min(...first.map(p => p.y)) + Math.max(...first.map(p => p.y))) / 2;
          homeRotation.current = { yaw: -(u - 0.5) * Math.PI * 2, pitch: (0.5 - v) * Math.PI };
          rotation.current = { ...homeRotation.current };
          oriented = true;
        }
      }
      const active = new Set(data.paths.map(path => path.id));
      for (const id of flights.keys()) if (!active.has(id)) { flights.delete(id); cache.delete(id); }
      if (previousPlaying !== playingRef.current) dirtyRef.current = true;
      previousPlaying = playingRef.current;
      if (playingRef.current || dirtyRef.current) {
        progress.clear(); opacity.clear();
        for (const path of data.paths) {
          let flight = flights.get(path.id);
          const newFlight = !flight;
          if (!flight) {
            const timing = getStrokePlayback(path);
            const existing = firstFrame && data.staggerExisting && Date.now() - path.created_at > 30000;
            flight = { timing, elapsed: existing ? ((hashStr(path.id) % 1000) / 1000) * timing.durationMs : 0 };
            flights.set(path.id, flight);
          }
          if (playingRef.current && !newFlight) flight.elapsed += motionDelta;
          const cycle = flight.elapsed % (flight.timing.durationMs + 1800);
          const distance = strokeDistanceAtTime(Math.min(1, cycle / flight.timing.durationMs), flight.timing);
          const fading = Math.max(0, Math.min(1, (cycle - flight.timing.durationMs) / 1400));
          const showComplete = reducedMotion.matches && !playingRef.current;
          progress.set(path.id, showComplete ? 1 : distance);
          opacity.set(path.id, showComplete ? 1 : Math.min(1, cycle / 180) * (1 - fading * fading * (3 - 2 * fading)));
        }
        brush.draw(now, data.paths, data.agents, surfaceStore, null, data.filterAgentId,
          DEFAULT_CANVAS_TRANSFORM, progress, {
            retainTrace: reducedMotion.matches && !playingRef.current,
            trailRetention: clampTrailRetention(data.trailRetention), opacityById: opacity,
          });
        dirtyRef.current = false;
        if (data.paths.length) firstFrame = false;
      }
      if (autoRef.current && pointers.current.size === 0 && !document.hidden) rotation.current.yaw += motionDelta * 0.00007;
      // Bound long-running rotations without affecting their visible orientation.
      rotation.current.yaw %= Math.PI * 2;
      renderer.draw(atlas, rotation.current, zoom.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom.current = clampSphereZoom(zoom.current * Math.exp(-event.deltaY * 0.001));
    };
    const contextLost = (event: Event) => {
      event.preventDefault(); cancelAnimationFrame(raf);
      setError("The graphics context was interrupted. Switch to Animated, then reopen Sphere to retry.");
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("webglcontextlost", contextLost);
    return () => {
      cancelAnimationFrame(raf); observer.disconnect();
      document.removeEventListener("visibilitychange", visibilityChanged);
      reducedMotion.removeEventListener("change", preferenceChanged);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("webglcontextlost", contextLost);
      brush.dispose(); renderer.dispose();
      rendererRef.current = null; brushRef.current = null;
      pointers.current.clear();
    };
  }, []);

  const finishPointer = (event: React.PointerEvent<HTMLCanvasElement>, cancelled = false) => {
    if (!pointers.current.has(event.pointerId)) return;
    if (!cancelled && pointers.current.size === 1 && gesture.current && !gesture.current.moved) {
      const rect = event.currentTarget.getBoundingClientRect();
      const uv = rendererRef.current?.hitUV(event.clientX - rect.left, event.clientY - rect.top, rotation.current, zoom.current);
      const tolerance = 10 * SPHERE_ATLAS_WIDTH / (Math.PI * 2 * sphereRadius(rect.width, rect.height, zoom.current));
      onSelectStroke(uv ? brushRef.current?.hitTest(uv.u * SPHERE_ATLAS_WIDTH, uv.v * SPHERE_ATLAS_HEIGHT, tolerance) ?? null : null);
    }
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) { gesture.current = null; setDragging(false); }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div className={`canvas-wrap sphere-view${sphereControls ? " has-external-controls" : ""}`} data-display-mode="sphere" data-stroke-count={paths.length}>
      <div className="sphere-viewport">
        <canvas ref={canvasRef} role="img" aria-label="Animated artwork on a rotatable 3D sphere. Drag or use arrow keys to rotate; scroll or pinch to zoom."
          tabIndex={0} className={dragging ? "is-dragging" : ""}
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (!gesture.current) gesture.current = { x: event.clientX, y: event.clientY, moved: false };
            if (pointers.current.size > 1) gesture.current.moved = true;
            setDragging(true);
          }}
          onPointerMove={event => {
            const prior = pointers.current.get(event.pointerId);
            if (!prior) return;
            const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
            if (other) {
              const before = Math.hypot(prior.x - other.x, prior.y - other.y);
              const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
              if (before > 1) zoom.current = clampSphereZoom(zoom.current * after / before);
            }
            rotation.current.yaw += (event.clientX - prior.x) * 0.007;
            rotation.current.pitch = clampPitch(rotation.current.pitch + (event.clientY - prior.y) * 0.007);
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (gesture.current && Math.hypot(event.clientX - gesture.current.x, event.clientY - gesture.current.y) > 5) gesture.current.moved = true;
          }}
          onPointerUp={event => finishPointer(event)}
          onPointerCancel={event => finishPointer(event, true)}
          onLostPointerCapture={event => finishPointer(event, true)}
          onKeyDown={event => {
            const step = event.shiftKey ? 0.3 : 0.12;
            if (event.key === "ArrowLeft") rotation.current.yaw -= step;
            else if (event.key === "ArrowRight") rotation.current.yaw += step;
            else if (event.key === "ArrowUp") rotation.current.pitch = clampPitch(rotation.current.pitch - step);
            else if (event.key === "ArrowDown") rotation.current.pitch = clampPitch(rotation.current.pitch + step);
            else if (event.key === "+" || event.key === "=") zoom.current = clampSphereZoom(zoom.current * 1.1);
            else if (event.key === "-") zoom.current = clampSphereZoom(zoom.current / 1.1);
            else return;
            event.preventDefault();
          }} />
      </div>
      {error ? <div className="sphere-error" role="alert">{error}</div> : !sphereControls && <div className="sphere-toolbar">
        <div className="sphere-actions" role="group" aria-label="Sphere controls">
          <button type="button" aria-pressed={autoRotate} onClick={() => setAutoRotate(value => !value)}>Auto-rotate {autoRotate ? "on" : "off"}</button>
          <button type="button" onClick={() => setPlaying(value => !value)}>{playing ? "Pause strokes" : "Play strokes"}</button>
          <button type="button" onClick={() => { rotation.current = { ...homeRotation.current }; zoom.current = 1; }}>Reset view</button>
        </div>
        <p>Drag to rotate · Scroll or pinch to zoom</p>
        <span>{paths.length} {paths.length === 1 ? "stroke" : "strokes"} · Surface only{selectedStrokeId ? " · Stroke selected" : ""}</span>
      </div>}
    </div>
  );
});

export default SphereCanvasView;
