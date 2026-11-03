import { randomUUID } from "node:crypto";
import { databaseTransaction, type DatabaseClient } from "@/lib/database";
import { ensureVisitor, saveStrokeInTransaction, type VisitorRow } from "@/lib/store";
import { touchSkyBatch, type SkyBatch } from "@/lib/skyBatch";

export { canvasRevision } from "@/lib/store";
export const SKY_LEASE_MS = 90_000;
interface JobRow { request_id: string; payload: string; status: SkyBatch["status"]; revision: number; lease_id: string | null; lease_until: number | string }
export interface SkyClaim { job: SkyBatch | null; claimed: boolean; leaseId?: string; code?: "existing" | "active" | "already_retried" | "canvas_cleared" | "invalid_retry" }

async function rowFor(db: DatabaseClient, owner: string, requestId: string): Promise<JobRow | undefined> {
  return (await db.query<JobRow>("SELECT * FROM noema_sky_jobs WHERE owner_id=$1 AND request_id=$2", [owner,requestId])).rows[0];
}
async function follow(db: DatabaseClient, owner: string, row: JobRow): Promise<SkyBatch> {
  const visited = new Set<string>();
  let job = JSON.parse(row.payload) as SkyBatch;
  while (job.retryRequestId && !visited.has(job.retryRequestId)) {
    visited.add(job.requestId);
    const successor = await rowFor(db,owner,job.retryRequestId);
    if (!successor) break;
    job = JSON.parse(successor.payload) as SkyBatch;
  }
  return job;
}
function interrupted(job: SkyBatch): SkyBatch {
  const now = Date.now();
  for (const entry of job.entries) {
    if (entry.status === "queued" || entry.status === "running") {
      entry.status = "failed"; entry.errorCode = "interrupted";
      entry.error = "Generation was interrupted. Saved strokes are preserved. Retry the unfinished slots.";
      entry.finishedAt = now;
    }
  }
  job.status = job.entries.every(e => e.status === "succeeded") ? "complete" : job.entries.some(e => e.status === "succeeded") ? "partial" : "failed";
  job.finishedAt = now; touchSkyBatch(job,now);
  return job;
}
async function expireLeases(db: DatabaseClient, owner: string): Promise<void> {
  // A deployment never cancels another healthy worker; only an expired lease
  // can be interrupted, and the visitor row lock fences concurrent heartbeats.
  const expired = await db.query<JobRow>("SELECT * FROM noema_sky_jobs WHERE owner_id=$1 AND status='running' AND lease_until<=$2", [owner,Date.now()]);
  for (const row of expired.rows) {
    const job = interrupted(JSON.parse(row.payload) as SkyBatch);
    await db.query("UPDATE noema_sky_jobs SET payload=$3,status=$4,lease_id=NULL,lease_until=0,updated_at=$5 WHERE owner_id=$1 AND request_id=$2", [owner,row.request_id,JSON.stringify(job),job.status,Date.now()]);
  }
}

export async function readSkySnapshot(owner: string, requestId?: string): Promise<{job: SkyBatch | null; canvasRevision: number}> {
  return databaseTransaction(async db => {
    const visitor = await ensureVisitor(db,owner); await expireLeases(db,owner);
    const id = requestId ?? visitor.latest_sky_request;
    const canvasRevision = Number(visitor.revision);
    if (!id) return {job:null,canvasRevision};
    const row = await rowFor(db,owner,id);
    return {job:row ? await follow(db,owner,row) : null,canvasRevision};
  });
}
export async function readSkyBatch(owner: string, requestId?: string): Promise<SkyBatch | null> { return (await readSkySnapshot(owner,requestId)).job; }

