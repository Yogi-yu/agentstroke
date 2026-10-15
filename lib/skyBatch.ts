import type { AgentProfile, TransitionPath } from "@/lib/types";

export const SKY_BATCH_SIZE = 10;
export const SKY_BATCH_CONCURRENCY = 1;

export interface SkyBatchEntry {
  agent: AgentProfile;
  status: "queued" | "running" | "succeeded" | "failed";
  stroke?: TransitionPath;
  error?: string;
  errorCode?: string;
  attempts?: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface SkyBatch {
  id: string;
  requestId: string;
  canvasRevision?: number;
  /** Retries keep the same canvas and successful strokes. */
  canvasId?: string;
  retryRequestId?: string;
  from: string;
  to: string;
  createdAt: number;
  startedAt?: number;
  updatedAt?: number;
  /** Monotonic within a job, including attempts, completion and cancellation. */
  updateSequence?: number;
  finishedAt?: number;
  status: "running" | "complete" | "partial" | "failed" | "cleared";
  entries: SkyBatchEntry[];
}

/** Ten stroke slots from the existing pool; repeated authors never add agents. */
export function selectSkyAgents(pool: AgentProfile[], random = Math.random): AgentProfile[] {
  const available = [...new Map(pool.map((agent) => [agent.id, agent])).values()];
  if (!available.length) throw new Error("No agents are available. Add an agent before generating sky strokes.");
  const shuffle = (agents: AgentProfile[]) => {
    const result = [...agents];
    for (let index = result.length - 1; index > 0; index--) {
      const sample = random();
      const target = Number.isFinite(sample) ? Math.min(index, Math.max(0, Math.floor(sample * (index + 1)))) : 0;
      [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
  };
  const selected: AgentProfile[] = [];
  while (selected.length < SKY_BATCH_SIZE) {
    const round = shuffle(available);
    // Every author appears once per shuffled round. At round boundaries avoid
    // repeating the previous author whenever the pool contains an alternative.
    if (round.length > 1 && round[0].id === selected[selected.length - 1]?.id) {
      [round[0], round[1]] = [round[1], round[0]];
    }
    selected.push(...round.slice(0, SKY_BATCH_SIZE - selected.length));
  }
  return selected;
}

export function createSkyBatch(id: string, requestId: string, agents: AgentProfile[], from: string, to: string): SkyBatch {
  if (agents.length !== SKY_BATCH_SIZE || agents.some((agent) => !agent?.id)) {
    throw new Error("A sky batch must contain exactly ten stroke slots with available authors.");
  }
  const now = Date.now();
  return { id, requestId, from, to, createdAt: now, updatedAt: now, updateSequence: 0, status: "running", entries: agents.map((agent) => ({ agent, status: "queued" })) };
}

/** Shared by state changes, including the canvas-reset owner. Never resets a sequence. */
export function touchSkyBatch(batch: SkyBatch, now = Date.now()): void {
  batch.updatedAt = Math.max(now, batch.updatedAt ?? batch.createdAt, batch.createdAt);
  batch.updateSequence = (batch.updateSequence ?? 0) + 1;
}

export function retrySkyBatch(source: SkyBatch, id: string, requestId: string): SkyBatch {
  if (source.status === "running" || source.status === "cleared" || !source.entries.some((entry) => entry.status === "failed")) {
    throw new Error("Only a finished batch with failed entries can be retried.");
  }
  const now = Date.now();
  return {
    id, requestId, canvasId: source.canvasId ?? source.id, canvasRevision: source.canvasRevision,
    from: source.from, to: source.to, createdAt: now, updatedAt: now, updateSequence: 0, status: "running",
    entries: source.entries.map((entry) => entry.status === "succeeded"
      ? { ...entry }
      : { agent: entry.agent, status: "queued" }),
  };
}

/** Public errors omit provider payloads and credentials. Failures never become artwork. */
export function skyGenerationError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const messages: Record<string, string> = {
    timeout: "The model timed out after bounded retries. Retry this stroke when the provider is available.",
    invalid_response: "The model did not return a valid semantic path after repair. No stroke was saved.",
    truncated: "The model's response was incomplete after repair. No stroke was saved.",
    refused: "The model declined this request. No stroke was saved.",
    rate_limit: "The model rate limit was reached. Wait a moment before retrying.",
    authentication: "Model authentication failed. Check the provider configuration.",
    credits: "Model credits are unavailable. Check the provider balance.",
    unavailable: "The configured model is unavailable. Check its availability before retrying.",
    network: "The model provider could not be reached after bounded retries.",
    configuration: "The model provider is not configured. No model calls were made.",
  };
  if (typeof code === "string" && messages[code]) return messages[code];
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/timed?\s*out|timeout|abort/.test(message)) return "The model timed out. No stroke was saved.";
  if (/401|403|api.?key|authentication/.test(message)) return "Model authentication failed. No stroke was saved.";
  if (/402|credit|payment|balance/.test(message)) return "Model credits are unavailable. No stroke was saved.";
  if (/429|rate.?limit/.test(message)) return "The model rate limit was reached. No stroke was saved.";
  if (/json|empty reply|semantic|invalid/.test(message)) return "The model returned an invalid semantic path. No stroke was saved.";
  return "Model generation failed. No stroke was saved.";
}

interface Dependencies {
  generate: (agent: AgentProfile, index: number, onAttempt: (attempt: number) => void) => Promise<TransitionPath>;
  persist: (stroke: TransitionPath) => void;
  signal?: AbortSignal;
}

/** One stroke at a time. Emit each result before dispatching the next slot. */
export async function runSkyBatch(batch: SkyBatch, dependencies: Dependencies, onChange: () => void = () => {}): Promise<void> {
  const pending = batch.entries.flatMap((entry, index) => entry.status === "queued" ? [index] : []);
  let lastNotifiedSequence: number | undefined;
  const notify = () => {
    lastNotifiedSequence = batch.updateSequence ?? 0;
    try { onChange(); } catch { /* Observer failure cannot repeat or corrupt a generation. */ }
  };
  const changed = () => { touchSkyBatch(batch); notify(); };
  const cancelled = () => dependencies.signal?.aborted || batch.status === "cleared";
  const onAbort = () => {
    if (batch.status !== "cleared" || batch.entries.length) {
      batch.status = "cleared";
      batch.entries = [];
      batch.finishedAt = Math.max(Date.now(), batch.updatedAt ?? batch.createdAt);
      changed();
    } else if (lastNotifiedSequence !== undefined && lastNotifiedSequence === (batch.updateSequence ?? 0)) {
      // A pre-update/HMR reset owner may clear the job without stamping it.
      // Do not let that terminal frame be mistaken for the last running frame.
      changed();
    } else notify(); // A full canvas reset already stamped the same transition.
  };
  if (cancelled()) { onAbort(); return; }
  if (!pending.length && batch.status !== "running") return;
  dependencies.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (const index of pending) {
      if (cancelled()) return;
      const entry = batch.entries[index];
      const now = Math.max(Date.now(), batch.updatedAt ?? batch.createdAt);
      batch.startedAt ??= now;
      entry.status = "running";
      entry.startedAt = now;
      entry.attempts = 1;
      changed();
      if (cancelled()) return;
      try {
        const stroke = await dependencies.generate(entry.agent, index, (attempt) => {
          if (cancelled() || entry.status !== "running" || !Number.isSafeInteger(attempt) || attempt <= (entry.attempts ?? 0)) return;
          entry.attempts = attempt;
          changed();
        });
        if (cancelled()) return;
        if (!stroke?.id || stroke.agent_id !== entry.agent.id || !Array.isArray(stroke.points) || stroke.points.length < 2) {
          throw new Error("Invalid semantic stroke returned by model generation.");
        }
        dependencies.persist(stroke);
        if (cancelled()) return;
        entry.stroke = stroke;
        entry.status = "succeeded";
      } catch (error) {
        if (cancelled()) return;
        entry.status = "failed";
        entry.error = skyGenerationError(error);
        if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
          entry.errorCode = error.code;
        }
      }
      entry.finishedAt = Math.max(Date.now(), entry.startedAt ?? batch.createdAt, batch.updatedAt ?? batch.createdAt);
      changed();
    }
  } finally {
    dependencies.signal?.removeEventListener("abort", onAbort);
  }
  if (cancelled()) return;
  const succeeded = batch.entries.filter((entry) => entry.status === "succeeded").length;
  batch.status = succeeded === batch.entries.length ? "complete" : succeeded > 0 ? "partial" : "failed";
  batch.finishedAt = Math.max(Date.now(), batch.updatedAt ?? batch.createdAt);
  changed();
}
