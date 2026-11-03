"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import type { CanvasDisplayMode } from "@/engine/canvasPresentation";
import { clampMotionSpeed, motionSpeedLabel, MIN_MOTION_SPEED, MAX_MOTION_SPEED, type SphereViewControls } from "@/engine/playbackControls";
import TrailRetentionControl from "@/components/TrailRetentionControl";

interface Props {
  displayMode: CanvasDisplayMode;
  editMode?: boolean;
  trailRetention: number;
  onTrailRetentionChange: (value: number) => void;
  motionSpeed: number;
  onMotionSpeedChange: (value: number) => void;
  sphereControls: SphereViewControls;
  onSphereControlsChange: (value: SphereViewControls) => void;
  children?: ReactNode;
}

/** One compact, accessible dock below the artwork, never over its surface. */
export default function CanvasPlaybackControls({ displayMode, editMode = false, trailRetention, onTrailRetentionChange,
  motionSpeed, onMotionSpeedChange, sphereControls, onSphereControlsChange, children }: Props) {
  const id = useId();
  const currentControls = useRef({ sphereControls, onSphereControlsChange });
  currentControls.current = { sphereControls, onSphereControlsChange };
  const speed = clampMotionSpeed(motionSpeed);
  const disabled = editMode || displayMode === "static";
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduce = () => {
      if (media.matches) {
        const current = currentControls.current;
        current.onSphereControlsChange({ ...current.sphereControls, autoRotate: false, playing: false });
      }
    };
    reduce(); media.addEventListener("change", reduce);
    return () => media.removeEventListener("change", reduce);
    // Respect the preference on mount/change without overriding later explicit play.
  }, []);

  return <div className="canvas-playback-dock" data-mode={displayMode} role="group" aria-label="Canvas playback controls">
    {displayMode === "sphere" && <div className="sphere-actions" role="group" aria-label="Sphere controls">
      <button type="button" aria-pressed={sphereControls.autoRotate} onClick={() => onSphereControlsChange({ ...sphereControls, autoRotate: !sphereControls.autoRotate })}>Auto-rotate {sphereControls.autoRotate ? "on" : "off"}</button>
      <button type="button" onClick={() => onSphereControlsChange({ ...sphereControls, playing: !sphereControls.playing })}>{sphereControls.playing ? "Pause strokes" : "Play strokes"}</button>
      <button type="button" onClick={() => onSphereControlsChange({ ...sphereControls, resetKey: sphereControls.resetKey + 1 })}>Reset view</button>
    </div>}
    {children ?? <TrailRetentionControl value={trailRetention} onChange={onTrailRetentionChange} editMode={editMode} displayMode={displayMode} />}
    <div className="motion-speed-control">
      <div className="motion-speed-label"><label htmlFor={id}>Motion speed</label><output htmlFor={id}>{motionSpeedLabel(speed)}</output></div>
      <input id={id} type="range" min={MIN_MOTION_SPEED} max={MAX_MOTION_SPEED} step={0.25} value={speed} disabled={disabled}
        aria-describedby={`${id}-help`} aria-valuetext={`${speed} times normal speed`}
        onChange={event => { if (!disabled) onMotionSpeedChange(clampMotionSpeed(Number(event.currentTarget.value))); }} />
      <span id={`${id}-help`} className="control-help">{disabled ? "Available during animated playback." : "Scales stroke animation and automatic sphere rotation together."}</span>
    </div>
  </div>;
}
