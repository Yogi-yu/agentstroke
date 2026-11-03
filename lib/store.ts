import { createHash, randomInt } from "node:crypto";
import type { AgentProfile, StrokeTransform, TransitionPath } from "@/lib/types";
import { makeAgents } from "@/lib/agents";
import { createPublishedCanvas } from "@/lib/publishedCanvas";
import { assignBrushTreatment, brushTreatmentForIndex } from "@/engine/brushAssignment";
import { databaseTransaction, type DatabaseClient } from "@/lib/database";
import type { SkyBatch } from "@/lib/skyBatch";

export const PUBLIC_ARTWORK_OWNER = "public";
interface AgentState { pool: AgentProfile[]; lastOut: Record<string, number> }
export interface VisitorRow { owner_id: string; agents_json: string; revision: number; brush_sequence: number; latest_sky_request: string | null }
interface ArtworkRow { id: string; owner_id: string; payload: string; transform_json?: string | null; hidden?: number }
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
    for (const stroke of published.strokes) {
      await archiveArtwork(db, PUBLIC_ARTWORK_OWNER, stroke, "published-example");
      await db.query(`INSERT INTO noema_canvas(owner_id,artwork_id,hidden,transform_json,added_at) VALUES($1,$2,0,$3,$4) ON CONFLICT(owner_id,artwork_id) DO NOTHING`, [owner, stroke.id, stroke.transform ? JSON.stringify(stroke.transform) : null, now]);
    }
  }
  return row;
}

/** Canonical author data is append-only. No ordinary API deletes these rows. */
async function archiveArtwork(db: DatabaseClient, owner: string, stroke: TransitionPath, source: string, author?: AgentProfile): Promise<TransitionPath> {
  const agent = author ?? published.agents.find(a => a.id === stroke.agent_id) ?? catalog.find(a => a.id === stroke.agent_id);
  await db.query(`INSERT INTO noema_artworks(id,owner_id,payload,agent_json,created_at,source) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`, [stroke.id, owner, JSON.stringify(stroke), agent ? JSON.stringify(agent) : null, stroke.created_at, source]);
  const saved = (await db.query<ArtworkRow>("SELECT id,owner_id,payload FROM noema_artworks WHERE id=$1", [stroke.id])).rows[0];
  if (!saved || (saved.owner_id !== owner && saved.owner_id !== PUBLIC_ARTWORK_OWNER)) throw new Error("Artwork identity collision; existing data was not changed.");
  return pathFromRow(saved);
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
    await db.query(`INSERT INTO noema_canvas(owner_id,artwork_id,hidden,transform_json,added_at) VALUES($1,$2,0,$3,$4) ON CONFLICT(owner_id,artwork_id) DO NOTHING`, [owner, saved.id, saved.transform ? JSON.stringify(saved.transform) : null, Date.now()]);
  }
  return saved;
}

export async function listAgents(owner: string): Promise<AgentProfile[]> {
  return databaseTransaction(async db => agentState(await ensureVisitor(db, owner)).pool);
}
export function agentCapacity(): number { return catalog.length; }
export async function getAgent(owner: string, id: string): Promise<AgentProfile | undefined> {
  return (await listAgents(owner)).find(a => a.id === id) ?? catalog.find(a => a.id === id);
}
export async function ensureCatalogAgents(owner: string, ids: readonly string[]): Promise<AgentProfile[]> {
  return databaseTransaction(async db => {
    const row = await ensureVisitor(db, owner); const state = agentState(row);
    const result = [...new Set(ids)].map(id => {
      const present = state.pool.find(a => a.id === id); if (present) return present;
      const found = catalog.find(a => a.id === id); if (!found) throw new Error(`Unknown catalog agent: ${id}`);
      const joined = { ...found, joined_at: Date.now() }; state.pool.push(joined); delete state.lastOut[id]; return joined;
    });
    await db.query("UPDATE noema_visitors SET agents_json=$2,updated_at=$3 WHERE owner_id=$1", [owner, JSON.stringify(state), Date.now()]);
    return result;
  });
}
export async function attractAgent(owner: string): Promise<AgentProfile | undefined> {
  return databaseTransaction(async db => {
    const row = await ensureVisitor(db, owner); const state = agentState(row);
    const missing = catalog.filter(a => !state.pool.some(p => p.id === a.id));
    if (!missing.length) return undefined;
    // Preserve the original stochastic attraction: idle candidates are gently
    // favored, while high-entropy sampling remains the dominant factor.
    const now = Date.now();
    const idles = missing.map(agent => now - (state.lastOut[agent.id] ?? now));
    const maxIdle = Math.max(1,...idles);
    let selected = missing[0], bestScore = -Infinity;
    missing.forEach((agent,index) => {
      const score = randomInt(4294967296) / 4294967296 * 0.6 + idles[index] / maxIdle * 0.4;
      if (score > bestScore) { selected = agent; bestScore = score; }
    });
    const joined = { ...selected, joined_at: now };
    state.pool.push(joined); delete state.lastOut[joined.id];
    await db.query("UPDATE noema_visitors SET agents_json=$2,updated_at=$3 WHERE owner_id=$1", [owner, JSON.stringify(state), Date.now()]);
    return joined;
  });
}
export async function removeAgent(owner: string, id: string): Promise<boolean> {
  return databaseTransaction(async db => {
    const row = await ensureVisitor(db, owner); const state = agentState(row);
    if (!state.pool.some(a => a.id === id)) return false;
    state.pool = state.pool.filter(a => a.id !== id); state.lastOut[id] = Date.now();
    await db.query("UPDATE noema_visitors SET agents_json=$2,updated_at=$3 WHERE owner_id=$1", [owner, JSON.stringify(state), Date.now()]);
    // Removing an agent from this visitor's pool never touches its artworks.
    return true;
  });
}
export async function clearAgents(owner: string): Promise<number> {
  return databaseTransaction(async db => {
    const row = await ensureVisitor(db, owner); const state = agentState(row); const count = state.pool.length;
    state.pool.forEach(a => { state.lastOut[a.id] = Date.now(); }); state.pool = [];
    await db.query("UPDATE noema_visitors SET agents_json=$2,updated_at=$3 WHERE owner_id=$1", [owner, JSON.stringify(state), Date.now()]); return count;
  });
}