/** Owner/request identity and the active-job gate are persisted atomically. */
export async function claimSkyBatch(owner: string, proposed: SkyBatch, options: { retryOf?: string; expectedRevision?: number } = {}): Promise<SkyClaim> {
  return databaseTransaction(async db => {
    const visitor = await ensureVisitor(db,owner); await expireLeases(db,owner);
    const existing = await rowFor(db,owner,proposed.requestId);
    if (existing) return { job: await follow(db,owner,existing), claimed: false, code: "existing" };
    const revision = Number(visitor.revision);
    if ((options.expectedRevision !== undefined && options.expectedRevision !== revision) || (proposed.canvasRevision !== undefined && proposed.canvasRevision !== revision)) {
      return {job:null,claimed:false,code:"canvas_cleared"};
    }
    let source: SkyBatch | undefined;
    if (options.retryOf) {
      const previous = await rowFor(db,owner,options.retryOf);
      if (!previous) return {job:null,claimed:false,code:"invalid_retry"};
      source = JSON.parse(previous.payload) as SkyBatch;
      if (source.retryRequestId) return {job:await follow(db,owner,previous),claimed:false,code:"already_retried"};
      if (source.status === "cleared" || Number(previous.revision) !== revision) return {job:source,claimed:false,code:"canvas_cleared"};
      if (source.status === "running" || !source.entries.some(entry => entry.status === "failed")) return {job:source,claimed:false,code:"invalid_retry"};
    }
    const active = (await db.query<JobRow>("SELECT * FROM noema_sky_jobs WHERE owner_id=$1 AND status='running' ORDER BY created_at DESC LIMIT 1", [owner])).rows[0];
    if (active) return {job:JSON.parse(active.payload) as SkyBatch,claimed:false,code:"active"};
    const now = Date.now(); const leaseId = randomUUID();
    const job = structuredClone(proposed); job.canvasRevision = revision;
    await db.query("INSERT INTO noema_sky_jobs(owner_id,request_id,payload,status,revision,lease_id,lease_until,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [owner,job.requestId,JSON.stringify(job),job.status,revision,leaseId,now+SKY_LEASE_MS,job.createdAt,now]);
    if (source) {
      source.retryRequestId = job.requestId; touchSkyBatch(source,now);
      await db.query("UPDATE noema_sky_jobs SET payload=$3,updated_at=$4 WHERE owner_id=$1 AND request_id=$2", [owner,source.requestId,JSON.stringify(source),now]);
    }
    await db.query("UPDATE noema_visitors SET latest_sky_request=$2,updated_at=$3 WHERE owner_id=$1", [owner,job.requestId,now]);
    return {job,claimed:true,leaseId};
  });
}

async function archiveSuccesses(db: DatabaseClient, owner: string, job: SkyBatch, visitor: VisitorRow, visible: boolean): Promise<void> {
  for (const entry of job.entries) {
    if (entry.status === "succeeded" && entry.stroke) {
      entry.stroke = await saveStrokeInTransaction(db,owner,entry.stroke,{visitor,author:entry.agent,expectedRevision:visible ? Number(visitor.revision) : -1});
    }
  }
}

/** Save canonical artwork, canvas membership and progress in ONE commit.
 * Even a cleared/stale worker's valid paid result remains in its owner's archive.
 */
export async function saveSkyBatch(owner: string, proposed: SkyBatch, leaseId: string): Promise<boolean> {
  return databaseTransaction(async db => {
    const visitor = await ensureVisitor(db,owner);
    const row = await rowFor(db,owner,proposed.requestId);
    if (!row) return false;
    const current = JSON.parse(row.payload) as SkyBatch;
    const job = structuredClone(proposed);
    const valid = row.lease_id === leaseId && Number(row.lease_until) > Date.now() && row.status === "running" && Number(row.revision) === Number(visitor.revision) && proposed.canvasRevision === Number(visitor.revision)
      && (job.updateSequence ?? 0) >= (current.updateSequence ?? 0)
      && !current.entries.some((entry,index) => entry.status === "succeeded" && (job.entries[index]?.status !== "succeeded" || job.entries[index]?.stroke?.id !== entry.stroke?.id));
    // No membership on a stale lease; no job overwrite after Clear/retry.
    await archiveSuccesses(db,owner,job,visitor,valid);
    if (!valid) return false;
    const running = job.status === "running";
    await db.query("UPDATE noema_sky_jobs SET payload=$3,status=$4,lease_id=$5,lease_until=$6,updated_at=$7 WHERE owner_id=$1 AND request_id=$2", [owner,job.requestId,JSON.stringify(job),job.status,running ? leaseId : null,running ? Date.now()+SKY_LEASE_MS : 0,Date.now()]);
    return true;
  });
}

export async function heartbeatSkyBatch(owner: string, requestId: string, leaseId: string): Promise<boolean> {
  return databaseTransaction(async db => {
    const visitor = await ensureVisitor(db,owner);
    const result = await db.query("UPDATE noema_sky_jobs SET lease_until=$4 WHERE owner_id=$1 AND request_id=$2 AND lease_id=$3 AND status='running' AND lease_until>$5 AND revision=$6", [owner,requestId,leaseId,Date.now()+SKY_LEASE_MS,Date.now(),Number(visitor.revision)]);
    return result.rowCount > 0;
  });
}

export async function abandonSkyBatch(owner: string, requestId: string, leaseId: string): Promise<void> {
  await databaseTransaction(async db => {
    await ensureVisitor(db,owner);
    const row = await rowFor(db,owner,requestId);
    if (!row || row.lease_id !== leaseId || row.status !== "running") return;
    const job = interrupted(JSON.parse(row.payload) as SkyBatch);
    await db.query("UPDATE noema_sky_jobs SET payload=$3,status=$4,lease_id=NULL,lease_until=0,updated_at=$5 WHERE owner_id=$1 AND request_id=$2", [owner,requestId,JSON.stringify(job),job.status,Date.now()]);
  });
}
