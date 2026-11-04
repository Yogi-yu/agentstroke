const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createTypeScriptLoader } = require('./load-typescript.cjs');
const published = require('../data/published-canvas.json');
const A = 'a'.repeat(64), B = 'b'.repeat(64);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noema-shared-test-'));
  const before = Object.fromEntries(['NOEMA_SQLITE_PATH','DATABASE_URL','RENDER','NODE_ENV'].map(key => [key, process.env[key]]));
  process.env.NOEMA_SQLITE_PATH = path.join(dir, 'shared.sqlite');
  process.env.DATABASE_URL = ''; process.env.RENDER = ''; process.env.NODE_ENV = 'test';
  const load = createTypeScriptLoader();
  const database = load('lib/database.ts');
  t.after(async () => {
    await database.closeDatabases();
    for (const [key,value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const shared = load('lib/sharedCanvas.ts').SHARED_CANVAS_OWNER;
  const query = async (sql, params=[]) => (await database.databaseTransaction(db => db.query(sql, params))).rows;
  return {load,database,shared,query,store:load('lib/store.ts'),sky:load('lib/skyBatchStore.ts'),batch:load('lib/skyBatch.ts')};
}
function stroke(id) { return {...structuredClone(published.strokes[0]),id,created_at:Date.now(),brush_treatment:undefined}; }
function job(batch,id) { return batch.createSkyBatch(id,id,Array.from({length:10},(_,i)=>published.agents[i])); }
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

test('public namespace merges visible canvases once, preserves archives/provenance, and shares detail and restore', async t => {
  const {store,shared,query,database} = fixture(t);
  const a = await store.addStroke(A,stroke('desktop'));
  const b = await store.addStroke(B,stroke('mobile'));
  await store.addStroke(A,stroke('hidden'));
  await store.removeStroke(A,'hidden');
  await store.importArchivedStrokes([stroke('archive-only')],{source:'historical'});
  const transform={translation:{x:0.3,y:0.1},scale:1.7,rotation:0.5};
  await store.updateStrokeTransform(A,a.id,transform);
  const before = await query('SELECT * FROM noema_artworks ORDER BY id');
  const legacyCanvas = await query('SELECT * FROM noema_canvas ORDER BY owner_id,artwork_id');
  const visible = await store.listStrokes(shared);
  assert.deepEqual(new Set(visible.map(s=>s.id)),new Set([published.strokes[0].id,a.id,b.id]));
  assert.deepEqual(visible.find(s=>s.id===a.id).transform,transform);
  assert.equal(digest(await query('SELECT * FROM noema_artworks ORDER BY id')),digest(before));
  assert.deepEqual(await query('SELECT * FROM noema_canvas WHERE owner_id<>$1 ORDER BY owner_id,artwork_id',[shared]),legacyCanvas);
  assert.equal((await store.listArchivedStrokes(shared)).total,5);
  assert.equal((await store.getStroke(shared,'hidden')).id,'hidden');
  assert.equal(await store.getStroke(B,a.id),undefined,'legacy namespace isolation is retained internally');
  assert.equal((await store.restoreStroke(shared,'hidden')).id,'hidden');
  await store.removeStroke(shared,a.id);
  await database.closeDatabases();
  assert.ok(!(await store.listStrokes(shared)).some(s=>s.id===a.id),'migration cannot restore a hidden work on restart');
  await store.clearStrokes(shared);
  await database.closeDatabases();
  assert.deepEqual(await store.listStrokes(shared),[],'clear cannot reseed from legacy visible memberships');
  assert.equal((await store.listArchivedStrokes(shared)).total,5);
  assert.equal(digest(await query('SELECT * FROM noema_artworks ORDER BY id')),digest(before));
});

test('brand new public database gets one example, while a deliberately empty legacy canvas remains empty', async t => {
  const {store,shared} = fixture(t);
  assert.deepEqual(await store.listStrokes(shared),published.strokes);
  await store.clearStrokes(shared);
  assert.deepEqual(await store.listStrokes(shared),[]);
});

test('concurrent public initialization deduplicates memberships and keeps the latest visible placement', async t => {
  const {store,shared,query} = fixture(t);
  await store.listStrokes(A); await store.listStrokes(B);
  const id=published.strokes[0].id;
  const first={translation:{x:0.1,y:0.2},rotation:0.2,scale:1.1};
  const latest={translation:{x:0.4,y:0.5},rotation:0.8,scale:1.9};
  await store.updateStrokeTransform(A,id,first); await store.updateStrokeTransform(B,id,latest);
  await query('UPDATE noema_canvas SET added_at=100 WHERE owner_id=$1',[A]);
  await query('UPDATE noema_canvas SET added_at=200 WHERE owner_id=$1',[B]);
  const second=createTypeScriptLoader()('lib/store.ts');
  const results=await Promise.all(Array.from({length:8},(_,index)=>(index%2 ? store : second).listStrokes(shared)));
  assert.ok(results.every(strokes=>strokes.length===1));
  assert.ok(results.every(strokes=>JSON.stringify(strokes[0].transform)===JSON.stringify(latest)));
  assert.equal((await query('SELECT * FROM noema_canvas WHERE owner_id=$1',[shared])).length,1);
});

test('migration respects prior clear and unions agent pools and material counters without re-adding removed agents', async t => {
  const {store,shared,query} = fixture(t);
  await store.clearStrokes(A); await store.clearStrokes(B);
  await store.clearAgents(A); await store.clearAgents(B);
  await store.ensureCatalogAgents(A,['agent-001']); await store.ensureCatalogAgents(B,['agent-002']);
  await query('UPDATE noema_visitors SET brush_sequence=7 WHERE owner_id=$1',[A]);
  await query('UPDATE noema_visitors SET brush_sequence=4 WHERE owner_id=$1',[B]);
  assert.deepEqual(await store.listStrokes(shared),[]);
  assert.deepEqual(new Set((await store.listAgents(shared)).map(a=>a.id)),new Set(['agent-001','agent-002']));
  assert.equal((await query('SELECT brush_sequence FROM noema_visitors WHERE owner_id=$1',[shared]))[0].brush_sequence,11);
  assert.equal(await store.canvasRevision(shared),1);
});

test('copied Sky histories survive request ID collisions, retain retry links and never revive a cleared job', async t => {
  const {store,sky,batch,shared,query} = fixture(t);
  await store.clearStrokes(A); await store.clearStrokes(B);
  const first=await sky.claimSkyBatch(A,job(batch,'same-request'));
  first.job.entries[0].stroke={...stroke('sky-a'),agent_id:first.job.entries[0].agent.id}; first.job.entries[0].status='succeeded';
  batch.touchSkyBatch(first.job); await sky.saveSkyBatch(A,first.job,first.leaseId);
  await sky.abandonSkyBatch(A,first.job.requestId,first.leaseId);
  const partial=await sky.readSkyBatch(A,first.job.requestId);
  const retry=await sky.claimSkyBatch(A,batch.retrySkyBatch(partial,'retry','retry-request'),{retryOf:first.job.requestId});
  await sky.abandonSkyBatch(A,retry.job.requestId,retry.leaseId);
  const other=await sky.claimSkyBatch(B,job(batch,'same-request'));
  await sky.abandonSkyBatch(B,other.job.requestId,other.leaseId);
  await store.clearStrokes(B);
  const original=await query('SELECT * FROM noema_sky_jobs ORDER BY owner_id,request_id');
  const snapshot=await sky.readSkySnapshot(shared);
  assert.equal(snapshot.job.id,'retry');
  assert.equal(snapshot.canvasRevision,await store.canvasRevision(shared));
  const copied=await query('SELECT * FROM noema_sky_jobs WHERE owner_id=$1 ORDER BY request_id',[shared]);
  assert.equal(copied.length,3);
  assert.equal(new Set(copied.map(row=>row.request_id)).size,3);
  assert.deepEqual(await query('SELECT * FROM noema_sky_jobs WHERE owner_id<>$1 ORDER BY owner_id,request_id',[shared]),original);
  const firstCopy=copied.map(row=>JSON.parse(row.payload)).find(j=>j.entries.some(e=>e.stroke?.id==='sky-a') && j.id==='same-request');
  assert.ok(firstCopy.retryRequestId);
  assert.equal((await sky.readSkyBatch(shared,firstCopy.requestId)).id,'retry');
  assert.equal(copied.filter(row=>row.status==='cleared').length,1);
  await store.clearStrokes(shared);
  assert.equal(await sky.readSkyBatch(shared),null);
  assert.ok((await query('SELECT status FROM noema_sky_jobs WHERE owner_id=$1',[shared])).every(row=>row.status==='cleared'));
});

test('migration fails atomically during a healthy legacy lease, then preserves finished and expired progress', async t => {
  const {store,sky,batch,shared,query} = fixture(t);
  const active=await sky.claimSkyBatch(A,job(batch,'active-legacy'));
  await assert.rejects(store.listStrokes(shared),error=>error.code==='shared_canvas_migration_pending');
  assert.equal((await query('SELECT owner_id FROM noema_visitors WHERE owner_id=$1',[shared])).length,0);
  assert.equal((await query('SELECT owner_id FROM noema_canvas WHERE owner_id=$1',[shared])).length,0);
  active.job.entries[0].stroke={...stroke('paid-success'),agent_id:active.job.entries[0].agent.id}; active.job.entries[0].status='succeeded';
  batch.touchSkyBatch(active.job); await sky.saveSkyBatch(A,active.job,active.leaseId);
  await query('UPDATE noema_sky_jobs SET lease_until=0 WHERE owner_id=$1',[A]);
  const recovered=await sky.readSkyBatch(shared);
  assert.equal(recovered.status,'partial');
  assert.equal(recovered.entries[1].errorCode,'interrupted');
  assert.equal(recovered.entries[0].stroke.id,'paid-success');
  assert.ok((await store.listStrokes(shared)).some(s=>s.id==='paid-success'));
  assert.equal((await query('SELECT status FROM noema_sky_jobs WHERE owner_id=$1',[A]))[0].status,'running','original lease/job history remains unchanged');
});
