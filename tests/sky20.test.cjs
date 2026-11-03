const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const { apiFixture } = require("./durable-api-fixture.cjs");
const load = createTypeScriptLoader();
const { SKY_BATCH_SIZE, SKY_SPHERE_BATCH_SIZE, skyBatchSize, skyTargetCount, selectSkyAgents, createSkyBatch, retrySkyBatch, runSkyBatch } = load("lib/skyBatch.ts");
const { skyPresentation, skyDisplayLayout } = load("lib/skyPresentation.ts");
const catalog = Array.from({ length: 23 }, (_, index) => ({ id: `agent-${index}`, name: `Agent ${index}` }));
const make = (id = "sphere-job") => createSkyBatch(id, `${id}-request-001`, selectSkyAgents(catalog.slice(0, 3), () => 0.42, 20), "", "", "sphere");

test("sphere reserves twenty existing-author slots while ordinary Sky stays ten", () => {
  assert.equal(SKY_BATCH_SIZE, 10); assert.equal(SKY_SPHERE_BATCH_SIZE, 20);
  assert.equal(skyBatchSize(), 10); assert.equal(skyBatchSize("standard"), 10); assert.equal(skyBatchSize("sphere"), 20);
  for (const count of [10, 20]) {
    for (const pool of [catalog.slice(0, 1), catalog.slice(0, 3), catalog]) {
      const before = JSON.stringify(pool);
      const selected = selectSkyAgents(pool, () => 0.42, count);
      assert.equal(selected.length, count);
      assert.ok(selected.every(agent => pool.includes(agent)));
      if (pool.length > 1) assert.ok(selected.every((agent, index) => !index || selected[index - 1].id !== agent.id));
      assert.equal(JSON.stringify(pool), before);
    }
  }
  for (const count of [0, 1, 19, 21, 500, NaN, Infinity]) assert.throws(() => selectSkyAgents(catalog, Math.random, count), /ten or twenty/);
  const batch = make();
  assert.equal(batch.skyMode, "sphere"); assert.equal(batch.targetCount, 20); assert.equal(batch.entries.length, 20);
  assert.equal(batch.entries.filter(entry => entry.brushTreatment === "calligraphy").length, 8);
  assert.throws(() => createSkyBatch("j", "r", catalog.slice(0, 10), "", "", "sphere"), /twenty stroke slots/);
  assert.throws(() => createSkyBatch("j", "r", catalog.slice(0, 20)), /ten stroke slots/);
  assert.throws(() => createSkyBatch("j", "r", catalog.slice(0, 20), "", "", "unbounded"), /valid sky mode/);
});

test("twenty-slot progress starts at zero and reveals each persisted result before the next call", async () => {
  const pending = skyPresentation(null, true, 0, "sphere");
  assert.equal(pending.headline, "Generating… 0/20"); assert.equal(pending.targetCount, 20); assert.equal(pending.showCanvas, false);
  const batch = make();
  const completions = [0], persisted = [], frames = [];
  let active = 0, peak = 0;
  await runSkyBatch(batch, {
    generate: async (agent, index) => {
      assert.equal(persisted.length, index);
      if (index) assert.ok(frames.some(frame => frame.completed === index && frame.paths.length === index));
      active++; peak = Math.max(peak, active); await new Promise(setImmediate); active--;
      return { id: `sphere-${index}`, agent_id: agent.id, points: [{}, {}] };
    },
    persist: async stroke => { await new Promise(setImmediate); persisted.push(stroke); },
  }, () => {
    const frame = skyPresentation(structuredClone(batch), false);
    frames.push(frame); completions.push(frame.completed);
  });
  assert.equal(peak, 1); assert.equal(persisted.length, 20);
  assert.deepEqual([...new Set(completions)], Array.from({ length: 21 }, (_, i) => i));
  assert.ok(completions.every((value, index) => !index || value >= completions[index - 1]));
  assert.equal(frames.at(-1).headline, "Generation complete · 20/20");
  assert.equal(frames.at(-1).paths.length, 20);
  assert.equal(batch.status, "complete");
});

test("sphere retries retain twenty slots, eight calligraphy assignments and all successful work", async () => {
  const batch = make("partial-sphere");
  await runSkyBatch(batch, {
    generate: async (agent, index) => {
      if ([1, 18].includes(index)) throw new Error("timeout");
      return { id: `original-${index}`, agent_id: agent.id, points: [{}, {}] };
    }, persist: () => {},
  });
  const before = JSON.stringify(batch);
  const retried = retrySkyBatch(batch, "retry", "retry-sphere-request-01");
  const calls = [];
  await runSkyBatch(retried, {
    generate: async (agent, index) => { calls.push(index); return { id: `retry-${index}`, agent_id: agent.id, points: [{}, {}] }; },
    persist: () => {},
  });
  assert.deepEqual(calls, [1, 18]);
  assert.equal(retried.skyMode, "sphere"); assert.equal(retried.targetCount, 20); assert.equal(retried.entries.length, 20);
  assert.equal(retried.entries.filter(entry => entry.stroke.brush_treatment === "calligraphy").length, 8);
  for (let index = 0; index < 20; index++) if (![1, 18].includes(index)) assert.equal(retried.entries[index].stroke, batch.entries[index].stroke);
  assert.equal(JSON.stringify(batch), before);
  assert.equal(retried.canvasId, batch.id);
  assert.equal(skyPresentation(retried, false).headline, "Generation complete · 20/20");
});

