import { createHash, randomInt, randomUUID } from "node:crypto";
import type { AgentProfile, StrokeTransform, TransitionPath } from "@/lib/types";
import { makeAgents, makeRecruitedAgent } from "@/lib/agents";
import { AGENT_IDLE_TIMEOUT_MS, AGENT_POOL_MAX, AGENT_POOL_TARGET, CANVAS_STROKE_LIMIT } from "@/lib/autopilotPolicy";
import { createPublishedCanvas } from "@/lib/publishedCanvas";
import { assignBrushTreatment, brushTreatmentForIndex } from "@/engine/brushAssignment";
import { databaseTransaction, type DatabaseClient } from "@/lib/database";
import type { SkyBatch } from "@/lib/skyBatch";
import { migrateSharedCanvas, SHARED_CANVAS_OWNER } from "@/lib/sharedCanvas";
import { assignArtworkColor, initializeColorTreatments, withArtworkColors } from "@/lib/colorTreatmentStore";

export const PUBLIC_ARTWORK_OWNER = "public";
interface AgentState { pool: AgentProfile[]; lastOut: Record<string, number> }
export interface VisitorRow { owner_id: string; agents_json: string; revision: number; brush_sequence: number; latest_sky_request: string | null }
interface ArtworkRow { id: string; owner_id: string; payload: string; transform_json?: string | null; hidden?: number; agent_json?: string | null }
interface AgentHistoryRow { profile_json: string; retired_at: number | string | null }
const catalog = makeAgents();
const published = createPublishedCanvas();

function assertOwner(owner: string): void {
  if (!/^[a-f0-9]{64}$/.test(owner)) throw new Error("A server-resolved visitor identity is required.");
}
function agentState(row: VisitorRow): AgentState { return JSON.parse(row.agents_json) as AgentState; }
function pathFromRow(row: ArtworkRow): TransitionPath {
  const path = JSON.parse(row.payload) as TransitionPath;
  if (row.transform_json) path.transform = JSON.parse(row.transform_json) as StrokeTransform;
  return path;
}

function lastActivity(agent: AgentProfile, now: number): number {
  const value = agent.last_active_at ?? agent.joined_at;
  return typeof value === "number" && Number.isFinite(value) ? Math.min(now, value) : now;
}

async function rememberAgent(db: DatabaseClient, owner: string, agent: AgentProfile, now: number, retiredAt: number | null = null): Promise<void> {
  await db.query(`INSERT INTO noema_agent_history(owner_id,agent_id,profile_json,retired_at,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,agent_id) DO UPDATE SET profile_json=excluded.profile_json,retired_at=excluded.retired_at,updated_at=excluded.updated_at`, [owner,agent.id,JSON.stringify(agent),retiredAt,now]);
}

async function persistAgentState(db: DatabaseClient, owner: string, state: AgentState, now: number): Promise<void> {
  // Dynamic identities are kept in durable history, not an ever-growing
  // lastOut map in the hot roster row. Legacy catalog cooldowns stay bounded.
  state.lastOut = Object.fromEntries(Object.entries(state.lastOut).filter(([id]) => catalog.some(agent => agent.id === id)));
  await db.query("UPDATE noema_visitors SET agents_json=$2,updated_at=$3 WHERE owner_id=$1", [owner,JSON.stringify(state),now]);
}

async function retireAgent(db: DatabaseClient, owner: string, state: AgentState, agent: AgentProfile, now: number): Promise<void> {
  await rememberAgent(db,owner,agent,now,now);
  state.pool = state.pool.filter(item => item.id !== agent.id);
  if (catalog.some(item => item.id === agent.id)) state.lastOut[agent.id] = now;
}

async function historicalActivity(db: DatabaseClient, owner: string): Promise<Map<string,{count:number;last:number}>> {
  const rows = (await db.query<{payload:string}>("SELECT payload FROM noema_artworks WHERE owner_id=$1 OR owner_id=$2 OR $1=$3",[owner,PUBLIC_ARTWORK_OWNER,SHARED_CANVAS_OWNER])).rows;
  const activity = new Map<string,{count:number;last:number}>();
  for (const row of rows) {
    const path = JSON.parse(row.payload) as TransitionPath;
    const prior = activity.get(path.agent_id) ?? {count:0,last:0};
    prior.count++;
    if (Number.isFinite(path.created_at)) prior.last = Math.max(prior.last,path.created_at);
    activity.set(path.agent_id,prior);
  }
  return activity;
}

