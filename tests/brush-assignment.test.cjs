const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTypeScriptLoader } = require('./load-typescript.cjs');
const load = createTypeScriptLoader();
const { brushTreatmentForIndex, assignBrushTreatment, assignBrushTreatments } = load('engine/brushAssignment.ts');
const { resolveVisualSignature } = load('engine/visualSignature.ts');
const { createSkyBatch, retrySkyBatch, runSkyBatch } = load('lib/skyBatch.ts');
const snapshot = require('../data/published-canvas.json');
const owner = 'a'.repeat(64);
function durableStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noema-material-'));
  process.env.NOEMA_SQLITE_PATH = path.join(directory, 'test.sqlite');
  delete process.env.DATABASE_URL; delete process.env.RENDER;
  const isolated = createTypeScriptLoader();
  t.after(async () => { await isolated('lib/database.ts').closeDatabases(); fs.rmSync(directory, {recursive:true,force:true}); });
  return isolated('lib/store.ts');
}

function makeStroke(index, agentId = 'agent-000') {
  return { ...structuredClone(snapshot.strokes[0]), id: `brush-${index}`, created_at: index, timestamp: index, agent_id: agentId, brush_treatment: undefined };
}

function withoutMaterial(path) {
  const copy = structuredClone(path);
  delete copy.brush_treatment;
  if (copy.visual_signature) delete copy.visual_signature.brush_style;
  return copy;
}

test('balanced allocation always gives two of five and four of ten consecutive slots', () => {
  for (const seed of [0, 1, 2, 4, 32, 981, 4294967295]) {
    for (let start = 0; start < 30; start++) {
      const treatments = Array.from({ length: 10 }, (_, i) => brushTreatmentForIndex(start + i, seed));
      assert.equal(treatments.filter(v => v === 'calligraphy').length, 4);
      assert.equal(treatments.slice(0, 5).filter(v => v === 'calligraphy').length, 2);
      assert.deepEqual(treatments, Array.from({ length: 10 }, (_, i) => brushTreatmentForIndex(start + i, seed)));
    }
  }
  assert.notDeepEqual(Array.from({ length: 10 }, (_, i) => brushTreatmentForIndex(i, 0)), Array.from({ length: 10 }, (_, i) => brushTreatmentForIndex(i, 1)));
});

test('one-time migration preserves input order, paths, colors, lengths, transforms and all non-material data', () => {
  const strokes = Array.from({ length: 11 }, (_, i) => makeStroke(i)).reverse();
  const before = strokes.map(withoutMaterial);
  const ids = strokes.map(s => s.id);
  assert.equal(assignBrushTreatments(strokes), strokes);
  assert.equal(strokes.filter(s => s.brush_treatment === 'calligraphy').length, 4);
  assert.deepEqual(strokes.map(s => s.id), ids);
  assert.deepEqual(strokes.map(withoutMaterial), before);
  const previous = structuredClone(strokes);
  assignBrushTreatments(strokes);
  assert.deepEqual(strokes, previous);
});

test('material is persisted on the work and resolving it changes only brush_style', () => {
  const work = makeStroke(1);
  const before = resolveVisualSignature(work);
  const beforeData = withoutMaterial(work);
  assignBrushTreatment(work, 'calligraphy');
  const after = resolveVisualSignature(work);
  assert.equal(after.brush_style, 'calligraphy');
  assert.equal(work.visual_signature.brush_style, 'calligraphy');
  assert.deepEqual({ ...after, brush_style: before.brush_style }, before);
  assert.deepEqual(withoutMaterial(work), beforeData);
  const isolated = JSON.parse(JSON.stringify(work));
  assert.deepEqual(resolveVisualSignature(isolated), after);
  assignBrushTreatment(work, 'original');
  assert.deepEqual(resolveVisualSignature(work), before);
});

