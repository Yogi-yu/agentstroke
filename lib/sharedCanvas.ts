import { createHash } from "node:crypto";
import type { DatabaseClient } from "@/lib/database";
import type { AgentProfile } from "@/lib/types";
import type { SkyBatch } from "@/lib/skyBatch";

/** A database namespace, not a credential. All public routes resolve it server-side. */
export const SHARED_CANVAS_OWNER = createHash("sha256").update("noema:shared-public-canvas:v1").digest("hex");

export class SharedCanvasMigrationPending extends Error {
  readonly code = "shared_canvas_migration_pending";
  constructor() { super("Shared canvas migration is waiting for an active legacy generation to finish."); }
}

interface LegacyVisitor {
  owner_id: string;
  agents_json: string;
  revision: number;
  brush_sequence: number;
  latest_sky_request: string | null;
}
interface LegacyJob {
  owner_id: string;
  request_id: string;
  payload: string;
  status: SkyBatch["status"];
  revision: number;
  lease_until: number | string;
  created_at: number | string;
  updated_at: number | string;
}
interface MigrationResult {
  legacyVisitors: number;
  agents_json?: string;
  revision: number;
  brush_sequence: number;
  latest_sky_request: string | null;
}

/** Called ONLY when inserting the shared namespace, inside that same transaction.
 * The unique visitor row is the durable migration marker. A crash rolls it and
 * every copied membership/job back together; subsequent reads never re-seed.
 * Original works, author IDs, browser canvases and job payloads remain untouched.
 */
export async function migrateSharedCanvas(db: DatabaseClient): Promise<MigrationResult> {
  const owner = SHARED_CANVAS_OWNER;
  // Lock legacy rows in a deterministic order, fencing their brief checkpoints.
  // A healthy legacy generation must finish before switching namespaces; copying
  // an active lease would orphan its later paid results on the old canvas.
  const visitors = (await db.query<LegacyVisitor>("SELECT * FROM noema_visitors WHERE owner_id<>$1 ORDER BY owner_id FOR UPDATE", [owner])).rows;
  const jobs = (await db.query<LegacyJob>("SELECT * FROM noema_sky_jobs WHERE owner_id<>$1 ORDER BY created_at,owner_id,request_id", [owner])).rows;
  if (jobs.some(job => job.status === "running" && Number(job.lease_until) > Date.now())) {
    throw new SharedCanvasMigrationPending();
  }
  const revision = visitors.reduce((latest, visitor) => Math.max(latest, Number(visitor.revision)), 0);
  const brush_sequence = visitors.reduce((sum, visitor) => sum + Number(visitor.brush_sequence), 0);
  const result: MigrationResult = { legacyVisitors: visitors.length, revision, brush_sequence, latest_sky_request: null };

  if (visitors.length) {
    const agents = new Map<string, AgentProfile>();
    const lastOut: Record<string, number> = {};
    for (const visitor of visitors) {
      const state = JSON.parse(visitor.agents_json) as { pool: AgentProfile[]; lastOut: Record<string, number> };
      for (const agent of state.pool) {
        const existing = agents.get(agent.id);
        if (!existing || (agent.joined_at ?? 0) > (existing.joined_at ?? 0)) agents.set(agent.id, agent);
      }
      for (const [id, time] of Object.entries(state.lastOut)) lastOut[id] = Math.max(lastOut[id] ?? 0, time);
    }
    for (const id of agents.keys()) delete lastOut[id];
    result.agents_json = JSON.stringify({ pool: [...agents.values()], lastOut });
  }

  // Duplicate public examples collapse to one membership. For a work that was
  // placed on multiple canvases, its most recently added visible placement wins.
  const visible = (await db.query<{ artwork_id: string; transform_json: string | null; added_at: number | string }>(
    "SELECT artwork_id,transform_json,added_at FROM noema_canvas WHERE owner_id<>$1 AND hidden=0 ORDER BY added_at DESC,owner_id", [owner],
  )).rows;
  for (const membership of visible) {
    await db.query("INSERT INTO noema_canvas(owner_id,artwork_id,hidden,transform_json,added_at) VALUES($1,$2,0,$3,$4) ON CONFLICT(owner_id,artwork_id) DO NOTHING", [owner,membership.artwork_id,membership.transform_json,membership.added_at]);
  }

  // Browser-scoped request IDs can collide. Namespace the copies deterministically
  // and rewrite retry pointers, without changing any original history records.
  const migratedId = (legacyOwner: string, request: string) => `legacy_${createHash("sha256").update(`${legacyOwner}:${request}`).digest("hex")}`;
  const visitorByOwner = new Map(visitors.map(visitor => [visitor.owner_id, visitor]));
  let latestTime = -Infinity;
  for (const row of jobs) {
    const job = JSON.parse(row.payload) as SkyBatch;
    const visitor = visitorByOwner.get(row.owner_id);
    const current = visitor && Number(row.revision) === Number(visitor.revision) && row.status !== "cleared";
    job.requestId = migratedId(row.owner_id, row.request_id);
    if (job.retryRequestId) job.retryRequestId = migratedId(row.owner_id, job.retryRequestId);
    job.canvasRevision = revision;
    if (!current) job.status = "cleared";
    else if (job.status === "running") {
      // Expired legacy work is recoverable only via an explicit failed-slot retry.
      const now = Date.now();
      for (const entry of job.entries) {
        if (entry.status === "queued" || entry.status === "running") {
          entry.status = "failed";
          entry.errorCode = "interrupted";
          entry.error = "Generation was interrupted. Saved strokes are preserved. Retry the unfinished slots.";
          entry.finishedAt = now;
        }
      }
      job.status = job.entries.every(entry => entry.status === "succeeded") ? "complete"
        : job.entries.some(entry => entry.status === "succeeded") ? "partial" : "failed";
      job.finishedAt = now;
      job.updatedAt = now;
      job.updateSequence = (job.updateSequence ?? 0) + 1;
    }
    await db.query("INSERT INTO noema_sky_jobs(owner_id,request_id,payload,status,revision,lease_id,lease_until,created_at,updated_at) VALUES($1,$2,$3,$4,$5,NULL,0,$6,$7) ON CONFLICT(owner_id,request_id) DO NOTHING", [owner,job.requestId,JSON.stringify(job),job.status,revision,row.created_at,row.updated_at]);
    if (current && visitor.latest_sky_request === row.request_id && Number(row.created_at) >= latestTime) {
      latestTime = Number(row.created_at);
      result.latest_sky_request = job.requestId;
    }
  }
  if (result.agents_json !== undefined) {
    await db.query("UPDATE noema_visitors SET agents_json=$2,revision=$3,brush_sequence=$4,latest_sky_request=$5 WHERE owner_id=$1", [owner,result.agents_json,revision,brush_sequence,result.latest_sky_request]);
  }
  return result;
}