/** Roster housekeeping runs only on a server scheduler tick, never a GET. */
export async function maintainAgentPoolInTransaction(db: DatabaseClient, owner: string, now = Date.now()): Promise<AgentProfile[]> {
  const visitor = await ensureVisitor(db,owner);
  const state = agentState(visitor);
  const legacy = state.pool.some(agent => agent.creative_count === undefined || agent.last_active_at === undefined)
    ? await historicalActivity(db,owner) : new Map<string,{count:number;last:number}>();
  for (const agent of [...state.pool]) {
    // Give pre-activity-schema profiles one finite grace period, not a fresh
    // timestamp every time someone views the page.
    const prior = legacy.get(agent.id);
    const needsHistory = agent.last_active_at === undefined || agent.creative_count === undefined;
    agent.last_active_at ??= prior?.last ? Math.min(now,Math.max(prior.last,agent.joined_at ?? 0)) : lastActivity(agent,now);
    agent.joined_at ??= agent.last_active_at;
    agent.creative_count ??= prior?.count ?? 0;
    if (now - lastActivity(agent,now) >= AGENT_IDLE_TIMEOUT_MS) await retireAgent(db,owner,state,agent,now);
    else if (needsHistory) await rememberAgent(db,owner,agent,now);
  }
  while (state.pool.length > AGENT_POOL_MAX) {
    const oldest = [...state.pool].sort((a,b) => lastActivity(a,now)-lastActivity(b,now) || a.id.localeCompare(b.id))[0];
    await retireAgent(db,owner,state,oldest,now);
  }
  while (state.pool.length < AGENT_POOL_TARGET) {
    const agent = makeRecruitedAgent(`agent-live-${randomUUID()}`,randomInt(catalog.length),now);
    state.pool.push(agent);
    await rememberAgent(db,owner,agent,now);
  }
  await persistAgentState(db,owner,state,now);
  return state.pool;
}

/** Always a new identity. The oldest active member makes room at the hard cap. */
export async function recruitAgentInTransaction(db: DatabaseClient, owner: string, now = Date.now()): Promise<AgentProfile> {
  const state = agentState(await ensureVisitor(db,owner));
  while (state.pool.length >= AGENT_POOL_MAX) {
    const oldest = [...state.pool].sort((a,b) => lastActivity(a,now)-lastActivity(b,now) || a.id.localeCompare(b.id))[0];
    await retireAgent(db,owner,state,oldest,now);
  }
  const agent = makeRecruitedAgent(`agent-live-${randomUUID()}`,randomInt(catalog.length),now);
  state.pool.push(agent);
  await rememberAgent(db,owner,agent,now);
  await persistAgentState(db,owner,state,now);
  return agent;
}

async function recordAgentActivity(db: DatabaseClient, owner: string, id: string, now: number, created: boolean, author?: AgentProfile): Promise<void> {
  // Reload under the existing owner lock: a Sky save may reuse a visitor object
  // from before another entry updated activity. Never overwrite that newer data.
  const visitor = await ensureVisitor(db,owner);
  const state = agentState(visitor);
  const active = state.pool.find(agent => agent.id === id);
  const history = (await db.query<AgentHistoryRow>("SELECT profile_json,retired_at FROM noema_agent_history WHERE owner_id=$1 AND agent_id=$2",[owner,id])).rows[0];
  const source = active ?? (history ? JSON.parse(history.profile_json) as AgentProfile : author ?? catalog.find(agent => agent.id === id));
  if (!source) return;
  // A newly saved legacy author's count is read after insertion, so don't
  // increment that migration count a second time.
  const count = source.creative_count === undefined
    ? (await historicalActivity(db,owner)).get(id)?.count ?? 0
    : source.creative_count+(created ? 1 : 0);
  const updated = { ...source,last_active_at:now,creative_count:count };
  if (active) state.pool[state.pool.findIndex(agent => agent.id === id)] = updated;
  // Talking to a retired author's detail page does not silently rejoin it.
  await rememberAgent(db,owner,updated,now,active ? null : history?.retired_at == null ? now : Number(history.retired_at));
  if (active) await persistAgentState(db,owner,state,now);
}

