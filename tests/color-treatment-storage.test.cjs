const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTypeScriptLoader } = require('./load-typescript.cjs');
const snapshot = require('../data/published-canvas.json');

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noema-color-test-'));
  const keys=['NOEMA_SQLITE_PATH','DATABASE_URL','RENDER','NODE_ENV'];
  const old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  process.env.NOEMA_SQLITE_PATH=path.join(dir,'test.sqlite');
  process.env.DATABASE_URL=''; process.env.RENDER=''; process.env.NODE_ENV='test';
  const load=createTypeScriptLoader(),db=load('lib/database.ts');
  t.after(async()=>{await db.closeDatabases();for(const key of keys)if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];fs.rmSync(dir,{recursive:true,force:true});});
  return {load,db,store:load('lib/store.ts'),sky:load('lib/skyBatchStore.ts'),batch:load('lib/skyBatch.ts'),owner:load('lib/sharedCanvas.ts').SHARED_CANVAS_OWNER,
    query:async(sql,params=[])=>(await db.databaseTransaction(client=>client.query(sql,params))).rows};
}
const makeStroke=(i)=>({...structuredClone(snapshot.strokes[0]),id:`color-work-${i}`,created_at:i,timestamp:i,brush_treatment:'original',color_treatment:undefined});
const withoutColor=stroke=>{const copy=structuredClone(stroke);delete copy.color_treatment;return copy;};

test('one-time legacy overlay balances visible and archived works without changing source bytes or transforms',async t=>{
  const {db,store,owner,query}=fixture(t);
  const works=Array.from({length:12},(_,i)=>makeStroke(i));
  const transform={translation:{x:0.21,y:0.17},rotation:0.25,scale:1.8};
  const oldJob={id:'old-sky',requestId:'old-sky',createdAt:1,from:'',to:'',status:'complete',entries:works.slice(0,10).map(stroke=>({agent:snapshot.agents[0],status:'succeeded',stroke}))};
  await db.databaseTransaction(async client=>{
    await client.query('INSERT INTO noema_visitors(owner_id,agents_json,revision,brush_sequence,latest_sky_request,created_at,updated_at) VALUES($1,$2,0,0,$3,1,1)',[owner,JSON.stringify({pool:snapshot.agents,lastOut:{}}),'old-sky']);
    for(const [index,work]of works.entries()){
      await client.query('INSERT INTO noema_artworks(id,owner_id,payload,created_at,source) VALUES($1,$2,$3,$4,$5)',[work.id,owner,JSON.stringify(work),work.created_at,'legacy']);
      if(index%2===1)await client.query('INSERT INTO noema_canvas(owner_id,artwork_id,hidden,transform_json,added_at) VALUES($1,$2,0,$3,$4)',[owner,work.id,JSON.stringify(transform),index]);
    }
    await client.query('INSERT INTO noema_sky_jobs(owner_id,request_id,payload,status,revision,created_at,updated_at) VALUES($1,$2,$3,$4,0,1,1)',[owner,'old-sky',JSON.stringify(oldJob),'complete']);
    // Test-only rollback of the empty fixture marker simulates a pre-upgrade DB.
    await client.query('DELETE FROM noema_color_state');
  });
  const visible=await store.listStrokes(owner);
  assert.equal(visible.length,6);
  assert.equal(visible.filter(stroke=>stroke.color_treatment==='muted').length,3);
  const all=(await store.listArchivedStrokes(owner)).strokes;
  assert.equal(all.filter(stroke=>stroke.color_treatment==='muted').length,6);
  const tones=new Map(all.map(stroke=>[stroke.id,stroke.color_treatment]));
  for(const work of all){
    const original=works.find(stroke=>stroke.id===work.id);
    const unchanged=withoutColor(work);delete unchanged.transform;
    assert.deepEqual(unchanged,withoutColor(original));
  }
  assert.ok(visible.every(stroke=>JSON.stringify(stroke.transform)===JSON.stringify(transform)));
  const sky=await fixtureSkyRead(db,owner);
  for(const entry of sky.entries)assert.equal(entry.stroke.color_treatment,tones.get(entry.stroke.id));
  const raw=await query('SELECT id,payload FROM noema_artworks ORDER BY created_at');
  assert.deepEqual(raw.map(row=>row.payload),works.map(work=>JSON.stringify(work)));
  assert.equal((await query('SELECT payload FROM noema_sky_jobs WHERE request_id=$1',['old-sky']))[0].payload,JSON.stringify(oldJob));
  await store.removeStroke(owner,visible[0].id);
  await store.clearStrokes(owner);
  await db.closeDatabases();
  assert.deepEqual(await store.listStrokes(owner),[]);
  const restored=await store.restoreStroke(owner,visible[0].id);
  assert.equal(restored.color_treatment,tones.get(restored.id));
  const after=(await store.listArchivedStrokes(owner)).strokes;
  assert.deepEqual(new Map(after.map(stroke=>[stroke.id,stroke.color_treatment])),tones);
});

