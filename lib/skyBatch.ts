import type { AgentProfile, BrushTreatment, TransitionPath } from "@/lib/types";
import { assignBrushTreatment, brushTreatmentForIndex } from "@/engine/brushAssignment";
import { hashStr } from "@/simulation/rng";

export const SKY_BATCH_SIZE = 10;
export const SKY_SPHERE_BATCH_SIZE = 20;
export const SKY_BATCH_CONCURRENCY = 1;
export type SkyMode = "standard" | "sphere";
export type SkyBatchSize = typeof SKY_BATCH_SIZE | typeof SKY_SPHERE_BATCH_SIZE;

export function skyBatchSize(mode: SkyMode = "standard"): SkyBatchSize {
  return mode === "sphere" ? SKY_SPHERE_BATCH_SIZE : SKY_BATCH_SIZE;
}

/** Historical jobs omitted metadata; their reserved slots remain authoritative. */
export function skyTargetCount(job: SkyBatch | null | undefined): SkyBatchSize {
  if (job?.entries.length === SKY_SPHERE_BATCH_SIZE) return SKY_SPHERE_BATCH_SIZE;
  if (job?.entries.length === SKY_BATCH_SIZE) return SKY_BATCH_SIZE;
  return skyBatchSize(job?.skyMode ?? "standard");
}

