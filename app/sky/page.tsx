"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import CanvasView from "@/components/CanvasView";
import CanvasPlaybackControls from "@/components/CanvasPlaybackControls";
import StrokePlayerPanel from "@/components/StrokePlayerPanel";
import { agentRenderStyle } from "@/lib/agents";
import { skyBatchSize, skyTargetCount, type SkyBatch, type SkyMode } from "@/lib/skyBatch";
import { acceptSkySnapshot, readSkyProgress, skyDisplayLayout, skyPresentation } from "@/lib/skyPresentation";
import { canvasRevisionOf, publishCanvasReset, subscribeCanvasReset } from "@/lib/canvasReset";
import type { Agent } from "@/lib/types";
import type { CanvasDisplayMode } from "@/engine/canvasPresentation";
import { ANIMATED_TRAIL_RETENTION } from "@/engine/meteorTrail";
import { DEFAULT_SPHERE_CONTROLS, type SphereViewControls } from "@/engine/playbackControls";

const noop = () => {};
const statusLabel = { queued: "Waiting", running: "Generating", succeeded: "Ready", failed: "Failed" };
const REQUEST_STORAGE = "noema:sky-request-id";
// Application errors are authored in English; browser exceptions may be
// localized and should use the fixed English connection fallback instead.
class SkyRequestError extends Error {}

function rememberRequest(requestId: string | null) {
  try {
    if (requestId) sessionStorage.setItem(REQUEST_STORAGE, requestId);
    else sessionStorage.removeItem(REQUEST_STORAGE);
  } catch { /* Playback also works when storage is unavailable. */ }
}

