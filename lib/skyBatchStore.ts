import { touchSkyBatch, type SkyBatch } from "@/lib/skyBatch";
import { createPublishedCanvas } from "@/lib/publishedCanvas";

interface BatchState {
  jobs: Map<string, SkyBatch>;
  seenRequestIds: Set<string>;
  activeId: string | null;
  latestId: string | null;
  canvasRevision: number;
  controllers: Map<string, AbortController>;
}

const globalState = globalThis as unknown as { __noemaSkyBatches?: BatchState };

/** Shared by generation and canvas reset; never imported by client components. */
export function skyBatchState(): BatchState {
  if (!globalState.__noemaSkyBatches) {
    const published = createPublishedCanvas();
    const job = published.skyBatch;
    // Only the completed release job is restored. It is historical artwork,
    // not queued generation, and its request ID cannot trigger paid work again.
    const completed = job?.status === "complete" ? job : null;
    globalState.__noemaSkyBatches = {
      jobs: new Map(completed ? [[completed.requestId, completed]] : []),
      seenRequestIds: new Set(job ? [job.requestId] : []),
      activeId: null, latestId: completed?.requestId ?? null,
      canvasRevision: published.canvasRevision, controllers: new Map(),
    };
  }
  const current = globalState.__noemaSkyBatches;
  // Keep existing artwork and in-flight state across development hot reloads.
  current.seenRequestIds ??= new Set(current.jobs.keys());
  current.canvasRevision ??= 0;
  current.controllers ??= new Map();
  return current;
}

export function canvasRevision(): number {
  return skyBatchState().canvasRevision;
}

/** Invalidate cached artwork and stop paid work before it can refill the canvas. */
export function clearSkyBatches(): number {
  const current = skyBatchState();
  current.canvasRevision++;
  for (const job of current.jobs.values()) {
    current.seenRequestIds.add(job.requestId);
    job.status = "cleared";
    job.canvasRevision = current.canvasRevision;
    job.entries = [];
    job.finishedAt = Date.now();
    touchSkyBatch(job, job.finishedAt);
  }
  for (const controller of current.controllers.values()) controller.abort();
  current.controllers.clear();
  current.jobs.clear();
  current.activeId = null;
  current.latestId = null;
  // Keep idempotency tombstones: replaying a cleared request must not regenerate.
  return current.canvasRevision;
}