export interface SkyBatchEntry {
  agent: AgentProfile;
  /** Reserved before generation, so failures/retries cannot reroll the mix. */
  brushTreatment?: BrushTreatment;
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
  /** Missing only on historical, fixed-pair batches. New work is autonomous. */
  mode?: "autonomous";
  /** Presentation/generation size; distinct from the agent's autonomous mode. */
  skyMode?: SkyMode;
  targetCount?: SkyBatchSize;
  /** Legacy metadata; autonomous batches have no shared start or destination. */
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

/** Reserved stroke slots from the existing pool; repeated authors never add agents. */
export function selectSkyAgents(pool: AgentProfile[], random = Math.random, count: SkyBatchSize = SKY_BATCH_SIZE): AgentProfile[] {
  if (count !== SKY_BATCH_SIZE && count !== SKY_SPHERE_BATCH_SIZE) throw new Error("Sky supports only ten or twenty stroke slots.");
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
  while (selected.length < count) {
    const round = shuffle(available);
    // Every author appears once per shuffled round. At round boundaries avoid
    // repeating the previous author whenever the pool contains an alternative.
    if (round.length > 1 && round[0].id === selected[selected.length - 1]?.id) {
      [round[0], round[1]] = [round[1], round[0]];
    }
    selected.push(...round.slice(0, count - selected.length));
  }
  return selected;
}

export function createSkyBatch(id: string, requestId: string, agents: AgentProfile[], _legacyFrom = "", _legacyTo = "", skyMode: SkyMode = "standard"): SkyBatch {
  if (skyMode !== "standard" && skyMode !== "sphere") throw new Error("A valid sky mode is required.");
  const targetCount = skyBatchSize(skyMode);
  if (agents.length !== targetCount || agents.some((agent) => !agent?.id)) {
    throw new Error(`A sky batch must contain exactly ${targetCount === SKY_BATCH_SIZE ? "ten" : "twenty"} stroke slots with available authors.`);
  }
  const now = Date.now();
  const materialSeed = hashStr(requestId);
  return { id, requestId, mode: "autonomous", skyMode, targetCount, from: "", to: "", createdAt: now, updatedAt: now, updateSequence: 0, status: "running", entries: agents.map((agent, index) => ({ agent, brushTreatment: brushTreatmentForIndex(index, materialSeed), status: "queued" })) };
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
  const targetCount = skyTargetCount(source);
  return {
    id, requestId, canvasId: source.canvasId ?? source.id, canvasRevision: source.canvasRevision,
    // Preserve completed artwork, but never constrain newly retried agents to
    // the fixed pair inherited from a historical batch.
    mode: "autonomous", skyMode: targetCount === SKY_SPHERE_BATCH_SIZE ? "sphere" : "standard", targetCount,
    from: "", to: "", createdAt: now, updatedAt: now, updateSequence: 0, status: "running",
    entries: source.entries.map((entry, index) => entry.status === "succeeded"
      ? { ...entry }
      : { agent: entry.agent, brushTreatment: entry.brushTreatment ?? brushTreatmentForIndex(index, hashStr(source.requestId)), status: "queued" }),
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
  persist: (stroke: TransitionPath) => void | Promise<void>;
  signal?: AbortSignal;
}

/** One stroke at a time. Every checkpoint is durable before dispatching the next slot. */
export async function runSkyBatch(batch: SkyBatch, dependencies: Dependencies, onChange: () => void | Promise<void> = () => {}): Promise<void> {
  const pending = batch.entries.flatMap((entry, index) => entry.status === "queued" ? [index] : []);
  // Model attempt callbacks are synchronous. Queue their durable checkpoints,
  // then await them before storing or emitting the result. No rejected promise
  // may silently turn a storage failure into a successful generation.
  let checkpoint = Promise.resolve();
  let checkpointError: unknown;
  const changed = () => {
    touchSkyBatch(batch);
    checkpoint = checkpoint.then(async () => {
      if (checkpointError) return;
      try { await onChange(); } catch (error) { checkpointError = error; }
    });
    return checkpoint;
  };
  const flush = async () => { await checkpoint; if (checkpointError) throw checkpointError; };
  const cancelled = () => dependencies.signal?.aborted || batch.status === "cleared";
  const finishCancelled = async () => {
    // Keep historical entries: clearing a view never erases saved artwork.
    batch.status = "cleared";
    batch.finishedAt = Math.max(Date.now(), batch.updatedAt ?? batch.createdAt);
    await changed();
    await flush();
  };
  if (cancelled()) { await finishCancelled(); return; }
  if (!pending.length && batch.status !== "running") return;
  for (const index of pending) {
      if (cancelled()) { await finishCancelled(); return; }
      const entry = batch.entries[index];
      const now = Math.max(Date.now(), batch.updatedAt ?? batch.createdAt);
      batch.startedAt ??= now;
      entry.status = "running";
      entry.startedAt = now;
      entry.attempts = 1;
      await changed();
      await flush();
      if (cancelled()) { await finishCancelled(); return; }
      let generated: TransitionPath | undefined;
      try {
        const stroke = await dependencies.generate(entry.agent, index, (attempt) => {
          if (cancelled() || entry.status !== "running" || !Number.isSafeInteger(attempt) || attempt <= (entry.attempts ?? 0)) return;
          entry.attempts = attempt;
          void changed();
        });
        if (!stroke?.id || stroke.agent_id !== entry.agent.id || !Array.isArray(stroke.points) || stroke.points.length < 2) {
          throw new Error("Invalid semantic stroke returned by model generation.");
        }
        assignBrushTreatment(stroke, entry.brushTreatment ?? brushTreatmentForIndex(index, hashStr(batch.requestId)));
        generated = stroke;
      } catch (error) {
        await flush();
        if (cancelled()) { await finishCancelled(); return; }
        entry.status = "failed";
        entry.error = skyGenerationError(error);
        if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
          entry.errorCode = error.code;
        }
      }
      await flush();
      if (generated) {
        // Archive a valid result even if the canvas was cleared during its
        // model call. The persistence adapter fences visible membership.
        await dependencies.persist(generated);
        entry.stroke = generated;
        entry.status = "succeeded";
      }
      entry.finishedAt = Math.max(Date.now(), entry.startedAt ?? batch.createdAt, batch.updatedAt ?? batch.createdAt);
      await changed();
      await flush();
  }
  if (cancelled()) { await finishCancelled(); return; }
  const succeeded = batch.entries.filter((entry) => entry.status === "succeeded").length;
  batch.status = succeeded === batch.entries.length ? "complete" : succeeded > 0 ? "partial" : "failed";
  batch.finishedAt = Math.max(Date.now(), batch.updatedAt ?? batch.createdAt);
  await changed();
  await flush();
}