export default function SkyPage() {
  const [job, setJob] = useState<SkyBatch | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [needsRecovery, setNeedsRecovery] = useState(false);
  const [portrait, setPortrait] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [skyReplayKey, setSkyReplayKey] = useState(0);
  const [displayMode, setDisplayMode] = useState<CanvasDisplayMode>("animated");
  const [skyMode, setSkyMode] = useState<SkyMode>("standard");
  const [motionSpeed, setMotionSpeed] = useState(1);
  const [trailRetention, setTrailRetention] = useState(ANIMATED_TRAIL_RETENTION);
  const [sphereControls, setSphereControls] = useState<SphereViewControls>({ ...DEFAULT_SPHERE_CONTROLS });
  const [canvasRevision, setCanvasRevision] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const requestRef = useRef<AbortController | null>(null);
  const streamActiveRef = useRef(false);
  const expectedRequestRef = useRef<string | null>(null);
  const canvasRevisionRef = useRef<number | null>(null);
  const jobRef = useRef<SkyBatch | null>(null);
  const lifecycleRef = useRef(0);
  const requestStartedAtRef = useRef(0);
  const presentedCanvasRef = useRef<string | null>(null);
  const snapshotSequenceRef = useRef(0);
  const appliedSnapshotRef = useRef(0);

  const resetSky = useCallback((revision: number | null) => {
    lifecycleRef.current++;
    requestRef.current?.abort();
    requestRef.current = null;
    streamActiveRef.current = false;
    busyRef.current = false;
    requestStartedAtRef.current = 0;
    expectedRequestRef.current = null;
    rememberRequest(null);
    if (revision !== null) {
      canvasRevisionRef.current = revision;
      setCanvasRevision(revision);
    }
    jobRef.current = null;
    presentedCanvasRef.current = null;
    setJob(null);
    setSelectedId(null);
    setRequesting(false);
    setNeedsRecovery(false);
    setError("");
  }, []);

  const receiveReset = useCallback((revision: number) => {
    // A delayed signal must not erase a sky explicitly generated after reset.
    const known = Math.max(canvasRevisionRef.current ?? -1, jobRef.current?.canvasRevision ?? -1);
    if (revision > known) resetSky(revision);
  }, [resetSky]);

  const acceptJob = useCallback((incoming: SkyBatch | null) => {
    if (!mountedRef.current || !incoming || !expectedRequestRef.current) return;
    const expected = expectedRequestRef.current;
    if (incoming.requestId !== expected) return;
    const revision = canvasRevisionOf(incoming.canvasRevision);
    if (incoming.status === "cleared") {
      resetSky(revision);
      if (revision !== null) publishCanvasReset(revision);
      return;
    }
    if (revision !== null) {
      if (canvasRevisionRef.current !== null && revision < canvasRevisionRef.current) return;
      canvasRevisionRef.current = revision;
      setCanvasRevision(revision);
    }
    const accepted = acceptSkySnapshot(jobRef.current, incoming, expected);
    jobRef.current = accepted;
    setJob(accepted);
    if (accepted) {
      const identity = accepted.canvasId ?? accepted.id;
      // Restore the saved generation mode once, not on every polling frame.
      // A user may then inspect the same batch in Static or Animated freely.
      if (presentedCanvasRef.current !== identity) {
        presentedCanvasRef.current = identity;
        const restoredMode: SkyMode = skyTargetCount(accepted) === 20 ? "sphere" : "standard";
        setSkyMode(restoredMode);
        setDisplayMode(restoredMode === "sphere" ? "sphere" : "animated");
      }
    }
    setNeedsRecovery(false);
    if (accepted && accepted.status !== "running") {
      // A polling response can finish the job while the transport remains
      // buffered or open. Completion must not leave the controls locked.
      streamActiveRef.current = false;
      busyRef.current = false;
      setRequesting(false);
    }
  }, [resetSky]);

  const loadSnapshot = useCallback(async () => {
    const epoch = lifecycleRef.current;
    const requested = expectedRequestRef.current;
    const sequence = ++snapshotSequenceRef.current;
    // The server's latest public batch is authoritative on every device. A
    // remembered browser request must never pin a visitor to an older sky.
    const response = await fetch("/api/skyBatch", { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new SkyRequestError("Could not read the current sky generation.");
    const data = await response.json();
    // An old latest-job GET may finish after the user has started a new batch.
    if (mountedRef.current && epoch === lifecycleRef.current && requested === expectedRequestRef.current && sequence > appliedSnapshotRef.current) {
      appliedSnapshotRef.current = sequence;
      setConfigured(Boolean(data.configured));
      const revision = canvasRevisionOf(data.canvasRevision);
      const previousRevision = canvasRevisionRef.current;
      if (revision !== null && previousRevision !== null && revision < previousRevision) return;
      if (revision !== null && previousRevision !== null && revision > previousRevision) {
        resetSky(revision);
        publishCanvasReset(revision);
      }
      if (revision !== null) {
        canvasRevisionRef.current = revision;
        setCanvasRevision(revision);
      }
      // Cleared or expired requests must remove a retained completed canvas.
      if (!data.job) {
        // A focus GET can overtake the POST before the server creates its job.
        // Only a newer revision proves a clear while that request is pending.
        if (streamActiveRef.current) {
          setNeedsRecovery(true);
          return;
        }
        if (jobRef.current || expectedRequestRef.current) resetSky(revision);
        return;
      }
      if (data.job.requestId !== expectedRequestRef.current) {
        // A GET can have captured the old latest job before our POST committed
        // and arrive after the new stream completed. Do not move backwards.
        if (jobRef.current && data.job.createdAt < jobRef.current.createdAt) return;
        // A latest-job GET can overtake an as-yet unregistered POST and still
        // contain the previous completed sky. Wait for the POST's first frame
        // or definite conflict; never replace a pending request with that sky.
        const awaitingFirstFrame = streamActiveRef.current && jobRef.current?.requestId !== expectedRequestRef.current;
        if (awaitingFirstFrame) return;
        // Another visitor started a newer batch (or a retry). Follow it and
        // fence late frames from any old transport without starting a POST.
        requestRef.current?.abort();
        requestRef.current = null;
        streamActiveRef.current = false;
        busyRef.current = false;
        setRequesting(false);
        expectedRequestRef.current = data.job.requestId;
        rememberRequest(data.job.requestId);
        jobRef.current = null;
        setSelectedId(null);
      }
      acceptJob(data.job);
      if (jobRef.current && jobRef.current.status !== "running") {
        // GET has confirmed completion, so a stalled stream is unnecessary.
        requestRef.current?.abort();
        requestRef.current = null;
      }
      setNeedsRecovery(false);
    }
  }, [acceptJob, resetSky]);

  useEffect(() => {
    mountedRef.current = true;
    setRequesting(false);
    // Session storage is only an optional last-seen cache, never an identity
    // or a source of truth. Fresh tabs always load the same public sky.
    const epoch = lifecycleRef.current;
    void loadSnapshot().catch(() => { if (mountedRef.current && epoch === lifecycleRef.current) {
      setError("Could not read the current sky generation. Checking again without repeating generation.");
      setNeedsRecovery(true);
    } });
    const media = window.matchMedia("(max-width: 760px)");
    const resize = () => setPortrait(media.matches);
    resize();
    media.addEventListener("change", resize);
    const unsubscribeReset = subscribeCanvasReset(({ canvasRevision: revision }) => receiveReset(revision));
    const reconcile = () => {
      if (document.visibilityState !== "hidden") void loadSnapshot().catch(() => {});
    };
    window.addEventListener("focus", reconcile);
    window.addEventListener("pageshow", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      mountedRef.current = false;
      lifecycleRef.current++;
      requestRef.current?.abort();
      requestRef.current = null;
      streamActiveRef.current = false;
      busyRef.current = false;
      unsubscribeReset();
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("pageshow", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
      media.removeEventListener("change", resize);
    };
  }, [loadSnapshot, receiveReset]);

  // Always reconcile with GET, including before the first frame and while a
  // stream is open: an open connection is not proof that frames are arriving.
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.visibilityState !== "hidden") {
        try { await loadSnapshot(); } catch { /* Keep the visible last-known results. */ }
      }
      if (!disposed) timer = setTimeout(poll, job?.status === "running" || needsRecovery || requesting ? 1500 : 5000);
    };
    timer = setTimeout(poll, job?.status === "running" || needsRecovery || requesting ? 1500 : 5000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [job?.status, needsRecovery, requesting, loadSnapshot]);

  useEffect(() => {
    if (!requesting && job?.status !== "running") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [requesting, job?.status]);

  const generate = useCallback(async (retryFailed = false) => {
    if (busyRef.current || needsRecovery || job?.status === "running" || canvasRevisionRef.current === null) return;
    if (retryFailed && !job?.entries.some((entry) => entry.status === "failed")) return;
    busyRef.current = true;
    streamActiveRef.current = true;
    requestStartedAtRef.current = Date.now();
    setNow(requestStartedAtRef.current);
    const requestId = crypto.randomUUID();
    const epoch = lifecycleRef.current;
    const revision = canvasRevisionRef.current;
    const requestedMode: SkyMode = retryFailed && job ? (skyTargetCount(job) === 20 ? "sphere" : "standard") : skyMode;
    setSkyMode(requestedMode);
    expectedRequestRef.current = requestId;
    rememberRequest(requestId);
    // A retry preserves every successful stroke and its canvas animation state.
    if (!retryFailed) {
      jobRef.current = null; setJob(null);
      setDisplayMode(requestedMode === "sphere" ? "sphere" : "animated");
    }
    setRequesting(true);
    setNeedsRecovery(false);
    setControlsVisible(true);
    setError("");
    setSelectedId(null);
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const isCurrent = () => mountedRef.current && epoch === lifecycleRef.current && requestRef.current === controller && !controller.signal.aborted;
    try {
      const response = await fetch("/api/skyBatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, mode: "autonomous", skyMode: requestedMode, canvasRevision: revision, ...(retryFailed ? { retryOf: job!.requestId } : {}) }),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (!response.ok || !response.headers.get("content-type")?.includes("application/x-ndjson")) {
        const data = await response.json();
        if (!isCurrent()) return;
        if (data.code === "canvas_cleared") {
          const clearedRevision = canvasRevisionOf(data.canvasRevision);
          resetSky(clearedRevision);
          if (clearedRevision !== null) publishCanvasReset(clearedRevision);
          return;
        }
        if ((data.code === "already_retried" || data.code === "active") && data.job) {
          expectedRequestRef.current = data.job.requestId;
          rememberRequest(data.job.requestId);
          jobRef.current = null;
          acceptJob(data.job);
          if (data.code === "active") setError("Another visitor is generating this shared sky. Following its progress; no duplicate generation was started.");
          return;
        }
        if (!response.ok) {
          // A definite rejection made no new job. Keep the previous sky
          // recoverable on refresh; uncertain network failures keep the new ID.
          expectedRequestRef.current = job?.requestId ?? null;
          rememberRequest(expectedRequestRef.current);
          jobRef.current = job;
          setJob(job);
          if (response.status === 409 && data.job && data.job.requestId !== requestId) throw new SkyRequestError("Another batch is still generating. Please wait until it finishes. No duplicate generation was started.");
          throw new SkyRequestError(data.error ?? "The batch could not be started.");
        }
        acceptJob(data.job ?? null);
        return;
      }
      if (!response.body) throw new SkyRequestError("The generation stream is unavailable.");
      await readSkyProgress(response.body, (incoming) => { if (isCurrent()) acceptJob(incoming); });
    } catch (cause) {
      if (isCurrent()) {
        setError(cause instanceof SkyRequestError ? cause.message : "Connection lost. Checking the existing batch; no generation will be repeated.");
        try { await loadSnapshot(); } catch {
          // Even if no initial frame arrived, keep recovering with GET only.
          if (isCurrent()) setNeedsRecovery(true);
        }
      }
    } finally {
      if (isCurrent()) {
        streamActiveRef.current = false;
        busyRef.current = false;
        requestRef.current = null;
        setRequesting(false);
      }
    }
  }, [job, skyMode, needsRecovery, loadSnapshot, acceptJob, resetSky]);

  const entries = job?.entries ?? [];
  const presentation = useMemo(() => skyPresentation(job, requesting, skyReplayKey, skyMode), [job, requesting, skyReplayKey, skyMode]);
  const { paths, succeeded, failed, completed, running, targetCount } = presentation;
  const nextCount = skyBatchSize(skyMode);
  const generationLocked = running || requesting || needsRecovery;
  const chooseSkyMode = (mode: SkyMode) => {
    if (generationLocked) return;
    setSkyMode(mode);
    setDisplayMode(mode === "sphere" ? "sphere" : "animated");
  };
  const agents = useMemo<Agent[]>(() => [...new Map(job?.entries.map(({ agent }) => [agent.id, { id: agent.id, style: agentRenderStyle(agent.category) }] as const) ?? []).values()], [job]);
  const strokeOptionLabels = useMemo(() => new Map(
    job?.entries.flatMap((entry, index) => entry.stroke
      ? [[entry.stroke.id, `Stroke ${index + 1} · ${entry.agent.name} · ${entry.stroke.from} → ${entry.stroke.to}`] as const]
      : []) ?? [],
  ), [job]);
  const layoutKey = entries.map((entry) => entry.stroke?.id ?? "").join("|");
  const displayLayout = useMemo(() => skyDisplayLayout(layoutKey.split("|"), portrait, targetCount), [layoutKey, portrait, targetCount]);
  const selected = entries.find((entry) => entry.stroke?.id === selectedId);
  const active = presentation.activeEntry;
  const elapsedStart = active?.startedAt ?? job?.createdAt ?? requestStartedAtRef.current;
  const elapsedSeconds = Math.max(0, Math.floor((now - (elapsedStart || now)) / 1000));
  const elapsed = elapsedSeconds < 60 ? `${elapsedSeconds}s` : `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`;

  return (
    <main className="sky-page" data-sky-mode={skyMode} data-sky-state={running ? "generating" : presentation.showCanvas ? "ready" : "empty"}>
      <header className="sky-nav">
        <nav className="sky-primary-links" aria-label="Platform navigation">
          <Link href="/studio" className="sky-back" aria-label="Back to Agent Snapshot">← Snapshot</Link>
          <Link href="/deck" className="sky-deck-link">Deck</Link>
        </nav>
        <div className="sky-nav-actions">
          <button type="button" disabled={paths.length === 0} onClick={() => {
            setSphereControls(controls => ({ ...controls, playing: true }));
            setSkyReplayKey((key) => key + 1);
          }}>Replay sky</button>
          <button type="button" onClick={() => setControlsVisible((value) => !value)}>{controlsVisible ? "Hide controls" : "Show controls"}</button>
        </div>
      </header>
      <div className="sky-content">
        {controlsVisible && <section className="sky-console" aria-label="Star field generation">
          <div className="sky-heading"><h1>Sky</h1><p>The latest public batch. Live across devices. No login.</p></div>
          <div className="sky-generation-modes" role="group" aria-label="Sky generation mode">
            <button type="button" disabled={generationLocked} aria-pressed={skyMode === "standard"} onClick={() => chooseSkyMode("standard")}>
              <strong>Standard sky</strong><span>10 strokes · Open canvas</span>
            </button>
            <button type="button" disabled={generationLocked} aria-pressed={skyMode === "sphere"} onClick={() => chooseSkyMode("sphere")}>
              <strong>Spherical sky</strong><span>20 strokes · One rotating sphere</span>
            </button>
          </div>
          <form className="sky-generate" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
            <p className="sky-autonomy">Each agent chooses its own starting word, ending word, and wandering steps. One English word per step. Brief and extended journeys create distinctly different stroke lengths.</p>
            <button type="submit" disabled={generationLocked || !configured || canvasRevision === null}>{running ? `Generating ${completed}/${targetCount}` : `Generate ${nextCount} strokes`}</button>
          </form>
          {!job && !running && <p className="sky-note">Create {nextCount} strokes using the shared agents in one request. Each stroke appears for everyone as soon as it is ready. No new agents are added.</p>}
        </section>}
        {configured === false && <p className="sky-error">Configure OPENROUTER_API_KEY to generate real agent strokes.</p>}
        {error && <p className="sky-error" role="alert">{error}</p>}
        {needsRecovery && <p className="sky-note" role="status">Reconnecting to the existing request. No generation will be repeated.</p>}
        {presentation.showProgress && <section className={`sky-progress${running ? " is-running" : ""}`} aria-label="Generation progress" aria-live="polite">
          <div className="sky-progress-heading"><h2>{presentation.headline}</h2><span>{Math.round(completed / targetCount * 100)}%</span></div>
          <progress value={completed} max={targetCount} aria-label="Stroke generation progress" aria-valuetext={`${completed}/${targetCount} completed, ${succeeded} succeeded, ${failed} failed`} />
          {running && <div className="sky-active" role="status">
            <span className="sky-active-indicator" aria-hidden="true" />
            <div className="sky-active-copy">
              <strong>{active ? `Creating stroke ${presentation.activeIndex + 1} of ${targetCount}` : job ? "Preparing the next stroke" : "Starting generation"}</strong>
              <small>{active ? `${active.agent.name} · Attempt ${active.attempts ?? 1} · ` : "Waiting for the next update · "}<span aria-live="off">{elapsed} {active?.startedAt ? "elapsed" : "batch elapsed"}</span></small>
            </div>
          </div>}
          <p>Completed {completed}/{targetCount} · Succeeded {succeeded} · Failed {failed}{running ? " · Drawing each stroke as it arrives" : failed ? " · Showing successful results only" : " · All strokes are ready"}</p>
          {failed > 0 && !running && <button type="button" className="sky-retry" disabled={!configured || generationLocked} onClick={() => { void generate(true); }}>{requesting ? "Starting retry…" : `Retry failed (${failed})`}</button>}
        </section>}
        {presentation.showCanvas ? (
          <section className="sky-artwork" aria-label="Generated sky">
            <div className="sky-display-controls" role="group" aria-label="Sky display mode">
              <button type="button" aria-pressed={displayMode === "animated"} onClick={() => setDisplayMode("animated")}>Animated</button>
              <button type="button" aria-pressed={displayMode === "static"} onClick={() => setDisplayMode("static")}>Static · Final form</button>
              <button type="button" aria-pressed={displayMode === "sphere"} onClick={() => setDisplayMode("sphere")}>Sphere</button>
            </div>
            <div className="sky-canvas">
              <CanvasView key={presentation.canvasKey} paths={paths} agents={agents} selectedStrokeId={null} filterAgentId={null} editMode={false} onSelectStroke={setSelectedId} onTransformCommit={noop} displayLayout={displayLayout} displayMode={displayMode} trailRetention={trailRetention} motionSpeed={motionSpeed} sphereControls={sphereControls} />
            </div>
            <CanvasPlaybackControls displayMode={displayMode} trailRetention={trailRetention} onTrailRetentionChange={setTrailRetention}
              motionSpeed={motionSpeed} onMotionSpeedChange={setMotionSpeed} sphereControls={sphereControls} onSphereControlsChange={setSphereControls} />
          </section>
        ) : <p className="sky-empty" role="status">{running ? "Waiting for the first stroke. Drawing will begin below as soon as it arrives." : job ? "This batch produced no strokes to display. Check the failure details below." : `Select Generate ${nextCount} strokes to begin. The canvas appears when the first stroke is ready.`}</p>}
        {controlsVisible && job && <details className="sky-results">
          <summary>This sky · {succeeded} strokes{failed ? ` · ${failed} failed` : ""}</summary>
          <div className="sky-result-list">
            {entries.map((entry, index) => <div className={`sky-result ${entry.status}`} key={`${job.canvasId ?? job.id}:slot-${index}`}>
              <span className="sky-result-index">{String(index + 1).padStart(2, "0")}</span>
              <div><Link href={`/agent/${entry.agent.id}`}>{entry.agent.name}</Link><small>{entry.agent.model_type} · {entry.status === "running" && (entry.attempts ?? 1) > 1 ? `Retrying (${entry.attempts}/2)` : statusLabel[entry.status]}</small>{entry.stroke && <p className="sky-result-path">{entry.stroke.from} → {entry.stroke.to} · {entry.stroke.points.length} steps{entry.stroke.brush_treatment === "calligraphy" ? " · Calligraphy brush" : ""}</p>}{entry.error && <p>{entry.error}</p>}</div>
              {entry.stroke && <button type="button" onClick={() => setSelectedId(entry.stroke!.id)}>Replay</button>}
            </div>)}
          </div>
        </details>}
      </div>
      {selected?.stroke && <aside className="sky-player"><StrokePlayerPanel stroke={selected.stroke} agent={selected.agent} onClose={() => setSelectedId(null)} strokeOptions={paths} strokeOptionLabels={strokeOptionLabels} onSelectStroke={setSelectedId} /></aside>}
    </main>
  );
}