export async function touchAgentActivity(owner: string, id: string): Promise<void> {
  await databaseTransaction(db => recordAgentActivity(db,owner,id,Date.now(),false));
}

/** Strict FIFO is ordered by admission, never model/client-authored timestamps.
 * Only presentation membership is hidden; canonical art and authors survive. */
export async function enforceCanvasLimitInTransaction(db: DatabaseClient, owner: string): Promise<number> {
  const visible = (await db.query<{artwork_id:string}>(`SELECT c.artwork_id FROM noema_canvas c JOIN noema_artworks a ON a.id=c.artwork_id WHERE c.owner_id=$1 AND c.hidden=0 ORDER BY c.added_at,a.created_at,a.id`,[owner])).rows;
  const evicted = visible.slice(0,Math.max(0,visible.length-CANVAS_STROKE_LIMIT));
  for (const row of evicted) await db.query("UPDATE noema_canvas SET hidden=1 WHERE owner_id=$1 AND artwork_id=$2 AND hidden=0",[owner,row.artwork_id]);
  return evicted.length;
}

async function nextAdmissionTime(db: DatabaseClient, owner: string): Promise<number> {
  const row = (await db.query<{ latest:number|string|null }>("SELECT MAX(added_at) AS latest FROM noema_canvas WHERE owner_id=$1",[owner])).rows[0];
  return Math.max(Date.now(),Number(row?.latest ?? 0)+1);
}

/** A visitor row lock serializes only brief DB operations, never model calls. */
export async function ensureVisitor(db: DatabaseClient, owner: string): Promise<VisitorRow> {
  assertOwner(owner);
  const now = Date.now();
  const initial: AgentState = { pool: published.agents, lastOut: {} };
  for (const agent of catalog) if (!initial.pool.some(a => a.id === agent.id)) initial.lastOut[agent.id] = now;
  const inserted = await db.query(`INSERT INTO noema_visitors(owner_id, agents_json, revision, brush_sequence, created_at, updated_at) VALUES($1,$2,0,0,$3,$3) ON CONFLICT(owner_id) DO NOTHING`, [owner, JSON.stringify(initial), now]);
  const row = (await db.query<VisitorRow>("SELECT * FROM noema_visitors WHERE owner_id=$1 FOR UPDATE", [owner])).rows[0];
  if (!row) throw new Error("Visitor storage initialization failed.");
  if (inserted.rowCount) {
    const migration = owner === SHARED_CANVAS_OWNER ? await migrateSharedCanvas(db) : null;
    if (migration?.agents_json !== undefined) Object.assign(row, {
      agents_json: migration.agents_json, revision: migration.revision,
      brush_sequence: migration.brush_sequence, latest_sky_request: migration.latest_sky_request,
    });
    // Only a truly new installation gets the example. An existing, intentionally
    // empty canvas stays empty, and ordinary reads can never undo a public Clear.
    if (!migration || migration.legacyVisitors === 0) {
      for (const stroke of published.strokes) {
        await archiveArtwork(db, PUBLIC_ARTWORK_OWNER, stroke, "published-example");
        await db.query(`INSERT INTO noema_canvas(owner_id,artwork_id,hidden,transform_json,added_at) VALUES($1,$2,0,$3,$4) ON CONFLICT(owner_id,artwork_id) DO NOTHING`, [owner, stroke.id, stroke.transform ? JSON.stringify(stroke.transform) : null, now]);
      }
    }
  }
  return row;
}

/** Canonical author data is append-only. No ordinary API deletes these rows. */
async function archiveArtwork(db: DatabaseClient, owner: string, stroke: TransitionPath, source: string, author?: AgentProfile): Promise<TransitionPath> {
  // Also guard callers holding their own transaction: a new reserved Sky color
  // must never be absorbed into the one-time historical allocation.
  await initializeColorTreatments(db);
  const agent = author ?? published.agents.find(a => a.id === stroke.agent_id) ?? catalog.find(a => a.id === stroke.agent_id);
  await db.query(`INSERT INTO noema_artworks(id,owner_id,payload,agent_json,created_at,source) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`, [stroke.id, owner, JSON.stringify(stroke), agent ? JSON.stringify(agent) : null, stroke.created_at, source]);
  const saved = (await db.query<ArtworkRow>("SELECT id,owner_id,payload FROM noema_artworks WHERE id=$1", [stroke.id])).rows[0];
  if (!saved || (owner !== SHARED_CANVAS_OWNER && saved.owner_id !== owner && saved.owner_id !== PUBLIC_ARTWORK_OWNER)) throw new Error("Artwork identity collision; existing data was not changed.");
  return assignArtworkColor(db,pathFromRow(saved));
}