async function fixtureSkyRead(db,owner){
  return createTypeScriptLoader()('lib/skyBatchStore.ts').readSkyBatch(owner,'old-sky');
}

test('ordinary saves allocate once, remain balanced across clears, and keep every non-color attribute',async t=>{
  const {store,owner,query,db}=fixture(t);
  await store.clearStrokes(owner);
  const sources=Array.from({length:10},(_,i)=>makeStroke(100+i));
  const saved=await Promise.all(sources.map(stroke=>store.addStroke(owner,stroke)));
  assert.equal(saved.filter(stroke=>stroke.color_treatment==='muted').length,5);
  saved.forEach((stroke,i)=>assert.deepEqual(withoutColor(stroke),withoutColor(sources[i])));
  assert.deepEqual(await store.addStroke(owner,{...sources[0],color_treatment:saved[0].color_treatment==='muted'?'bright':'muted'}),saved[0]);
  const before=(await query('SELECT next_sequence FROM noema_color_state'))[0].next_sequence;
  await store.clearStrokes(owner);await db.closeDatabases();
  const second=await Promise.all(Array.from({length:10},(_,i)=>store.addStroke(owner,makeStroke(200+i))));
  assert.deepEqual(second.map(stroke=>stroke.color_treatment),saved.map(stroke=>stroke.color_treatment));
  assert.equal((await query('SELECT next_sequence FROM noema_color_state'))[0].next_sequence,Number(before)+10);
  assert.equal((await store.getStroke(owner,saved[0].id)).color_treatment,saved[0].color_treatment);
});

test('the first partial Sky read still balances the entire 51-work shared canvas and the 92-work archive',async t=>{
  const {db,store,owner,sky,query}=fixture(t);
  const works=Array.from({length:92},(_,i)=>makeStroke(10000+i));
  const visibleIds=new Set(works.slice(17,68).map(work=>work.id));
  const oldJob={id:'partial-view',requestId:'partial-view',createdAt:1,from:'',to:'',status:'complete',entries:works.slice(17,37).map(stroke=>({agent:snapshot.agents[0],status:'succeeded',stroke}))};
  await db.databaseTransaction(async client=>{
    await client.query('INSERT INTO noema_visitors(owner_id,agents_json,revision,brush_sequence,latest_sky_request,created_at,updated_at) VALUES($1,$2,0,0,$3,1,1)',[owner,JSON.stringify({pool:snapshot.agents,lastOut:{}}),'partial-view']);
    for(const work of works){
      await client.query('INSERT INTO noema_artworks(id,owner_id,payload,created_at,source) VALUES($1,$2,$3,$4,$5)',[work.id,owner,JSON.stringify(work),work.created_at,'legacy']);
      if(visibleIds.has(work.id))await client.query('INSERT INTO noema_canvas(owner_id,artwork_id,hidden,added_at) VALUES($1,$2,0,1)',[owner,work.id]);
    }
    await client.query('INSERT INTO noema_sky_jobs(owner_id,request_id,payload,status,revision,created_at,updated_at) VALUES($1,$2,$3,$4,0,1,1)',[owner,oldJob.requestId,JSON.stringify(oldJob),'complete']);
    await client.query('DELETE FROM noema_color_state');
  });
  const first=await sky.readSkyBatch(owner);
  const visible=await store.listStrokes(owner);
  assert.equal(visible.length,51);
  assert.equal(visible.filter(work=>work.color_treatment==='muted').length,26);
  const colors=await query('SELECT treatment FROM noema_artwork_colors');
  assert.equal(colors.length,92);assert.equal(colors.filter(row=>row.treatment==='muted').length,46);
  for(const entry of first.entries)assert.equal(entry.stroke.color_treatment,visible.find(work=>work.id===entry.stroke.id).color_treatment);
  assert.deepEqual((await query('SELECT payload FROM noema_artworks ORDER BY created_at')).map(row=>row.payload),works.map(work=>JSON.stringify(work)));
});

test('legacy owner union is balanced before shared namespace migration, without reassigning any id afterward',async t=>{
  const {db,store,owner,query}=fixture(t);
  const legacyOwners=['a'.repeat(64),'b'.repeat(64)];
  const works=Array.from({length:16},(_,i)=>makeStroke(20000+i));
  await db.databaseTransaction(async client=>{
    for(const oldOwner of legacyOwners)await client.query('INSERT INTO noema_visitors(owner_id,agents_json,revision,brush_sequence,created_at,updated_at) VALUES($1,$2,0,0,1,1)',[oldOwner,JSON.stringify({pool:snapshot.agents,lastOut:{}})]);
    for(const [index,work]of works.entries()){
      const oldOwner=legacyOwners[index%2];
      await client.query('INSERT INTO noema_artworks(id,owner_id,payload,created_at,source) VALUES($1,$2,$3,$4,$5)',[work.id,oldOwner,JSON.stringify(work),work.created_at,'legacy']);
      if(index>=5)await client.query('INSERT INTO noema_canvas(owner_id,artwork_id,hidden,added_at) VALUES($1,$2,0,1)',[oldOwner,work.id]);
    }
    await client.query('DELETE FROM noema_color_state');
  });
  const before=await query('SELECT artwork_id,treatment FROM noema_artwork_colors ORDER BY artwork_id');
  const visible=await store.listStrokes(owner);
  assert.equal(visible.length,11);
  assert.equal(visible.filter(work=>work.color_treatment==='muted').length,6);
  assert.deepEqual(await query('SELECT artwork_id,treatment FROM noema_artwork_colors ORDER BY artwork_id'),before);
});

