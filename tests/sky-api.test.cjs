const test = require("node:test");
const assert = require("node:assert/strict");
const { apiFixture } = require("./durable-api-fixture.cjs");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

test("durable public Sky streams sequential progress across devices, deduplicates and retries failed slots", async t => {
  const f = await apiFixture(t);
  const sky = f.load("app/api/skyBatch/route.ts");
  const post = (requestId, extra = {}, user = "a") => f.request("/api/skyBatch", "POST", { requestId, ...extra }, user);
  let calls = 0, active = 0, peak = 0, failRemaining = 0;
  f.load("lib/strokegen.ts").generateStroke = async (agent, from, to, timestamp, previous, options) => {
    assert.equal(options.mode, "autonomous"); assert.equal(options.requireModel, true); assert.equal(from, ""); assert.equal(to, "");
    active++; peak = Math.max(peak, active); const id = calls++; const fail = failRemaining-- > 0;
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    if (fail) throw Object.assign(new Error("secret-provider-payload"), { code: "timeout" });
    options.onAttempt(2);
    return { ...f.stroke(`sky-${id}`, agent.id), from: `origin${id}`, to: `destination${id}` };
  };
  assert.equal((await (await sky.GET(f.request("/api/skyBatch"))).json()).job, null);
  assert.equal((await sky.POST(post("invalid-mode-0001", { mode: "example" }))).status, 400);
  await f.store.clearAgents(f.owner("a"));
  assert.equal((await sky.POST(post("no-agents-request-001"))).status, 409);
  assert.equal(calls, 0);
  const authors = f.load("lib/agents.ts").makeAgents().slice(0, 3);
  await f.store.ensureCatalogAgents(f.owner("a"), authors.map(a => a.id));
  const first = await sky.POST(post("first-request-0001"));
  assert.match(first.headers.get("content-type"), /ndjson/);
  assert.equal((await (await sky.POST(post("first-request-0001"))).json()).reused, true);
  assert.equal((await sky.POST(post("overlapping-request-01", {}, "b"))).status, 409);
  const frames = (await first.text()).trim().split("\n").map(JSON.parse);
  assert.equal(calls, 10); assert.equal(peak, 1);
  assert.equal(frames.at(-1).job.status, "complete");
  assert.equal(frames.at(-1).job.entries.length, 10);
  assert.equal(new Set(frames.at(-1).job.entries.map(e => e.agent.id)).size, 3);
  assert.equal((await f.store.listStrokes(f.owner("a"))).length, 11);
  for (let index = 0; index < frames.length; index++) assert.equal(frames[index].job.updateSequence, index);
  assert.equal((await (await sky.GET(f.request("/api/skyBatch?requestId=first-request-0001", "GET", undefined, "b"))).json()).job.requestId, "first-request-0001");
  assert.equal((await f.store.listStrokes(f.owner("b"))).length, 11);
  const anonymous = new Request("http://localhost:3000/api/skyBatch");
  assert.equal((await (await sky.GET(anonymous)).json()).job.requestId, "first-request-0001");
  assert.equal((await (await sky.POST(post("first-request-0001"))).json()).reused, true);
  assert.equal(calls, 10);

  failRemaining = 2;
  const partialResponse = await sky.POST(post("partial-request-0002"));
  const partial = (await partialResponse.text()).trim().split("\n").map(JSON.parse).at(-1).job;
  assert.equal(partial.status, "partial");
  const preserved = partial.entries.flatMap(e => e.stroke ? [e.stroke.id] : []); assert.equal(preserved.length, 8);
  const retryResponse = await sky.POST(post("retry-request-0003", { retryOf: partial.requestId }));
  const stale = await sky.POST(post("stale-retry-request-04", { retryOf: partial.requestId }));
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, "already_retried");
  const retry = (await retryResponse.text()).trim().split("\n").map(JSON.parse).at(-1).job;
  assert.equal(retry.status, "complete"); assert.equal(calls, 22);
  assert.ok(preserved.every(id => retry.entries.some(e => e.stroke?.id === id)));
  assert.equal((await f.store.listStrokes(f.owner("a"))).length, 21);
  const recovered = await (await sky.GET(f.request(`/api/skyBatch?requestId=${partial.requestId}`))).json();
  assert.equal(recovered.job.requestId, retry.requestId); assert.equal(recovered.resumedFrom, partial.requestId);

  // New module instances + a closed connection simulate a worker restart.
  await f.load("lib/database.ts").closeDatabases();
  const restarted = createTypeScriptLoader();
  restarted("lib/strokegen.ts").generateStroke = async () => { throw new Error("A saved request must never call a model again"); };
  restarted("lib/openrouter/client.ts").hasOpenRouterKey = () => true;
  try {
    const replay = await restarted("app/api/skyBatch/route.ts").POST(post("first-request-0001"));
    assert.equal(replay.status, 200); assert.equal((await replay.json()).reused, true);
    assert.equal((await restarted("lib/store.ts").listStrokes(f.owner("a"))).length, 21);
  } finally { await restarted("lib/database.ts").closeDatabases(); }
});