export async function saveStrokeInTransaction(db: DatabaseClient, owner: string, stroke: TransitionPath, options: { expectedRevision?: number; visitor?: VisitorRow; author?: AgentProfile } = {}): Promise<TransitionPath> {
  const visitor = options.visitor ?? await ensureVisitor(db, owner);
  const existing = (await db.query<ArtworkRow>("SELECT id,owner_id,payload FROM noema_artworks WHERE id=$1", [stroke.id])).rows[0];
  const work = structuredClone(stroke);
  if (!existing && !work.brush_treatment) {
    assignBrushTreatment(work, brushTreatmentForIndex(Number(visitor.brush_sequence)));
    visitor.brush_sequence = Number(visitor.brush_sequence) + 1;
    await db.query("UPDATE noema_visitors SET brush_sequence=$2,updated_at=$3 WHERE owner_id=$1", [owner, visitor.brush_sequence, Date.now()]);
  }
  const saved = await archiveArtwork(db, owner, work, "agent-generated", options.author ?? agentState(visitor).pool.find(a => a.id === stroke.agent_id));
  // A clear may hide an in-flight result, but cannot destroy a completed work.
  if (options.expectedRevision === undefined || Number(visitor.revision) === options.expectedRevision) {
    await db.query(`INSERT INTO noema_canvas(owner_id,artwork_id,hidden,transform_json,added_at) VALUES($1,$2,0,$3,$4) ON CONFLICT(owner_id,artwork_id) DO NOTHING`, [owner, saved.id, saved.transform ? JSON.stringify(saved.transform) : null, await nextAdmissionTime(db,owner)]);
    await enforceCanvasLimitInTransaction(db,owner);
  }
  if (!existing) await recordAgentActivity(db,owner,stroke.agent_id,Date.now(),true,options.author ?? agentState(visitor).pool.find(agent => agent.id === stroke.agent_id));
  return saved;
}

export async function listAgents(owner: string): Promise<AgentProfile[]> {
  return databaseTransaction(async db => agentState(await ensureVisitor(db, owner)).pool);
}
export function agentCapacity(): number { return AGENT_POOL_MAX; }
export async function getAgent(owner: string, id: string): Promise<AgentProfile | undefined> {
  return databaseTransaction(async db => {
    const active = agentState(await ensureVisitor(db,owner)).pool.find(agent => agent.id === id);
    if (active) return active;
    const history = (await db.query<AgentHistoryRow>("SELECT profile_json,retired_at FROM noema_agent_history WHERE owner_id=$1 AND agent_id=$2",[owner,id])).rows[0];
    return history ? JSON.parse(history.profile_json) as AgentProfile : catalog.find(agent => agent.id === id);
  });
}
export async function ensureCatalogAgents(owner: string, ids: readonly string[]): Promise<AgentProfile[]> {
  return databaseTransaction(async db => {
    const row = await ensureVisitor(db, owner); const state = agentState(row);
    const requested = [...new Set(ids)];
    if (requested.length > AGENT_POOL_MAX) throw new Error("The requested agent roster exceeds its capacity.");
    const now = Date.now();
    const result: AgentProfile[] = [];
    for (const id of requested) {
      const present = state.pool.find(a => a.id === id);
      if (present) { result.push(present); continue; }
      const found = catalog.find(a => a.id === id); if (!found) throw new Error(`Unknown catalog agent: ${id}`);
      while (state.pool.length >= AGENT_POOL_MAX) {
        const oldest = [...state.pool].filter(agent => !requested.includes(agent.id)).sort((a,b) => lastActivity(a,now)-lastActivity(b,now) || a.id.localeCompare(b.id))[0];
        if (!oldest) throw new Error("No room remains in the active agent roster.");
        await retireAgent(db,owner,state,oldest,now);
      }
      const history = (await db.query<AgentHistoryRow>("SELECT profile_json,retired_at FROM noema_agent_history WHERE owner_id=$1 AND agent_id=$2",[owner,id])).rows[0];
      const joined = { ...(history ? JSON.parse(history.profile_json) as AgentProfile : found),joined_at:now,last_active_at:now };
      state.pool.push(joined); delete state.lastOut[id]; result.push(joined);
      await rememberAgent(db,owner,joined,now);
    }
    await persistAgentState(db,owner,state,now);
    return result;
  });
}
export async function attractAgent(owner: string): Promise<AgentProfile | undefined> {
  return databaseTransaction(db => recruitAgentInTransaction(db,owner));
}
export async function removeAgent(owner: string, id: string): Promise<boolean> {
  return databaseTransaction(async db => {
    const row = await ensureVisitor(db, owner); const state = agentState(row);
    const agent = state.pool.find(a => a.id === id); if (!agent) return false;
    const now = Date.now();
    await retireAgent(db,owner,state,agent,now);
    await persistAgentState(db,owner,state,now);
    // Removing an agent from this visitor's pool never touches its artworks.
    return true;
  });
}
export async function clearAgents(owner: string): Promise<number> {
  return databaseTransaction(async db => {
    const row = await ensureVisitor(db, owner); const state = agentState(row); const count = state.pool.length;
    const now = Date.now();
    for (const agent of [...state.pool]) await retireAgent(db,owner,state,agent,now);
    await persistAgentState(db,owner,state,now); return count;
  });
}

