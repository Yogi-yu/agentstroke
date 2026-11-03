const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const snapshot = require('../data/published-canvas.json');
const archive = require('../data/archive/published-canvas-2026-10-15.json');
const { createTypeScriptLoader } = require('./load-typescript.cjs');

const owner = 'a'.repeat(64);
function coldStart(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noema-published-'));
  process.env.NOEMA_SQLITE_PATH = path.join(directory, 'test.sqlite');
  delete process.env.DATABASE_URL; delete process.env.RENDER;
  const load = createTypeScriptLoader();
  t.after(async () => { await load('lib/database.ts').closeDatabases(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { load, store: load('lib/store.ts'), sky: load('lib/skyBatchStore.ts') };
}

test('the ten original artworks and their completed sky remain byte-exact in the archive', () => {
  const bytes = fs.readFileSync(require.resolve('../data/archive/published-canvas-2026-10-15.json'));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), 'd985e10a0886bf263b8ddee8d791e4c44935bc8d07f21f7cc783ea4520066f7d');
  assert.equal(archive.strokes.length, 10);
  assert.equal(archive.skyBatch.entries.length, 10);
  assert.equal(archive.agents.length, 23);
});

test('the default canvas contains exactly one real-model wu to you example and no historic sky', () => {
  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.trailRetention, 0.2);
  assert.deepEqual(snapshot.agents, archive.agents);
  assert.equal(snapshot.strokes.length, 1);
  const stroke = snapshot.strokes[0];
  assert.equal(stroke.generation_mode, 'example');
  assert.equal(stroke.anchor_format, 'single_word');
  assert.ok(stroke.points.every(point => /^[A-Za-z]{1,48}$/.test(point.anchor)));
  assert.equal(stroke.from, 'wu');
  assert.equal(stroke.to, 'you');
  assert.equal(stroke.points[0].anchor, 'wu');
  assert.equal(stroke.points.at(-1).anchor, 'you');
  assert.equal(stroke.semantic_depth, stroke.points.length);
  assert.ok(stroke.points.length >= 2 && stroke.points.length <= 64);
  assert.equal(stroke.model, snapshot.agents.find(a => a.id === stroke.agent_id).model);
  assert.equal(snapshot.skyBatch, null);
  const inspect = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.doesNotMatch(key, /api.?key|secret|authorization|password|access.?token|chat.?history/i);
      inspect(child);
    }
  };
  inspect(snapshot);
});

test('published factories deep-clone example and agents without modifying the archive', () => {
  const { createPublishedCanvas } = createTypeScriptLoader()('lib/publishedCanvas.ts');
  const first = createPublishedCanvas();
  first.agents[0].name = 'Changed';
  first.strokes[0].points[0].anchor = 'changed';
  first.strokes[0].visual_signature.color_hues[0] = -1;
  assert.deepEqual(createPublishedCanvas(), snapshot);
});

test('cold startup loads the single example, with no running or completed Sky batch', async t => {
  const { store, sky } = coldStart(t);
  assert.equal(await sky.readSkyBatch(owner), null);
  assert.equal(await sky.canvasRevision(owner), 0);
  assert.deepEqual(await store.listAgents(owner), snapshot.agents);
  assert.deepEqual(await store.listStrokes(owner), snapshot.strokes);
});

test('canonical data is immutable and clearing never silently restores the example after restart', async t => {
  const { store, sky, load: initialLoad } = coldStart(t);
  const first = (await store.listStrokes(owner))[0];
  first.points[1].anchor = 'runtime edit';
  assert.notEqual((await store.listStrokes(owner))[0].points[1].anchor, 'runtime edit');
  assert.equal(await store.clearStrokes(owner), 1);
  assert.equal(await sky.canvasRevision(owner), 1);
  await initialLoad('lib/database.ts').closeDatabases();
  const load = createTypeScriptLoader();
  t.after(() => load('lib/database.ts').closeDatabases());
  assert.deepEqual(await load('lib/store.ts').listStrokes(owner), []);
  assert.equal((await load('lib/store.ts').listAgents(owner)).length, 23);
  assert.equal(await load('lib/skyBatchStore.ts').readSkyBatch(owner), null);
  assert.deepEqual(load('lib/publishedCanvas.ts').createPublishedCanvas(), snapshot);
});
