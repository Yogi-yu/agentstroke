import { randomUUID } from "node:crypto";
import { databaseTransaction, type DatabaseClient } from "@/lib/database";
import { SHARED_CANVAS_OWNER } from "@/lib/sharedCanvas";
import {
  ensureVisitor, maintainAgentPoolInTransaction, recruitAgentInTransaction,
  enforceCanvasLimitInTransaction, saveStrokeInTransaction,
} from "@/lib/store";
import type { AgentProfile, TransitionPath } from "@/lib/types";
import {
  AGENT_POOL_MIN, AGENT_POOL_TARGET, AGENT_POOL_MAX, AGENT_IDLE_TIMEOUT_MS,
  AUTO_STROKE_INTERVAL_MS, CANVAS_STROKE_LIMIT,
  type AutopilotStatus,
} from "@/lib/autopilotPolicy";

export const AUTOPILOT_LEASE_MS = 120_000;
export const AUTOPILOT_RESUME_GAP_MS = 90_000;

interface AutopilotState {
  nextGenerationAt: number;
  lastTickAt: number;
  runId: string | null;
  leaseUntil: number;
  lastSuccessAt: number | null;
  lastStrokeId: string | null;
  lastError: string | null;
}
export interface AutopilotClaim {
  runId: string;
  agent: AgentProfile;
  canvasRevision: number;
  startedAt: number;
}

/** Only the deployed start command opts in. Builds, tests and local dev never run it. */
export function autopilotEnabled(): boolean {
  return process.env.RENDER === "true" && process.env.NODE_ENV === "production"
    && process.env.NOEMA_AUTOPILOT_RUNTIME === "1"
    && process.env.NEXT_PHASE !== "phase-production-build"
    && process.env.NOEMA_AUTOPILOT_DISABLED !== "1";
}

async function readState(db: DatabaseClient): Promise<AutopilotState | null> {
  const row = (await db.query<{ payload: string }>(
    "SELECT payload FROM noema_autopilot WHERE owner_id=$1", [SHARED_CANVAS_OWNER],
  )).rows[0];
  return row ? JSON.parse(row.payload) as AutopilotState : null;
}
async function writeState(db: DatabaseClient, state: AutopilotState): Promise<void> {
  await db.query("INSERT INTO noema_autopilot(owner_id,payload) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET payload=$2",
    [SHARED_CANVAS_OWNER, JSON.stringify(state)]);
}

/** All writers lock the shared visitor FIRST; no transaction spans a model request. */
export async function claimAutopilotTick(now = Date.now()): Promise<AutopilotClaim | null> {
  return databaseTransaction(async db => {
    const visitor = await ensureVisitor(db, SHARED_CANVAS_OWNER);
    let state = await readState(db);
    if (!state) state = {
      nextGenerationAt: now + AUTO_STROKE_INTERVAL_MS, lastTickAt: now,
      runId: null, leaseUntil: 0, lastSuccessAt: null, lastStrokeId: null, lastError: null,
    };
    const alive = !!state.runId && state.leaseUntil > now;
    // A suspended service never catches up missed slots. Rolling deploys do
    // not reset a healthy worker's schedule or steal its in-flight model call.
    if (!alive && now - state.lastTickAt > AUTOPILOT_RESUME_GAP_MS) {
      state.nextGenerationAt = now + AUTO_STROKE_INTERVAL_MS;
    }
    if (state.runId && !alive) {
      state.runId = null;
      state.leaseUntil = 0;
      state.lastError = "The previous creation was interrupted. The next scheduled creation will use a new agent.";
      state.nextGenerationAt = Math.max(state.nextGenerationAt, now + AUTO_STROKE_INTERVAL_MS);
    }
    state.lastTickAt = now;
    await maintainAgentPoolInTransaction(db, SHARED_CANVAS_OWNER, now);
    await enforceCanvasLimitInTransaction(db, SHARED_CANVAS_OWNER);
    if (alive || now < state.nextGenerationAt) {
      await writeState(db, state);
      return null;
    }

    const agent = await recruitAgentInTransaction(db, SHARED_CANVAS_OWNER, now);
    const runId = randomUUID();
    state.runId = runId;
    state.leaseUntil = now + AUTOPILOT_LEASE_MS;
    // Advance on CLAIM, not success: failures cannot cause paid 30-second retries.
    state.nextGenerationAt = now + AUTO_STROKE_INTERVAL_MS;
    state.lastError = null;
    await writeState(db, state);
    return { runId, agent, canvasRevision: Number(visitor.revision), startedAt: now };
  });
}