export async function readCanvas(owner: string): Promise<{ strokes: TransitionPath[]; authors: AgentProfile[]; canvasRevision: number }> {
  return databaseTransaction(async db => {
    const visitor = await ensureVisitor(db, owner);
    await enforceCanvasLimitInTransaction(db,owner);
    const rows = await db.query<ArtworkRow>(`SELECT a.id,a.owner_id,a.payload,a.agent_json,c.transform_json FROM noema_canvas c JOIN noema_artworks a ON a.id=c.artwork_id WHERE c.owner_id=$1 AND c.hidden=0 ORDER BY c.added_at,a.created_at,a.id`, [owner]);
    const paths = rows.rows.map(pathFromRow);
    const authors = new Map<string,AgentProfile>();
    const active = agentState(visitor).pool;
    for (let index=0; index<paths.length; index++) {
      const id = paths[index].agent_id;
      if (authors.has(id)) continue;
      const canonical = rows.rows[index].agent_json;
      let author = canonical ? JSON.parse(canonical) as AgentProfile : undefined;
      if (!author) {
        const history = (await db.query<AgentHistoryRow>("SELECT profile_json,retired_at FROM noema_agent_history WHERE owner_id=$1 AND agent_id=$2",[owner,id])).rows[0];
        author = history ? JSON.parse(history.profile_json) as AgentProfile
          : active.find(agent => agent.id === id) ?? published.agents.find(agent => agent.id === id) ?? catalog.find(agent => agent.id === id);
      }
      if (author) authors.set(id,author);
    }
    return {strokes:await withArtworkColors(db,paths),authors:[...authors.values()],canvasRevision:Number(visitor.revision)};
  });
}
export async function listStrokes(owner: string): Promise<TransitionPath[]> { return (await readCanvas(owner)).strokes; }
export async function getStroke(owner: string, id: string): Promise<TransitionPath | undefined> {
  return databaseTransaction(async db => {
    await ensureVisitor(db, owner);
    const row = (await db.query<ArtworkRow>(`SELECT a.id,a.owner_id,a.payload,c.transform_json FROM noema_artworks a LEFT JOIN noema_canvas c ON c.artwork_id=a.id AND c.owner_id=$1 WHERE a.id=$2 AND (a.owner_id=$1 OR a.owner_id=$3 OR $1=$4)`, [owner, id, PUBLIC_ARTWORK_OWNER, SHARED_CANVAS_OWNER])).rows[0];
    return row ? (await withArtworkColors(db,[pathFromRow(row)]))[0] : undefined;
  });
}
export async function strokesForAgent(owner: string, id: string): Promise<TransitionPath[]> {
  return (await listStrokes(owner)).filter(p => p.agent_id === id);
}
export async function addStroke(owner: string, stroke: TransitionPath, options: { expectedRevision?: number; author?: AgentProfile } = {}): Promise<TransitionPath> {
  return databaseTransaction(db => saveStrokeInTransaction(db, owner, stroke, options));
}
export async function canvasRevision(owner: string): Promise<number> {
  return databaseTransaction(async db => Number((await ensureVisitor(db, owner)).revision));
}
export async function removeStroke(owner: string, id: string): Promise<boolean> {
  return databaseTransaction(async db => { await ensureVisitor(db, owner); return (await db.query("UPDATE noema_canvas SET hidden=1 WHERE owner_id=$1 AND artwork_id=$2 AND hidden=0", [owner, id])).rowCount > 0; });
}
export async function updateStrokeTransform(owner: string, id: string, transform: StrokeTransform): Promise<TransitionPath | undefined> {
  const tr = transform?.translation;
  if (!tr || ![tr.x,tr.y,transform.rotation,transform.scale].every(Number.isFinite) || transform.scale <= 0 || transform.scale > 100) throw new Error("Invalid canvas transform.");
  return databaseTransaction(async db => {
    await ensureVisitor(db, owner);
    const row = (await db.query<ArtworkRow>(`SELECT a.id,a.owner_id,a.payload FROM noema_canvas c JOIN noema_artworks a ON a.id=c.artwork_id WHERE c.owner_id=$1 AND c.artwork_id=$2 AND c.hidden=0`, [owner, id])).rows[0];
    if (!row) return undefined;
    await db.query("UPDATE noema_canvas SET transform_json=$3 WHERE owner_id=$1 AND artwork_id=$2", [owner, id, JSON.stringify(transform)]);
    return { ...(await withArtworkColors(db,[pathFromRow(row)]))[0], transform: structuredClone(transform) };
  });
}