test('untagged historic materials keep their intensity-driven original four instruments', () => {
  for (const [intensity, style] of [[0.64, 'hard'], [0.73, 'soft'], [0.79, 'watercolor'], [0.9, 'texture']]) {
    const work = makeStroke(2);
    work.points.forEach(point => { point.intensity = intensity; });
    assert.equal(resolveVisualSignature(work).brush_style, style);
    assignBrushTreatment(work, 'original');
    assert.equal(resolveVisualSignature(work).brush_style, style);
    assignBrushTreatment(work, 'calligraphy');
    assert.equal(resolveVisualSignature(work).brush_style, 'calligraphy');
  }
});

test('every complete Sky has exactly four brush strokes and failed slots preserve their allocation on retry', async () => {
  const authors = Array.from({ length: 10 }, (_, i) => ({ id: `agent-${i}`, name: `Agent ${i}` }));
  const batch = createSkyBatch('brush-batch', 'first-material-request', authors);
  const allocation = batch.entries.map(entry => entry.brushTreatment);
  assert.equal(allocation.filter(v => v === 'calligraphy').length, 4);
  const failedIndex = allocation.indexOf('calligraphy');
  await runSkyBatch(batch, {
    generate: async (agent, index) => {
      if (index === failedIndex) throw new Error('network');
      return makeStroke(index, agent.id);
    },
    persist: stroke => assert.ok(stroke.brush_treatment),
  });
  assert.equal(batch.status, 'partial');
  const succeeded = batch.entries.filter(e => e.stroke).map(e => e.stroke);
  const retry = retrySkyBatch(batch, 'brush-retry', 'different-request-id');
  assert.deepEqual(retry.entries.map(e => e.brushTreatment), allocation);
  let calls = 0;
  await runSkyBatch(retry, {
    generate: async (agent, index) => { calls++; return makeStroke(index, agent.id); },
    persist: () => {},
  });
  assert.equal(calls, 1);
  assert.equal(retry.status, 'complete');
  assert.equal(retry.entries.filter(e => e.stroke.brush_treatment === 'calligraphy').length, 4);
  assert.ok(succeeded.every(stroke => retry.entries.some(entry => entry.stroke === stroke)));
  assert.deepEqual(retry.entries.map(e => e.stroke.brush_treatment), allocation);
});

test('ordinary saves allocate once; duplicate requests and removals do not reroll works', async t => {
  const store = durableStore(t);
  await store.clearStrokes(owner);
  const first = await Promise.all(Array.from({ length: 10 }, (_, i) => store.addStroke(owner,makeStroke(i))));
  assert.equal(first.filter(s => s.brush_treatment === 'calligraphy').length, 4);
  const existing = first[2];
  assert.deepEqual(await store.addStroke(owner,makeStroke(2)), existing);
  assert.equal((await store.listStrokes(owner)).length, 10);
  await store.removeStroke(owner,first[0].id);
  assert.equal((await store.getStroke(owner,existing.id)).brush_treatment, existing.brush_treatment);
  const second = await Promise.all(Array.from({ length: 10 }, (_, i) => store.addStroke(owner,makeStroke(i + 10))));
  assert.equal(second.filter(s => s.brush_treatment === 'calligraphy').length, 4);
  assert.deepEqual(second.map(s => s.brush_treatment), first.map(s => s.brush_treatment));
  await store.clearStrokes(owner);
  assert.equal((await store.addStroke(owner,makeStroke(100))).brush_treatment, brushTreatmentForIndex(20));
});

test('concurrent Sky saves do not consume ordinary allocation slots and no stroke is evicted after 500', async t => {
  const store = durableStore(t);
  await store.clearStrokes(owner);
  const ordinary = [];
  for (let i = 0; i < 510; i++) {
    if (i % 3 === 0) await store.addStroke(owner,assignBrushTreatment(makeStroke(1000 + i), 'calligraphy'));
    ordinary.push((await store.addStroke(owner,makeStroke(i))).brush_treatment);
  }
  assert.equal((await store.listStrokes(owner)).length, 680);
  for (let i = 0; i < ordinary.length; i++) assert.equal(ordinary[i], brushTreatmentForIndex(i));
});