test("historical size inference and fixed twenty-slot planar layouts do not shift during arrival", () => {
  assert.equal(skyTargetCount(null), 10);
  const job = make(); delete job.targetCount; delete job.skyMode;
  assert.equal(skyTargetCount(job), 20);
  assert.equal(skyPresentation(job, true).headline, "Generating… 0/20");
  for (const portrait of [false, true]) {
    const slots = Array.from({ length: 20 }, (_, index) => `stroke-${index}`);
    const full = skyDisplayLayout(slots, portrait, 20);
    assert.equal(full.size, 20);
    for (let count = 1; count <= 20; count++) {
      const partial = skyDisplayLayout(slots.map((id, index) => index < count ? id : ""), portrait, 20);
      for (const [id, box] of partial) assert.deepEqual(box, full.get(id));
    }
    assert.ok([...full.values()].every(box => box.centerX > 0 && box.centerX < 1 && box.centerY > 0 && box.centerY < 1));
  }
});

test("durable Sphere API validates bounded size, generates twenty once and retries only two failures", async t => {
  const f = await apiFixture(t);
  const route = f.load("app/api/skyBatch/route.ts");
  assert.ok(route.maxDuration >= 20 * f.load("lib/strokegen.ts").SEMANTIC_REQUEST_LIMITS.totalMs / 1000 + 60);
  let calls = 0;
  f.load("lib/strokegen.ts").generateStroke = async agent => {
    const index = calls++;
    await new Promise(setImmediate);
    if (index === 3 || index === 18) throw Object.assign(new Error("provider-private-content"), { code: "timeout" });
    return f.stroke(`api-sphere-${index}`, agent.id);
  };
  const post = (requestId, extra = {}) => route.POST(f.request("/api/skyBatch", "POST", { requestId, ...extra }));
  for (const extra of [{ skyMode: "random" }, { skyMode: null }, { count: 20 }, { targetCount: 2000 }, { batchSize: 20 }, { size: 100 }]) {
    const response = await post("invalid-sphere-size-01", extra);
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
  const first = await post("sphere-api-request-01", { skyMode: "sphere", mode: "autonomous" });
  assert.match(first.headers.get("content-type"), /ndjson/);
  const duplicate = await post("sphere-api-request-01", { skyMode: "standard" });
  assert.equal((await duplicate.json()).reused, true);
  const frames = (await first.text()).trim().split("\n").map(JSON.parse);
  const source = frames.at(-1).job;
  assert.equal(calls, 20); assert.equal(source.status, "partial");
  assert.equal(source.skyMode, "sphere"); assert.equal(source.targetCount, 20);
  assert.equal(source.entries.length, 20); assert.equal(source.entries.filter(entry => entry.status === "succeeded").length, 18);
  assert.equal((await f.store.listStrokes(f.owner("a"))).length, 19);
  const successful = source.entries.flatMap(entry => entry.stroke ? [entry.stroke.id] : []);
  // Changing the selected UI mode cannot shrink an existing retry batch.
  const retry = await post("sphere-api-retry-0001", { retryOf: source.requestId, skyMode: "standard" });
  const final = (await retry.text()).trim().split("\n").map(JSON.parse).at(-1).job;
  assert.equal(calls, 22); assert.equal(final.status, "complete");
  assert.equal(final.targetCount, 20); assert.equal(final.skyMode, "sphere");
  assert.ok(successful.every(id => final.entries.some(entry => entry.stroke?.id === id)));
  assert.equal(final.entries.filter(entry => entry.stroke?.brush_treatment === "calligraphy").length, 8);
  assert.equal((await f.store.listStrokes(f.owner("a"))).length, 21);
  assert.equal((await f.store.listAgents(f.owner("a"))).length, 23, "No synthetic agents were added");
  const other = await (await route.GET(f.request("/api/skyBatch?requestId=sphere-api-request-01", "GET", undefined, "b"))).json();
  assert.equal(other.job, null);
  const replay = await post("sphere-api-retry-0001", { skyMode: "sphere" });
  assert.equal((await replay.json()).reused, true); assert.equal(calls, 22);
  assert.ok(!JSON.stringify(frames).includes("provider-private-content"));
  await f.load("lib/database.ts").closeDatabases();
  const restarted = createTypeScriptLoader();
  restarted("lib/strokegen.ts").generateStroke = async () => { throw new Error("Paid work must never restart"); };
  restarted("lib/openrouter/client.ts").hasOpenRouterKey = () => true;
  try {
    const recovered = await restarted("app/api/skyBatch/route.ts").POST(f.request("/api/skyBatch", "POST", { requestId: final.requestId }));
    const saved = await recovered.json();
    assert.equal(saved.reused, true); assert.equal(saved.job.targetCount, 20); assert.equal(saved.job.skyMode, "sphere");
  } finally { await restarted("lib/database.ts").closeDatabases(); }
});