/** Clear the requested presentation (public for web routes); history stays stored. */
export async function clearStrokes(owner: string): Promise<number> {
  return databaseTransaction(async db => {
    const visitor = await ensureVisitor(db, owner);
    const changed = await db.query("UPDATE noema_canvas SET hidden=1 WHERE owner_id=$1 AND hidden=0", [owner]);
    const revision = Number(visitor.revision) + 1;
    await db.query("UPDATE noema_visitors SET revision=$2,latest_sky_request=NULL,updated_at=$3 WHERE owner_id=$1", [owner, revision, Date.now()]);
    const jobs = await db.query<{ request_id: string; payload: string }>("SELECT request_id,payload FROM noema_sky_jobs WHERE owner_id=$1 AND status<>'cleared'", [owner]);
    for (const row of jobs.rows) {
      const job = JSON.parse(row.payload) as SkyBatch;
      job.status = "cleared"; job.canvasRevision = revision; job.updatedAt = Date.now(); job.finishedAt ??= job.updatedAt; job.updateSequence = (job.updateSequence ?? 0) + 1;
      await db.query("UPDATE noema_sky_jobs SET payload=$3,status='cleared',lease_id=NULL,lease_until=0,updated_at=$4 WHERE owner_id=$1 AND request_id=$2", [owner,row.request_id,JSON.stringify(job),Date.now()]);
    }
    return changed.rowCount;
  });
}