export async function readCanvas(owner: string): Promise<{ strokes: TransitionPath[]; canvasRevision: number }> {
  return databaseTransaction(async db => {
    const visitor = await ensureVisitor(db, owner);
    const rows = await db.query<ArtworkRow>(`SELECT a.id,a.owner_id,a.payload,c.transform_json FROM noema_canvas c JOIN noema_artworks a ON a.id=c.artwork_id WHERE c.owner_id=$1 AND c.hidden=0 ORDER BY a.created_at,a.id`, [owner]);
    return {strokes:rows.rows.map(pathFromRow),canvasRevision:Number(visitor.revision)};
  });
}
export async function listStrokes(owner: string): Promise<TransitionPath[]> { return (await readCanvas(owner)).strokes; }
export async function getStroke(owner: string, id: string): Promise<TransitionPath | undefined> {
  return databaseTransaction(async db => {
    await ensureVisitor(db, owner);
    const row = (await db.query<ArtworkRow>(`SELECT a.id,a.owner_id,a.payload,c.transform_json FROM noema_artworks a LEFT JOIN noema_canvas c ON c.artwork_id=a.id AND c.owner_id=$1 WHERE a.id=$2 AND (a.owner_id=$1 OR a.owner_id=$3)`, [owner, id, PUBLIC_ARTWORK_OWNER])).rows[0];
    return row ? pathFromRow(row) : undefined;
  });
}
export async function strokesForAgent(owner: string, id: string): Promise<TransitionPath[]> {
  return (await listStrokes(owner)).filter(p => p.agent_id === id);
}
export async function addStroke(owner: string, stroke: TransitionPath, options: { expectedRevision?: number } = {}): Promise<TransitionPath> {
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
    return { ...pathFromRow(row), transform: structuredClone(transform) };
  });
}

/** Clear only this visitor's presentation; artwork and job history stay stored. */
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
    const rows = await db.query<ArtworkRow>(`SELECT a.id,a.owner_id,a.payload,c.transform_json FROM noema_artworks a LEFT JOIN noema_canvas c ON c.artwork_id=a.id AND c.owner_id=$1 WHERE a.owner_id=$1 OR a.owner_id=$2 ORDER BY a.created_at DESC,a.id DESC LIMIT $3 OFFSET $4`, [owner,PUBLIC_ARTWORK_OWNER,limit,offset]);
    const total = (await db.query<{ count: number | string }>("SELECT count(*) AS count FROM noema_artworks WHERE owner_id=$1 OR owner_id=$2", [owner,PUBLIC_ARTWORK_OWNER])).rows[0].count;
    return { strokes: rows.rows.map(pathFromRow), total: Number(total), limit, offset };
  });
}
export async function restoreStroke(owner: string, id: string, options: { expectedRevision?: number } = {}): Promise<TransitionPath | undefined> {
  return databaseTransaction(async db => {
    const visitor = await ensureVisitor(db, owner);
    if (options.expectedRevision !== undefined && Number(visitor.revision) !== options.expectedRevision) return undefined;
    const row = (await db.query<ArtworkRow>("SELECT id,owner_id,payload FROM noema_artworks WHERE id=$1 AND (owner_id=$2 OR owner_id=$3)", [id,owner,PUBLIC_ARTWORK_OWNER])).rows[0];
    if (!row) return undefined;
    const path = pathFromRow(row);
    await db.query(`INSERT INTO noema_canvas(owner_id,artwork_id,hidden,transform_json,added_at) VALUES($1,$2,0,$3,$4) ON CONFLICT(owner_id,artwork_id) DO UPDATE SET hidden=0`, [owner,id,path.transform ? JSON.stringify(path.transform) : null,Date.now()]);
    const restored = (await db.query<ArtworkRow>(`SELECT a.id,a.owner_id,a.payload,c.transform_json FROM noema_canvas c JOIN noema_artworks a ON a.id=c.artwork_id WHERE c.owner_id=$1 AND c.artwork_id=$2`, [owner,id])).rows[0];
    return pathFromRow(restored);
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
      if (options.attachToOwner) await db.query(`INSERT INTO noema_canvas(owner_id,artwork_id,hidden,transform_json,added_at) VALUES($1,$2,0,$3,$4) ON CONFLICT(owner_id,artwork_id) DO NOTHING`, [options.attachToOwner,stroke.id,stroke.transform ? JSON.stringify(stroke.transform) : null,Date.now()]);
    }
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