test('first import and a caller-held save preserve reserved colors without consuming ordinary allocation',async t=>{
  const {db,store,owner,query}=fixture(t);
  const imported={...makeStroke(30000),color_treatment:'bright'};
  await store.importArchivedStrokes([imported],{source:'first-import'});
  assert.equal(Number((await query('SELECT next_sequence FROM noema_color_state'))[0].next_sequence),0,'reserved first import consumes no ordinary slot');
  assert.equal((await store.getStroke(owner,imported.id)).color_treatment,'bright');
  const visitor=await db.databaseTransaction(client=>store.ensureVisitor(client,owner));
  const saved=await db.databaseTransaction(async client=>{
    // Test-only state reset exercises the direct archive guard independently
    // of databaseTransaction's normal pre-action initializer.
    await client.query('DELETE FROM noema_artwork_colors');
    await client.query('DELETE FROM noema_color_state');
    return store.saveStrokeInTransaction(client,owner,{...makeStroke(30001),color_treatment:'bright'},{visitor});
  });
  assert.equal(saved.color_treatment,'bright');
  assert.equal((await store.getStroke(owner,saved.id)).color_treatment,'bright');
  assert.equal((await query('SELECT payload FROM noema_artworks WHERE id=$1',[imported.id]))[0].payload,JSON.stringify(imported));
  assert.equal(Number((await query('SELECT next_sequence FROM noema_color_state'))[0].next_sequence),2,'only the two historical works contribute to the initial sequence');
});

test('Sky reserves half muted for 10 and 20 slots, persists through failure/retry, and shares colors across all views',async t=>{
  const {store,owner,batch,sky,query}=fixture(t);
  await store.clearStrokes(owner);
  for(const [mode,count]of [['standard',10],['sphere',20]]){
    const proposed=batch.createSkyBatch(`sky-${count}`,`palette-${count}`,Array.from({length:count},()=>snapshot.agents[0]),'','',mode);
    assert.equal(proposed.entries.filter(entry=>entry.colorTreatment==='muted').length,count/2);
    const reservation=proposed.entries.map(entry=>entry.colorTreatment);
    const claim=await sky.claimSkyBatch(owner,proposed);
    const failedIndex=2;
    const beforeSequence=Number((await query('SELECT next_sequence FROM noema_color_state'))[0].next_sequence);
    await batch.runSkyBatch(claim.job,{
      generate:async(agent,index)=>{if(index===failedIndex)throw new Error('network');return {...makeStroke(1000+count*100+index),agent_id:agent.id};},
      persist:async stroke=>store.addStroke(owner,stroke)
    },async()=>{await sky.saveSkyBatch(owner,claim.job,claim.leaseId);});
    const partial=await sky.readSkyBatch(owner,proposed.requestId);
    assert.equal(partial.status,'partial');
    const retry=batch.retrySkyBatch(partial,`${proposed.id}-retry`,`${proposed.requestId}-retry`);
    assert.deepEqual(retry.entries.map(entry=>entry.colorTreatment),reservation);
    const retried=await sky.claimSkyBatch(owner,retry,{retryOf:partial.requestId});
    await batch.runSkyBatch(retried.job,{generate:async(agent,index)=>({...makeStroke(1000+count*100+index),agent_id:agent.id}),persist:async stroke=>store.addStroke(owner,stroke)},async()=>{await sky.saveSkyBatch(owner,retried.job,retried.leaseId);});
    const complete=await sky.readSkyBatch(owner,proposed.requestId);
    assert.equal(complete.status,'complete');
    assert.equal(complete.entries.filter(entry=>entry.stroke.color_treatment==='muted').length,count/2);
    assert.deepEqual(complete.entries.map(entry=>entry.stroke.color_treatment),reservation);
    for(const entry of complete.entries)assert.equal((await store.getStroke(owner,entry.stroke.id)).color_treatment,entry.colorTreatment);
    assert.equal(Number((await query('SELECT next_sequence FROM noema_color_state'))[0].next_sequence),beforeSequence,'reserved Sky slots do not consume ordinary sequence');
  }
});