export async function heartbeatAutopilotClaim(runId: string, now = Date.now()): Promise<boolean> {
  return databaseTransaction(async db => {
    await ensureVisitor(db, SHARED_CANVAS_OWNER);
    const state = await readState(db);
    if (!state || state.runId !== runId || state.leaseUntil <= now) return false;
    state.leaseUntil = now + AUTOPILOT_LEASE_MS;
    state.lastTickAt = now;
    await writeState(db, state);
    return true;
  });
}

/** Exactly one canonical ID per run. Late/cleared results are archived, never resurrected. */
export async function finishAutopilotClaim(claim: AutopilotClaim, stroke: TransitionPath, now = Date.now()): Promise<boolean> {
  return databaseTransaction(async db => {
    const visitor = await ensureVisitor(db, SHARED_CANVAS_OWNER);
    const state = await readState(db);
    const valid = !!state && state.runId === claim.runId && state.leaseUntil > now;
    const canonical = { ...stroke, id: `stroke-auto-${claim.runId}`, agent_id: claim.agent.id };
    await saveStrokeInTransaction(db, SHARED_CANVAS_OWNER, canonical, {
      visitor, author: claim.agent, expectedRevision: valid ? claim.canvasRevision : -1,
    });
    if (!state || !valid) return false;
    state.runId = null;
    state.leaseUntil = 0;
    state.lastSuccessAt = now;
    state.lastStrokeId = canonical.id;
    state.lastError = Number(visitor.revision) === claim.canvasRevision ? null
      : "The canvas was cleared during creation. The completed artwork was kept in Archive.";
    state.lastTickAt = now;
    await writeState(db, state);
    return Number(visitor.revision) === claim.canvasRevision;
  });
}

export async function failAutopilotClaim(runId: string, safeMessage: string, now = Date.now()): Promise<void> {
  await databaseTransaction(async db => {
    await ensureVisitor(db, SHARED_CANVAS_OWNER);
    const state = await readState(db);
    if (!state || state.runId !== runId) return;
    state.runId = null;
    state.leaseUntil = 0;
    state.lastTickAt = now;
    state.lastError = safeMessage;
    await writeState(db, state);
  });
}

/** Observational: reading/polling status does not recruit, generate or mark agents active. */
export async function readAutopilotStatus(now = Date.now()): Promise<AutopilotStatus> {
  const enabled = autopilotEnabled();
  const state = enabled ? await databaseTransaction(db => readState(db)) : null;
  const running = enabled && !!state && now - state.lastTickAt <= AUTOPILOT_RESUME_GAP_MS;
  return {
    enabled, running,
    generating: running && !!state?.runId && state.leaseUntil > now,
    nextGenerationAt: state?.nextGenerationAt ?? null,
    lastTickAt: state?.lastTickAt ?? null,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    lastStrokeId: state?.lastStrokeId ?? null,
    lastError: state?.lastError ?? null,
    minAgents: AGENT_POOL_MIN, targetAgents: AGENT_POOL_TARGET, maxAgents: AGENT_POOL_MAX,
    idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS, generationIntervalMs: AUTO_STROKE_INTERVAL_MS,
    canvasLimit: CANVAS_STROKE_LIMIT, mode: "while-service-running",
  };
}
