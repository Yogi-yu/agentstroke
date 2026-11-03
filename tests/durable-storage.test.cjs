const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTypeScriptLoader } = require('./load-typescript.cjs');
const published = require('../data/published-canvas.json');
const A = 'a'.repeat(64), B = 'b'.repeat(64);

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'noema-durable-'));
  const file = path.join(directory,'test.sqlite');
  process.env.NOEMA_SQLITE_PATH = file; delete process.env.DATABASE_URL; delete process.env.RENDER;
  const load = createTypeScriptLoader();
  const database = load('lib/database.ts');
  t.after(async () => { await database.closeDatabases(); fs.rmSync(directory,{recursive:true,force:true}); });
  return {load,database,file,store:load('lib/store.ts'),sky:load('lib/skyBatchStore.ts'),batch:load('lib/skyBatch.ts')};
}
function stroke(id) { return {...structuredClone(published.strokes[0]),id,created_at:Date.now(),brush_treatment:undefined}; }
function batchJob(batch,id) { return batch.createSkyBatch(id,id,Array.from({length:10},(_,i)=>published.agents[i])); }

test('durable file preserves immutable works, personal transforms, agents and cleared canvas across a real process restart', async t => {
  const {store,database,file} = fixture(t);
  await store.clearStrokes(A);
  const work = await store.addStroke(A,stroke('restart-work'));
  const transform = {translation:{x:0.2,y:-0.3},scale:1.3,rotation:0.5};
  await store.updateStrokeTransform(A,work.id,transform);
  await store.removeAgent(A,work.agent_id);
  await store.clearStrokes(A);
  const revision = await store.canvasRevision(A);
  await database.closeDatabases();
  const code = `const {createTypeScriptLoader}=require('./tests/load-typescript.cjs'); const load=createTypeScriptLoader(); const s=load('lib/store.ts'); (async()=>{ const owner='${A}'; console.log(JSON.stringify({visible:await s.listStrokes(owner),restored:await s.restoreStroke(owner,'restart-work'),revision:await s.canvasRevision(owner),agents:await s.listAgents(owner)})); await load('lib/database.ts').closeDatabases(); })().catch(e=>{console.error(e);process.exitCode=1});`;
  const output = execFileSync(process.execPath,['-e',code],{cwd:path.resolve(__dirname,'..'),env:{...process.env,NOEMA_SQLITE_PATH:file},encoding:'utf8'});
  const result = JSON.parse(output.trim());
  assert.deepEqual(result.visible,[]);
  assert.deepEqual(result.restored,{...work,transform});
  assert.equal(result.revision,revision);
  assert.ok(!result.agents.some(a=>a.id===work.agent_id));
});

test('visitors cannot read, transform, remove, clear or restore another visitor’s private work', async t => {
  const {store} = fixture(t);
  await Promise.all([store.clearStrokes(A),store.clearStrokes(B)]);
  const [one,two] = await Promise.all([store.addStroke(A,stroke('private-a')),store.addStroke(B,stroke('private-b'))]);
  assert.equal(await store.getStroke(B,one.id),undefined);
  assert.equal(await store.restoreStroke(B,one.id),undefined);
  assert.equal(await store.removeStroke(B,one.id),false);
  assert.equal(await store.updateStrokeTransform(B,one.id,{translation:{x:2,y:3},scale:1,rotation:0}),undefined);
  await store.clearAgents(A); await store.clearStrokes(A);
  assert.deepEqual((await store.listStrokes(B)).map(s=>s.id),[two.id]);
  assert.equal((await store.getStroke(A,one.id)).id,one.id);
  assert.ok(!(await store.listArchivedStrokes(B)).strokes.some(s=>s.id===one.id));
  assert.ok((await store.listAgents(B)).length>0);
  await assert.rejects(store.listStrokes('spoofed'),/identity/);
});

test('separate route/module evaluations share one SQLite transaction queue', async t => {
  const {store} = fixture(t);
  const second=createTypeScriptLoader()('lib/store.ts');
  await store.clearStrokes(A);
  await Promise.all(Array.from({length:20},(_,index)=>(index%2 ? store : second).addStroke(A,stroke(`parallel-route-${index}`))));
  assert.equal((await second.readCanvas(A)).strokes.length,20);
});

test('canonical artwork never changes on duplicate save; personal transform and material allocation survive hiding and restoring', async t => {
  const {store,database,load} = fixture(t);
  await store.clearStrokes(A);
  const saved = await store.addStroke(A,stroke('immutable'));
  const changed = {...structuredClone(saved),from:'different',brush_treatment:'calligraphy'};
  changed.points[0].anchor='different';
  assert.deepEqual(await store.addStroke(A,changed),saved);
  const transform={translation:{x:3,y:4},scale:2,rotation:0.3};
  await store.updateStrokeTransform(A,saved.id,transform);
  await store.removeStroke(A,saved.id);
  await store.addStroke(A,changed);
  assert.equal((await store.listStrokes(A)).length,0,'retry must not undo a deliberate hide');
  assert.deepEqual(await store.restoreStroke(A,saved.id),{...saved,transform});
  const canonical = await database.databaseTransaction(db=>db.query('SELECT payload FROM noema_artworks WHERE id=$1',[saved.id]));
  assert.deepEqual(JSON.parse(canonical.rows[0].payload),saved);
  const sequence = await database.databaseTransaction(db=>db.query('SELECT brush_sequence FROM noema_visitors WHERE owner_id=$1',[A]));
  assert.equal(sequence.rows[0].brush_sequence,1);
  await database.closeDatabases();
  assert.equal((await store.addStroke(A,stroke('next'))).brush_treatment,load('engine/brushAssignment.ts').brushTreatmentForIndex(1));
});