test("expired worker leases become interrupted results without automatic paid retries", async t => {
  const f = await apiFixture(t);
  const state = f.load("lib/skyBatchStore.ts");
  const pure = f.load("lib/skyBatch.ts");
  const job = pure.createSkyBatch("crash", "crashed-worker-request-01", pure.selectSkyAgents(await f.store.listAgents(f.owner("a"))));
  job.canvasRevision = 0;
  assert.equal((await state.claimSkyBatch(f.owner("a"), job)).claimed, true);
  await f.load("lib/database.ts").databaseTransaction(db => db.query("UPDATE noema_sky_jobs SET lease_until=0 WHERE owner_id=$1 AND request_id=$2", [f.owner("a"), job.requestId]));
  let calls = 0;
  f.load("lib/strokegen.ts").generateStroke = async agent => { calls++; return f.stroke(`manual-${calls}`, agent.id); };
  const route = f.load("app/api/skyBatch/route.ts");
  const recovered = await (await route.GET(f.request("/api/skyBatch"))).json();
  assert.equal(recovered.job.status, "failed");
  assert.ok(recovered.job.entries.every(e => e.errorCode === "interrupted"));
  const replay = await route.POST(f.request("/api/skyBatch", "POST", { requestId: job.requestId }));
  assert.equal((await replay.json()).reused, true); assert.equal(calls, 0);
  const retry = await route.POST(f.request("/api/skyBatch", "POST", { requestId: "manual-retry-request-01", retryOf: job.requestId }));
  assert.equal((await retry.text()).trim().split("\n").map(JSON.parse).at(-1).job.status, "complete");
  assert.equal(calls, 10);
});

test("database failure before claiming or during progress never emits an unsaved success", async t => {
  const f = await apiFixture(t);
  const state = f.load("lib/skyBatchStore.ts");
  const route = f.load("app/api/skyBatch/route.ts");
  let calls = 0;
  f.load("lib/strokegen.ts").generateStroke = async agent => { calls++; return f.stroke(`unsaved-${calls}`, agent.id); };
  const originalClaim = state.claimSkyBatch;
  state.claimSkyBatch = async () => { throw new Error("postgres://private-password@host"); };
  const failed = await route.POST(f.request("/api/skyBatch", "POST", { requestId: "failed-claim-request-01" }));
  assert.equal(failed.status, 503); assert.equal(calls, 0); assert.ok(!(await failed.text()).includes("private-password"));
  state.claimSkyBatch = originalClaim;
  const originalSave = state.saveSkyBatch;
  state.saveSkyBatch = async (owner, job, lease) => {
    if (job.entries.some(e => e.status === "succeeded")) throw new Error("private-storage-error");
    return originalSave(owner, job, lease);
  };
  const response = await route.POST(f.request("/api/skyBatch", "POST", { requestId: "failed-save-request-01" }));
  const frames = (await response.text()).trim().split("\n").map(JSON.parse);
  assert.equal(calls, 1); assert.equal(frames.at(-1).code, "storage_unavailable");
  assert.ok(!frames.some(frame => frame.job?.entries.some(e => e.status === "succeeded")));
  assert.equal((await f.store.listStrokes(f.owner("a"))).length, 1);
  assert.ok(!JSON.stringify(frames).includes("private-storage-error"));
});

test("chat cache keys isolate both visitors and private conversation contexts", async () => {
  const cache = createTypeScriptLoader()("lib/openrouter/chatCache.ts");
  const first = cache.chatCacheKey("visitor-a", "agent-000", "What did you draw?", "private-first-context");
  assert.notEqual(first, cache.chatCacheKey("visitor-b", "agent-000", "What did you draw?", "private-first-context"));
  assert.notEqual(first, cache.chatCacheKey("visitor-a", "agent-000", "What did you draw?", "private-next-context"));
  assert.ok(!first.includes("private-first-context"));
});

test("a transient heartbeat outage cannot discard a paid result when its durable checkpoint recovers", async t => {
  const f = await apiFixture(t);
  const route = f.load("app/api/skyBatch/route.ts");
  let heartbeatTick, finish, calls = 0;
  const realInterval = global.setInterval;
  const realClear = global.clearInterval;
  const timer = { unref() {} };
  global.setInterval = callback => { heartbeatTick = callback; return timer; };
  global.clearInterval = handle => { if (handle !== timer) realClear(handle); };
  t.after(() => { global.setInterval = realInterval; global.clearInterval = realClear; });
  f.load("lib/skyBatchStore.ts").heartbeatSkyBatch = async () => { throw new Error("transient DB disconnect"); };
  f.load("lib/strokegen.ts").generateStroke = async agent => {
    calls++;
    if (calls === 1) await new Promise(resolve => { finish = resolve; });
    return f.stroke(`heartbeat-recovered-${calls}`, agent.id);
  };
  const response = await route.POST(f.request("/api/skyBatch", "POST", { requestId: "heartbeat-recovery-01" }));
  while (!finish) await new Promise(setImmediate);
  heartbeatTick();
  await new Promise(setImmediate);
  finish();
  const frames = (await response.text()).trim().split("\n").map(JSON.parse);
  assert.equal(frames.at(-1).job.status, "complete");
  assert.equal(calls, 10);
  assert.equal((await f.store.listStrokes(f.owner("a"))).length, 11);
  assert.ok(!frames.some(frame => frame.code === "storage_unavailable"));
});
