"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import CanvasView from "@/components/CanvasView";
import StrokePlayerPanel from "@/components/StrokePlayerPanel";
import { agentRenderStyle } from "@/lib/agents";
import { SKY_BATCH_SIZE, type SkyBatch } from "@/lib/skyBatch";
import { acceptSkySnapshot, readSkyProgress, skyDisplayLayout, skyPresentation } from "@/lib/skyPresentation";
import { canvasRevisionOf, publishCanvasReset, subscribeCanvasReset } from "@/lib/canvasReset";
import type { Agent } from "@/lib/types";

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
  const [from, setFrom] = useState("chaos");
  const [to, setTo] = useState("order");
  const [error, setError] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [needsRecovery, setNeedsRecovery] = useState(false);
  const [portrait, setPortrait] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [skyReplayKey, setSkyReplayKey] = useState(0);
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
    const response = await fetch(`/api/skyBatch${requested ? `?requestId=${encodeURIComponent(requested)}` : ""}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new SkyRequestError("Could not read the current sky generation.");
    const data = await response.json();
    // An old latest-job GET may finish after the user has started a new batch.
    if (mountedRef.current && epoch === lifecycleRef.current && requested === expectedRequestRef.current) {
      setConfigured(Boolean(data.configured));
      const revision = canvasRevisionOf(data.canvasRevision);
      const previousRevision = canvasRevisionRef.current;
      if (revision !== null && previousRevision !== null && revision > previousRevision) {
        resetSky(revision);
        publishCanvasReset(revision);
        return;
      }
      if (revision !== null) {
        canvasRevisionRef.current = revision;
        setCanvasRevision(revision);
      }
      // Cleared or expired requests must remove a retained completed canvas.
      // A configuration-only read on a fresh visit never imports another sky.
      if (requested && !data.job) {
        // A focus GET can overtake the POST before the server creates its job.
        // Only a newer revision proves a clear while that request is pending.
        if (streamActiveRef.current) {
          setNeedsRecovery(true);
          return;
        }
        resetSky(revision);
        return;
      }
      // A failed-only retry may have completed in another tab. The server
      // explicitly links it to our saved request, so resume that same sky.
      if (requested && data.resumedFrom === requested && data.job?.requestId) {
        expectedRequestRef.current = data.job.requestId;
        rememberRequest(data.job.requestId);
      }
      // A fresh visit checks configuration only. Resume only a request this
      // browser session explicitly started, never the server's latest artwork.
      if (requested) acceptJob(data.job ?? null);
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
    if (!expectedRequestRef.current) {
      try { expectedRequestRef.current = sessionStorage.getItem(REQUEST_STORAGE); } catch { /* Optional recovery only. */ }
    }
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
    if (!job && !needsRecovery && !requesting) return;
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
    if (busyRef.current || job?.status === "running" || canvasRevisionRef.current === null || (!retryFailed && (!from.trim() || !to.trim()))) return;
    if (retryFailed && !job?.entries.some((entry) => entry.status === "failed")) return;
    busyRef.current = true;
    streamActiveRef.current = true;
    requestStartedAtRef.current = Date.now();
    setNow(requestStartedAtRef.current);
    const requestId = crypto.randomUUID();
    const epoch = lifecycleRef.current;
    const revision = canvasRevisionRef.current;
    expectedRequestRef.current = requestId;
    rememberRequest(requestId);
    // A retry preserves every successful stroke and its canvas animation state.
    if (!retryFailed) { jobRef.current = null; setJob(null); }
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
        body: JSON.stringify(retryFailed ? { requestId, retryOf: job!.requestId, canvasRevision: revision } : { requestId, from: from.trim(), to: to.trim(), canvasRevision: revision }),
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
        if (data.code === "already_retried" && data.job) {
          expectedRequestRef.current = data.job.requestId;
          rememberRequest(data.job.requestId);
          acceptJob(data.job);
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
  }, [job, from, to, loadSnapshot, acceptJob, resetSky]);

  const entries = job?.entries ?? [];
  const presentation = useMemo(() => skyPresentation(job, requesting, skyReplayKey), [job, requesting, skyReplayKey]);
  const { paths, succeeded, failed, completed, running } = presentation;
  const agents = useMemo<Agent[]>(() => [...new Map(job?.entries.map(({ agent }) => [agent.id, { id: agent.id, style: agentRenderStyle(agent.category) }] as const) ?? []).values()], [job]);
  const strokeOptionLabels = useMemo(() => new Map(
    job?.entries.flatMap((entry, index) => entry.stroke
      ? [[entry.stroke.id, `Stroke ${index + 1} · ${entry.agent.name} · ${entry.stroke.from} → ${entry.stroke.to}`] as const]
      : []) ?? [],
  ), [job]);
  const layoutKey = entries.map((entry) => entry.stroke?.id ?? "").join("|");
  const displayLayout = useMemo(() => skyDisplayLayout(layoutKey.split("|"), portrait), [layoutKey, portrait]);
  const selected = entries.find((entry) => entry.stroke?.id === selectedId);
  const active = presentation.activeEntry;
  const elapsedStart = active?.startedAt ?? job?.createdAt ?? requestStartedAtRef.current;
  const elapsedSeconds = Math.max(0, Math.floor((now - (elapsedStart || now)) / 1000));
  const elapsed = elapsedSeconds < 60 ? `${elapsedSeconds}s` : `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`;

  return (
    <main className="sky-page" data-sky-state={running ? "generating" : presentation.showCanvas ? "ready" : "empty"}>
      <header className="sky-nav">
        <Link href="/studio" className="sky-back" aria-label="Back to Agent Snapshot">← Snapshot</Link>
        <div className="sky-nav-actions">
          <button type="button" disabled={paths.length === 0} onClick={() => setSkyReplayKey((key) => key + 1)}>Replay sky</button>
          <button type="button" onClick={() => setControlsVisible((value) => !value)}>{controlsVisible ? "Hide controls" : "Show controls"}</button>
        </div>
      </header>
      <div className="sky-content">
        {controlsVisible && <section className="sky-console" aria-label="Star field generation">
          <div className="sky-heading"><h1>Sky</h1><p>Ten strokes. One at a time.</p></div>
          <form className="sky-generate" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
            <label><span>From</span><input value={from} onChange={(event) => setFrom(event.target.value)} maxLength={100} disabled={running} aria-label="From concept" /></label>
            <span className="sky-arrow" aria-hidden="true">→</span>
            <label><span>To</span><input value={to} onChange={(event) => setTo(event.target.value)} maxLength={100} disabled={running} aria-label="To concept" /></label>
            <button type="submit" disabled={running || requesting || !configured || canvasRevision === null || !from.trim() || !to.trim()}>{running ? `Generating ${completed}/${SKY_BATCH_SIZE}` : "Generate 10 strokes"}</button>
          </form>
          {!job && !running && <p className="sky-note">Create ten strokes using your available agents. Each stroke appears as soon as it is ready. No new agents are added.</p>}
        </section>}
        {configured === false && <p className="sky-error">Configure OPENROUTER_API_KEY to generate real agent strokes.</p>}
        {error && <p className="sky-error" role="alert">{error}</p>}
        {needsRecovery && <p className="sky-note" role="status">Reconnecting to the existing request. No generation will be repeated.</p>}
        {presentation.showProgress && <section className={`sky-progress${running ? " is-running" : ""}`} aria-label="Generation progress" aria-live="polite">
          <div className="sky-progress-heading"><h2>{presentation.headline}</h2><span>{completed * 10}%</span></div>
          <progress value={completed} max={SKY_BATCH_SIZE} aria-label="Stroke generation progress" aria-valuetext={`${completed}/10 completed, ${succeeded} succeeded, ${failed} failed`} />
          {running && <div className="sky-active" role="status">
            <span className="sky-active-indicator" aria-hidden="true" />
            <div className="sky-active-copy">
              <strong>{active ? `Creating stroke ${presentation.activeIndex + 1} of ${SKY_BATCH_SIZE}` : job ? "Preparing the next stroke" : "Starting generation"}</strong>
              <small>{active ? `${active.agent.name} · Attempt ${active.attempts ?? 1} · ` : "Waiting for the next update · "}<span aria-live="off">{elapsed} {active?.startedAt ? "elapsed" : "batch elapsed"}</span></small>
            </div>
          </div>}
          <p>Completed {completed}/10 · Succeeded {succeeded} · Failed {failed}{running ? " · Drawing each stroke as it arrives" : failed ? " · Showing successful results only" : " · All strokes are ready"}</p>
          {failed > 0 && !running && <button type="button" className="sky-retry" disabled={!configured || requesting} onClick={() => { void generate(true); }}>{requesting ? "Starting retry…" : `Retry failed (${failed})`}</button>}
        </section>}
        {presentation.showCanvas ? (
          <section className="sky-artwork" aria-label="Generated sky">
            <div className="sky-canvas">
              <CanvasView key={presentation.canvasKey} paths={paths} agents={agents} selectedStrokeId={null} filterAgentId={null} editMode={false} onSelectStroke={setSelectedId} onTransformCommit={noop} displayLayout={displayLayout} />
            </div>
          </section>
        ) : <p className="sky-empty" role="status">{running ? "Waiting for the first stroke. Drawing will begin below as soon as it arrives." : job ? "This batch produced no strokes to display. Check the failure details below." : "Select Generate 10 strokes to begin. The canvas appears when the first stroke is ready."}</p>}
        {controlsVisible && job && <details className="sky-results">
          <summary>This sky · {succeeded} strokes{failed ? ` · ${failed} failed` : ""}</summary>
          <div className="sky-result-list">
            {entries.map((entry, index) => <div className={`sky-result ${entry.status}`} key={`${job.canvasId ?? job.id}:slot-${index}`}>
              <span className="sky-result-index">{String(index + 1).padStart(2, "0")}</span>
              <div><Link href={`/agent/${entry.agent.id}`}>{entry.agent.name}</Link><small>{entry.agent.model_type} · {entry.status === "running" && (entry.attempts ?? 1) > 1 ? `Retrying (${entry.attempts}/2)` : statusLabel[entry.status]}</small>{entry.error && <p>{entry.error}</p>}</div>
              {entry.stroke && <button type="button" onClick={() => setSelectedId(entry.stroke!.id)}>Replay</button>}
            </div>)}
          </div>
        </details>}
      </div>
      {selected?.stroke && <aside className="sky-player"><StrokePlayerPanel stroke={selected.stroke} agent={selected.agent} onClose={() => setSelectedId(null)} strokeOptions={paths} strokeOptionLabels={strokeOptionLabels} onSelectStroke={setSelectedId} /></aside>}
    </main>
  );
}
