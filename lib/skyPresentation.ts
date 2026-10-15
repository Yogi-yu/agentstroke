import { SKY_BATCH_SIZE, type SkyBatch } from "@/lib/skyBatch";

/** Fixed ten-slot composition: new results never move an existing stroke. */
export function skyDisplayLayout(slotIds: readonly string[], portrait: boolean) {
  const columns = portrait ? 2 : 5;
  const rows = SKY_BATCH_SIZE / columns;
  const top = 0.08;
  const fieldHeight = 0.84;
  const layout = new Map<string, { centerX: number; centerY: number; width: number; height: number }>();
  slotIds.forEach((id, index) => {
    if (!id) return;
    layout.set(id, {
      centerX: 0.08 + ((index % columns) + 0.5) * 0.84 / columns,
      centerY: top + (Math.floor(index / columns) + 0.5) * fieldHeight / rows,
      // Generous overlapping regions preserve material visibility and the
      // relative length of each stroke, rather than uniformly fitting cells.
      width: Math.max(0.32, 0.84 / columns * 0.94),
      height: Math.max(0.28, fieldHeight / rows * 0.9),
    });
  });
  return layout;
}

/** Decode progressive responses, including UTF-8 characters split across chunks. */
export async function readSkyProgress(stream: ReadableStream<Uint8Array>, onJob: (job: SkyBatch) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const accept = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as { job?: SkyBatch };
    if (event.job) onJob(event.job);
  };
  try {
    while (true) {
      const result = await reader.read();
      pending += decoder.decode(result.value, { stream: !result.done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) accept(line);
      if (result.done) break;
    }
    accept(pending);
  } finally {
    reader.releaseLock();
  }
}

/** Only the requested batch may reach the screen; late polls cannot rewind it. */
export function acceptSkySnapshot(current: SkyBatch | null, incoming: SkyBatch | null, expectedRequestId: string | null): SkyBatch | null {
  if (!expectedRequestId || !incoming || incoming.requestId !== expectedRequestId) return current;
  if (incoming.status === "cleared") return null;
  if (!current) return incoming;
  if (current.id !== incoming.id) return incoming.createdAt >= current.createdAt ? incoming : current;
  if (current.status !== "running" && incoming.status === "running") return current;
  const currentSequence = current.updateSequence;
  const incomingSequence = incoming.updateSequence;
  if (typeof currentSequence === "number") {
    // GET snapshots and stream frames can arrive in either order. Equal
    // snapshots also reuse object identity instead of rebuilding the canvas.
    if (typeof incomingSequence !== "number" || incomingSequence <= currentSequence) return current;
  }
  if (typeof incomingSequence === "number") return incoming;
  const score = (job: SkyBatch) => job.entries.reduce((total, entry) => total + (entry.status === "queued" ? 0 : entry.status === "running" ? 1 : 100), 0);
  return score(incoming) < score(current) ? current : incoming;
}

/** Completion includes failures; the canvas and success count require artwork. */
export function skyPresentation(job: SkyBatch | null, requesting: boolean, replayKey = 0) {
  if (job?.status === "cleared") job = null;
  const entries = job?.entries ?? [];
  const paths = entries.flatMap((entry) => entry.status === "succeeded" && entry.stroke ? [entry.stroke] : []);
  const succeeded = paths.length;
  const failed = entries.filter((entry) => entry.status === "failed").length;
  const completed = entries.filter((entry) => entry.status === "succeeded" || entry.status === "failed").length;
  const running = job ? job.status === "running" : requesting;
  const activeIndex = entries.findIndex((entry) => entry.status === "running");
  return {
    paths, succeeded, failed, completed, running,
    activeIndex,
    activeEntry: activeIndex >= 0 ? entries[activeIndex] : null,
    showCanvas: succeeded > 0,
    showProgress: requesting || !!job,
    canvasKey: `${job?.canvasId ?? job?.id ?? "empty"}:${replayKey}`,
    headline: running ? `Generating… ${completed}/${SKY_BATCH_SIZE}`
      : succeeded === SKY_BATCH_SIZE ? `Generation complete · ${completed}/${SKY_BATCH_SIZE}`
        : `Generation finished · ${completed}/${SKY_BATCH_SIZE}`,
  };
}
