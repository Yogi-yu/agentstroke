// ============================================================================
// Server-side store — SINGLE SOURCE OF TRUTH for agents + strokes.
// ----------------------------------------------------------------------------
// Process-wide globalThis singleton so the agent pool + generated strokes
// persist across route invocations and page refreshes. The frontend is NEVER
// the source of truth: it fetches this on load and re-syncs after every change.
//
//   roster — the immutable catalog of candidate economic agents (attraction src)
//   pool   — the AVAILABLE agents (server-authoritative). Starts with 3 defaults;
//            grows as a posted task attracts more; shrinks on delete.
// ============================================================================

import type { AgentProfile, StrokeTransform, TransitionPath } from "@/lib/types";
import { makeAgents } from "@/lib/agents";

const MAX_STROKES = 500; // ring-buffer cap to bound memory
const DEFAULT_POOL_COUNT = 3; // economic agents present at system start

interface State {
  roster: AgentProfile[]; // full catalog (candidates to attract from)
  pool: AgentProfile[]; // available agents — the persistent, authoritative list
  strokes: TransitionPath[];
}

const g = globalThis as unknown as { __strokeState?: State };

function state(): State {
  if (!g.__strokeState) {
    const roster = makeAgents();
    const now = Date.now();
    // seed the 3 default agents; joined well in the past so they don't flag as
    // freshly-attracted in the UI.
    const pool = roster.slice(0, DEFAULT_POOL_COUNT).map((a) => ({ ...a, joined_at: now - 60_000 }));
    g.__strokeState = { roster, pool, strokes: [] };
  }
  return g.__strokeState;
}

// ---- agents (server-authoritative pool) ------------------------------------

/** The available agent pool (what /api/agents returns + the UI mirrors). */
export function listAgents(): AgentProfile[] {
  return state().pool;
}

/** Total catalog size — the ceiling on how many agents can be attracted. */
export function agentCapacity(): number {
  return state().roster.length;
}

/** Resolve any agent (pool first, then the wider catalog) for name/style/chat. */
export function getAgent(id: string): AgentProfile | undefined {
  const s = state();
  return s.pool.find((a) => a.id === id) ?? s.roster.find((a) => a.id === id);
}

/** Attract one not-yet-present catalog agent into the pool. Undefined when full. */
export function attractAgent(): AgentProfile | undefined {
  const s = state();
  const present = new Set(s.pool.map((a) => a.id));
  const candidates = s.roster.filter((a) => !present.has(a.id));
  if (candidates.length === 0) return undefined;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const agent: AgentProfile = { ...pick, joined_at: Date.now() };
  s.pool.push(agent);
  return agent;
}

/**
 * Remove an agent from the pool and CASCADE-delete its strokes (no orphans).
 * Returns true if the agent existed.
 */
export function removeAgent(id: string): boolean {
  const s = state();
  const i = s.pool.findIndex((a) => a.id === id);
  if (i === -1) return false;
  s.pool.splice(i, 1);
  s.strokes = s.strokes.filter((st) => st.agent_id !== id);
  return true;
}

// ---- strokes ---------------------------------------------------------------

export function listStrokes(): TransitionPath[] {
  return state().strokes;
}

/** Resolve a single stroke by id (server store = single source of truth). */
export function getStroke(id: string): TransitionPath | undefined {
  return state().strokes.find((s) => s.id === id);
}

export function strokesForAgent(id: string): TransitionPath[] {
  return state().strokes.filter((s) => s.agent_id === id);
}

/** Store a generated stroke (de-duped by id, ring-buffered). */
export function addStroke(stroke: TransitionPath): TransitionPath {
  const s = state().strokes;
  if (!s.some((p) => p.id === stroke.id)) {
    s.push(stroke);
    if (s.length > MAX_STROKES) s.splice(0, s.length - MAX_STROKES);
  }
  return stroke;
}

/** Remove a single stroke. Returns true if removed. */
export function removeStroke(id: string): boolean {
  const s = state().strokes;
  const i = s.findIndex((p) => p.id === id);
  if (i === -1) return false;
  s.splice(i, 1);
  return true;
}

/**
 * Persist a stroke's edit-mode transform (move / rotate / scale). Returns the
 * updated stroke, or undefined if the stroke no longer exists. This is the
 * write-back target for Edit Mode — it makes transforms durable across refresh.
 */
export function updateStrokeTransform(
  id: string,
  transform: StrokeTransform,
): TransitionPath | undefined {
  const stroke = state().strokes.find((p) => p.id === id);
  if (!stroke) return undefined;
  stroke.transform = transform;
  return stroke;
}

/** Clear all strokes (canvas reset). Agents persist. */
export function clearStrokes(): number {
  const s = state().strokes;
  const n = s.length;
  s.length = 0;
  return n;
}
