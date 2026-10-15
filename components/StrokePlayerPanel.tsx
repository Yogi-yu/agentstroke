"use client";

import { memo, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import CanvasView from "@/components/CanvasView";
import { getStrokePlayback } from "@/engine/strokePlayback";
import { MOTION_PATTERN_BY_GEOMETRY } from "@/engine/motionPattern";
import { agentRenderStyle, categoryLabel } from "@/lib/agents";
import type { Agent, AgentProfile, TransitionPath } from "@/lib/types";

const noop = () => {};
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const fmtTime = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

interface Props {
  stroke: TransitionPath;
  agent?: AgentProfile | null;
  onClose?: () => void;
  actions?: ReactNode;
  strokeOptions?: TransitionPath[];
  strokeOptionLabels?: ReadonlyMap<string, string>;
  onSelectStroke?: (id: string) => void;
}

/** Keep the animation clock inside this panel, and reset only for a new ID. */
export default memo(function StrokePlayerPanel(props: Props) {
  return <StrokePlayerContent key={props.stroke.id} {...props} />;
});

function StrokePlayerContent({ stroke, agent, onClose, actions, strokeOptions, strokeOptionLabels, onSelectStroke }: Props) {
  const inputId = useId();
  const [replayKey, setReplayKey] = useState(0);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const paths = useMemo(() => [stroke], [stroke]);
  const agents = useMemo<Agent[]>(() => [{ id: stroke.agent_id, style: agentRenderStyle(agent?.category ?? "coding") }], [stroke.agent_id, agent?.category]);
  const timing = useMemo(() => getStrokePlayback(stroke), [stroke]);

  useEffect(() => {
    setPlaying(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  const onProgress = useCallback((value: number) => {
    setProgress(clamp01(value));
    if (value >= 1) setPlaying(false);
  }, []);
  const replay = useCallback(() => {
    setProgress(0);
    setPlaying(true);
    setReplayKey((key) => key + 1);
  }, []);
  const togglePlayback = useCallback(() => {
    if (progress >= 1) replay();
    else setPlaying((value) => !value);
  }, [progress, replay]);
  const seek = useCallback((value: number) => {
    setPlaying(false);
    setProgress(clamp01(value));
    setReplayKey((key) => key + 1);
  }, []);

  return (
    <div className="stroke-player-panel" role="region" aria-label="Stroke playback">
      <section className="panel sd-section sd-header">
        <div className="stroke-player-heading">
          <div className="sd-h-route"><b>{stroke.from}</b><span className="sd-h-arrow">→</span><b>{stroke.to}</b></div>
          {(actions || onClose) && (
            <div className="stroke-player-actions">
              {actions}
              {onClose && <button type="button" className="sd-playback-button" onClick={onClose} aria-label="Close stroke playback">Close ✕</button>}
            </div>
          )}
        </div>
        <div className="sd-h-meta">
          <span>agent <b>{agent?.name ?? stroke.agent_id}</b></span>
          {agent && <span>{categoryLabel(agent.category)}</span>}
          <span>motion <b>{MOTION_PATTERN_BY_GEOMETRY[stroke.geometry_mode ?? "linear"]}</b></span>
          <span>{new Date(stroke.timestamp ?? stroke.created_at).toLocaleString("en-US", { hour12: false })}</span>
        </div>
        <code className="sd-h-id">{stroke.id}</code>
        {strokeOptions && strokeOptions.length > 1 && onSelectStroke && (
          <label className="stroke-player-switch">
            <span>Stroke</span>
            <select value={stroke.id} onChange={(event) => onSelectStroke(event.target.value)} aria-label="Choose stroke to replay">
              {strokeOptions.map((option) => <option key={option.id} value={option.id}>{strokeOptionLabels?.get(option.id) ?? `${option.from} → ${option.to} · ${new Date(option.timestamp ?? option.created_at).toLocaleTimeString("en-US", { hour12: false })}`}</option>)}
            </select>
          </label>
        )}
      </section>
      <section className="panel sd-section">
        <div className="panel-head">
          <h2>Meteor Playback</h2>
          <span className="sd-playback-status">{progress >= 1 ? "Complete" : playing ? "Playing" : "Paused"}</span>
        </div>
        <div className="sd-canvas">
          <CanvasView paths={paths} agents={agents} selectedStrokeId={null} filterAgentId={null} editMode={false} onSelectStroke={noop} onTransformCommit={noop} playback={{ progress, playing, speed, replayKey, onProgress }} />
        </div>
        <div className="sd-playback" role="group" aria-label="Meteor animation controls">
          <div className="sd-playback-actions">
            <button type="button" className="sd-playback-button sd-playback-primary" onClick={togglePlayback} aria-label={playing ? "Pause animation" : progress >= 1 ? "Play animation again" : "Play animation"}>
              <span aria-hidden="true">{playing ? "Ⅱ" : "▶"}</span> {playing ? "Pause" : "Play"}
            </button>
            <button type="button" className="sd-playback-button" onClick={replay} aria-label="Replay animation from the beginning"><span aria-hidden="true">↺</span> Replay</button>
            <label className="sd-playback-rate"><span>Speed</span>
              <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))} aria-label="Playback speed">
                <option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option>
              </select>
            </label>
          </div>
          <div className="sd-playback-timeline">
            <label className="sd-playback-progress-label" htmlFor={inputId}>Timeline</label>
            <span className="sd-playback-time" aria-label={`${fmtTime(progress * timing.durationMs)} of ${fmtTime(timing.durationMs)}`}>
              {fmtTime(progress * timing.durationMs)} <span>/ {fmtTime(timing.durationMs)}</span>
            </span>
            <input id={inputId} className="sd-playback-range" type="range" min={0} max={1} step={0.001} value={progress} aria-label="Animation timeline" aria-valuetext={`${fmtTime(progress * timing.durationMs)} of ${fmtTime(timing.durationMs)}`}
              onPointerDown={() => setPlaying(false)}
              onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) setPlaying(false); }}
              onChange={(event) => seek(Number(event.target.value))}
            />
          </div>
          <p className="sd-playback-note">Drag the timeline to inspect a moment. {fmtTime(timing.durationMs)} at 1× · {timing.phaseSpeeds.length} speed phases.</p>
        </div>
      </section>
    </div>
  );
}