export async function listArchivedStrokes(owner: string, options: { limit?: number; offset?: number } = {}): Promise<{ strokes: TransitionPath[]; total: number; limit: number; offset: number }> {
  const limit = Number.isFinite(options.limit) ? Math.min(100, Math.max(1, Math.floor(options.limit!))) : 40;
  const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset!)) : 0;
  return databaseTransaction(async db => {
    await ensureVisitor(db, owner);
    const rows = await db.query<ArtworkRow>(`SELECT a.id,a.owner_id,a.payload,c.transform_json FROM noema_artworks a LEFT JOIN noema_canvas c ON c.artwork_id=a.id AND c.owner_id=$1 WHERE a.owner_id=$1 OR a.owner_id=$2 OR $1=$5 ORDER BY a.created_at DESC,a.id DESC LIMIT $3 OFFSET $4`, [owner,PUBLIC_ARTWORK_OWNER,limit,offset,SHARED_CANVAS_OWNER]);
    const total = (await db.query<{ count: number | string }>("SELECT count(*) AS count FROM noema_artworks WHERE owner_id=$1 OR owner_id=$2 OR $1=$3", [owner,PUBLIC_ARTWORK_OWNER,SHARED_CANVAS_OWNER])).rows[0].count;
    return { strokes: await withArtworkColors(db,rows.rows.map(pathFromRow)), total: Number(total), limit, offset };
  });
}
export async function restoreStroke(owner: string, id: string, options: { expectedRevision?: number } = {}): Promise<TransitionPath | undefined> {
  return databaseTransaction(async db => {
    const visitor = await ensureVisitor(db, owner);
    if (options.expectedRevision !== undefined && Number(visitor.revision) !== options.expectedRevision) return undefined;
    const row = (await db.query<ArtworkRow>("SELECT id,owner_id,payload FROM noema_artworks WHERE id=$1 AND (owner_id=$2 OR owner_id=$3 OR $2=$4)", [id,owner,PUBLIC_ARTWORK_OWNER,SHARED_CANVAS_OWNER])).rows[0];
    if (!row) return undefined;
    const path = pathFromRow(row);
    await db.query(`INSERT INTO noema_canvas(owner_id,artwork_id,hidden,transform_json,added_at) VALUES($1,$2,0,$3,$4) ON CONFLICT(owner_id,artwork_id) DO UPDATE SET hidden=0,added_at=excluded.added_at WHERE noema_canvas.hidden<>0`, [owner,id,path.transform ? JSON.stringify(path.transform) : null,await nextAdmissionTime(db,owner)]);
    await enforceCanvasLimitInTransaction(db,owner);
    const restored = (await db.query<ArtworkRow>(`SELECT a.id,a.owner_id,a.payload,c.transform_json FROM noema_canvas c JOIN noema_artworks a ON a.id=c.artwork_id WHERE c.owner_id=$1 AND c.artwork_id=$2`, [owner,id])).rows[0];
    return (await withArtworkColors(db,[pathFromRow(restored)]))[0];
  });
}

/** Administrative migration only; never exposed as a public import API. */
export async function importArchivedStrokes(strokes: TransitionPath[], options: { source: string; owner?: string; attachToOwner?: string; agents?: AgentProfile[] } ): Promise<number> {
  return databaseTransaction(async db => {
    if (options.attachToOwner) await ensureVisitor(db, options.attachToOwner);
    let count = 0;
    for (const stroke of strokes) {
      if (!stroke.id || !Array.isArray(stroke.points)) throw new Error("Invalid artwork import.");
      const exists = (await db.query("SELECT id FROM noema_artworks WHERE id=$1", [stroke.id])).rowCount;
      await archiveArtwork(db, options.owner ?? PUBLIC_ARTWORK_OWNER, stroke, options.source, options.agents?.find(a => a.id === stroke.agent_id));
      if (!exists) count++;
      if (options.attachToOwner) await db.query(`INSERT INTO noema_canvas(owner_id,artwork_id,hidden,transform_json,added_at) VALUES($1,$2,0,$3,$4) ON CONFLICT(owner_id,artwork_id) DO NOTHING`, [options.attachToOwner,stroke.id,stroke.transform ? JSON.stringify(stroke.transform) : null,await nextAdmissionTime(db,options.attachToOwner)]);
    }
    if (options.attachToOwner) await enforceCanvasLimitInTransaction(db,options.attachToOwner);
    return count;
  });
}

/** Keep the complete pre-migration snapshot, including legacy Sky job metadata.
 * A raw JSON string preserves its bytes; object input preserves its JSON data.
 * This has no visitor ownership, does not seed a canvas and is admin-only.
 */
export async function importArchivedSnapshot(snapshot: unknown, options: { source: string }): Promise<{ id: string; inserted: boolean }> {
  const payload = typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot);
  if (!payload || !options.source) throw new Error("A snapshot and source are required.");
  JSON.parse(payload);
  const contentHash = createHash("sha256").update(payload).digest("hex");
  const id = createHash("sha256").update(options.source).update("\0").update(payload).digest("hex");
  return databaseTransaction(async db => {
    const result = await db.query("INSERT INTO noema_legacy_snapshots(id,source,content_sha256,payload,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source,content_sha256) DO NOTHING", [id,options.source,contentHash,payload,Date.now()]);
    return {id,inserted:result.rowCount>0};
  });
}