test('more than 500 generated works remain archived without eviction; pages do not expose other visitors', async t => {
  const {store} = fixture(t);
  await store.clearStrokes(A);
  await Promise.all(Array.from({length:505},(_,i)=>store.addStroke(A,stroke(`retained-${String(i).padStart(4,'0')}`))));
  assert.equal((await store.listStrokes(A)).length,505);
  const page=await store.listArchivedStrokes(A,{limit:100,offset:400});
  assert.equal(page.total,506); assert.equal(page.strokes.length,100);
  assert.equal((await store.listArchivedStrokes(B)).total,1);
  await store.clearStrokes(A);
  assert.equal((await store.listStrokes(A)).length,0);
  assert.equal((await store.listArchivedStrokes(A,{limit:100,offset:500})).strokes.length,6);
  assert.ok(await store.restoreStroke(A,'retained-0000'));
});

test('a model result arriving after Clear is archived but cannot refill canvas; fixed example restoration is revision-fenced', async t => {
  const {store} = fixture(t);
  const revision=await store.canvasRevision(A);
  await store.clearStrokes(A);
  const late=await store.addStroke(A,stroke('late-result'),{expectedRevision:revision});
  assert.ok(await store.getStroke(A,late.id)); assert.deepEqual(await store.listStrokes(A),[]);
  assert.equal(await store.restoreStroke(A,published.strokes[0].id,{expectedRevision:revision}),undefined);
  assert.ok(await store.restoreStroke(A,published.strokes[0].id,{expectedRevision:await store.canvasRevision(A)}));
});

test('public legacy import is idempotent, archived only, and preserves exact historical author data', async t => {
  const {store,database} = fixture(t);
  const old=stroke('public-legacy'); const author={...published.agents[0],id:old.agent_id,name:'Historical identity'};
  assert.equal(await store.importArchivedStrokes([old],{source:'backup',agents:[author]}),1);
  assert.equal(await store.importArchivedStrokes([old],{source:'backup',agents:[author]}),0);
  assert.deepEqual(await store.listStrokes(A),published.strokes);
  assert.equal((await store.listArchivedStrokes(B)).total,2);
  assert.deepEqual(await store.restoreStroke(A,old.id),JSON.parse(JSON.stringify(old)));
  const row=await database.databaseTransaction(db=>db.query('SELECT agent_json FROM noema_artworks WHERE id=$1',[old.id]));
  assert.deepEqual(JSON.parse(row.rows[0].agent_json),author);
});

test('complete legacy snapshots preserve original bytes, jobs and provenance without resuming or seeding them', async t => {
  const {store,database,sky} = fixture(t);
  const raw=fs.readFileSync(path.resolve(__dirname,'../data/archive/published-canvas-2026-10-15.json'),'utf8');
  const first=await store.importArchivedSnapshot(raw,{source:'original-release'});
  assert.equal(first.inserted,true);
  assert.deepEqual(await store.importArchivedSnapshot(raw,{source:'original-release'}),{id:first.id,inserted:false});
  const row=await database.databaseTransaction(db=>db.query('SELECT payload FROM noema_legacy_snapshots WHERE id=$1',[first.id]));
  assert.equal(row.rows[0].payload,raw);
  assert.deepEqual(await store.listStrokes(A),published.strokes);
  assert.equal(await sky.readSkyBatch(A),null);
});

test('Sky claims, checkpoints and idempotency are atomic and owner-scoped, with no eight-job history cap', async t => {
  const {store,sky,batch,database} = fixture(t);
  await store.clearStrokes(A);
  const first=batchJob(batch,'request-0');
  const claims=await Promise.all([sky.claimSkyBatch(A,first),sky.claimSkyBatch(A,first)]);
  assert.equal(claims.filter(c=>c.claimed).length,1);
  const accepted=claims.find(c=>c.claimed);
  assert.equal((await sky.claimSkyBatch(A,batchJob(batch,'competing'))).code,'active');
  assert.equal(await sky.readSkyBatch(B,'request-0'),null);
  const job=accepted.job; job.entries[0].stroke={...stroke('sky-atomic'),agent_id:job.entries[0].agent.id}; job.entries[0].status='succeeded'; batch.touchSkyBatch(job);
  assert.equal(await sky.saveSkyBatch(A,job,accepted.leaseId),true);
  assert.ok((await store.listStrokes(A)).some(s=>s.id==='sky-atomic'));
  assert.equal((await sky.readSkyBatch(A,job.requestId)).entries[0].stroke.id,'sky-atomic');
  await sky.abandonSkyBatch(A,job.requestId,accepted.leaseId);
  for(let index=1;index<11;index++){
    const next=await sky.claimSkyBatch(A,batchJob(batch,`request-${index}`)); assert.equal(next.claimed,true);
    await sky.abandonSkyBatch(A,next.job.requestId,next.leaseId);
  }
  assert.equal((await sky.claimSkyBatch(A,first)).code,'existing');
  assert.equal((await sky.readSkyBatch(A,'request-0')).entries[0].stroke.id,'sky-atomic');
  const count=await database.databaseTransaction(db=>db.query('SELECT count(*) AS count FROM noema_sky_jobs WHERE owner_id=$1',[A]));
  assert.equal(count.rows[0].count,11);
});

test('expired worker leases preserve successes, expose interruption, fence stale checkpoints and permit one retry', async t => {
  const {store,sky,batch,database} = fixture(t);
  await store.clearStrokes(A);
  const claim=await sky.claimSkyBatch(A,batchJob(batch,'lease-job'));
  const job=claim.job; job.entries[0].status='succeeded'; job.entries[0].stroke={...stroke('lease-success'),agent_id:job.entries[0].agent.id}; batch.touchSkyBatch(job);
  await sky.saveSkyBatch(A,job,claim.leaseId);
  await database.databaseTransaction(db=>db.query('UPDATE noema_sky_jobs SET lease_until=0 WHERE owner_id=$1 AND request_id=$2',[A,job.requestId]));
  const interrupted=await sky.readSkyBatch(A,job.requestId);
  assert.equal(interrupted.status,'partial'); assert.equal(interrupted.entries[1].errorCode,'interrupted');
  assert.equal(await sky.heartbeatSkyBatch(A,job.requestId,claim.leaseId),false);
  job.entries[1].status='succeeded'; job.entries[1].stroke={...stroke('late-paid'),agent_id:job.entries[1].agent.id}; batch.touchSkyBatch(job);
  assert.equal(await sky.saveSkyBatch(A,job,claim.leaseId),false);
  assert.ok(await store.getStroke(A,'late-paid')); assert.ok(!(await store.listStrokes(A)).some(s=>s.id==='late-paid'));
  const retry=await sky.claimSkyBatch(A,batch.retrySkyBatch(interrupted,'retry','retry-request'),{retryOf:job.requestId});
  assert.equal(retry.claimed,true);
  const second=await sky.claimSkyBatch(A,batch.retrySkyBatch(interrupted,'retry2','retry2-request'),{retryOf:job.requestId});
  assert.equal(second.code,'already_retried'); assert.equal(second.job.requestId,'retry-request');
  await store.clearStrokes(A);
  assert.equal(await sky.readSkyBatch(A),null);
  assert.equal((await sky.readSkyBatch(A,job.requestId)).status,'cleared');
  assert.equal(await sky.saveSkyBatch(A,retry.job,retry.leaseId),false);
  assert.deepEqual(await store.listStrokes(A),[]);
  assert.ok(await store.getStroke(A,'lease-success'));
});

test('failed Sky checkpoint rolls back artwork and progress together instead of acknowledging a partial save', async t => {
  const {store,sky,batch} = fixture(t);
  await store.clearStrokes(A);
  const collision=await store.addStroke(B,stroke('owned-by-b'));
  const claim=await sky.claimSkyBatch(A,batchJob(batch,'rollback-job'));
  const job=claim.job;
  job.entries[0].status='succeeded'; job.entries[0].stroke={...stroke('rolled-back'),agent_id:job.entries[0].agent.id};
  job.entries[1].status='succeeded'; job.entries[1].stroke={...collision,agent_id:job.entries[1].agent.id};
  batch.touchSkyBatch(job);
  await assert.rejects(sky.saveSkyBatch(A,job,claim.leaseId),/identity collision/);
  assert.equal(await store.getStroke(A,'rolled-back'),undefined);
  assert.deepEqual(await store.listStrokes(A),[]);
  assert.equal((await sky.readSkyBatch(A,job.requestId)).entries[0].status,'queued');
  assert.equal((await store.getStroke(B,collision.id)).agent_id,collision.agent_id);
});

test('production never silently falls back to ephemeral or in-memory storage', async t => {
  const {database} = fixture(t);
  const previous=process.env.NOEMA_SQLITE_PATH;
  process.env.RENDER='true';
  await assert.rejects(database.storageHealth(),/Render requires/);
  delete process.env.RENDER; delete process.env.NOEMA_SQLITE_PATH;
  const previousNode=process.env.NODE_ENV; process.env.NODE_ENV='production';
  await assert.rejects(database.storageHealth(),/DATABASE_URL/);
  process.env.NOEMA_SQLITE_PATH=previous;
  if(previousNode===undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=previousNode;
});
