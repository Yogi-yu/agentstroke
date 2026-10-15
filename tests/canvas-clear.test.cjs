const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

function setup() {
  // Isolated Node test process: never touches the running site's artwork.
  delete globalThis.__strokeState;
  delete globalThis.__noemaSkyBatches;
  const load = createTypeScriptLoader();
  const store = load("lib/store.ts");
  const state = load("lib/skyBatchStore.ts");
  // These tests supply their own strokes/jobs, independently of release artwork.
  store.listStrokes().length = 0;
  Object.assign(state.skyBatchState(), {
    jobs: new Map(), seenRequestIds: new Set(), activeId: null, latestId: null,
    canvasRevision: 0, controllers: new Map(),
  });
  load("lib/openrouter/client.ts").hasOpenRouterKey = () => true;
  return { load, store, state };
}

const url = "http://localhost:3000/api/skyBatch";
function request(id, revision, extra = {}) {
  return new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: id, canvasRevision: revision, ...extra }),
  });
}

test("full canvas reset invalidates every cached Sky and retry but preserves agents and deduplication", async () => {
  const { load, store, state } = setup();
  const { createSkyBatch } = load("lib/skyBatch.ts");
  const agents = load("lib/agents.ts").makeAgents().slice(0, 10);
  const original = createSkyBatch("original", "original-request-01", agents, "chaos", "order");
  original.status = "complete";
  original.entries.forEach((entry, index) => {
    entry.status = "succeeded";
    entry.stroke = { id: `stroke-${index}`, agent_id: entry.agent.id, points: [{}, {}] };
    store.addStroke(entry.stroke);
  });
  const retry = { ...original, id: "retry", requestId: "retry-request-0001", entries: original.entries.map((entry) => ({ ...entry })) };
  original.retryRequestId = retry.requestId;
  const current = state.skyBatchState();
  current.jobs.set(original.requestId, original);
  current.jobs.set(retry.requestId, retry);
  current.latestId = retry.requestId;
  const poolBefore = [...store.listAgents()];
  const strokes = load("app/api/strokes/route.ts");
  const sky = load("app/api/skyBatch/route.ts");
  const cleared = await (await strokes.DELETE(new Request("http://localhost:3000/api/strokes", { method: "DELETE" }))).json();
  assert.equal(cleared.removed, 10);
  assert.equal(cleared.canvasRevision, 1);
  assert.deepEqual(store.listStrokes(), []);
  assert.deepEqual(store.listAgents(), poolBefore);
  assert.equal(current.jobs.size, 0);
  assert.equal(current.latestId, null);
  assert.equal(original.status, "cleared");
  assert.equal(retry.status, "cleared");
  assert.deepEqual(original.entries, []);
  assert.deepEqual(retry.entries, []);
  for (const id of [original.requestId, retry.requestId]) {
    const recovered = await (await sky.GET(new Request(`${url}?requestId=${id}`))).json();
    assert.equal(recovered.job, null);
    assert.equal(recovered.canvasRevision, 1);
    assert.equal((await sky.POST(request(id, 1))).status, 409, "Cleared IDs cannot generate twice");
  }
  const all = await (await sky.GET(new Request(url))).json();
  assert.equal(all.job, null);
  assert.equal((await (await strokes.GET()).json()).canvasRevision, 1);
});

test("clearing an in-flight Sky aborts its one active slot, drops late results, and skips queued strokes", async () => {
  const { load, store, state } = setup();
  const generator = load("lib/strokegen.ts");
  const pending = [];
  generator.generateStroke = (agent, from, to, timestamp, previous, options) => new Promise((resolve) => {
    pending.push({ signal: options.signal, resolve: () => resolve({ id: `late-${agent.id}`, agent_id: agent.id, points: [{}, {}] }) });
  });
  const sky = load("app/api/skyBatch/route.ts");
  const strokes = load("app/api/strokes/route.ts");
  const stream = await sky.POST(request("running-request-01", 0));
  assert.equal(pending.length, 1);
  await strokes.DELETE(new Request("http://localhost:3000/api/strokes", { method: "DELETE" }));
  assert.ok(pending.every((call) => call.signal.aborted));
  assert.equal(state.skyBatchState().activeId, null);
  assert.equal(state.skyBatchState().controllers.size, 0);
  // Even a provider/mock ignoring cancellation cannot resurrect deleted art.
  pending.forEach((call) => call.resolve());
  const frames = (await stream.text()).trim().split("\n").map(JSON.parse);
  assert.equal(frames.at(-1).job.status, "cleared");
  assert.equal(frames.at(-1).job.canvasRevision, 1);
  assert.deepEqual(frames.at(-1).job.entries, []);
  assert.equal(pending.length, 1, "The other nine stroke slots must not be called");
  const lastRunningFrame = frames.filter((frame) => frame.job.status === "running").at(-1);
  assert.ok(frames.at(-1).job.updateSequence > lastRunningFrame.job.updateSequence, "Clear is a newer state than the final running snapshot");
  assert.ok(frames.at(-1).job.updatedAt >= frames[0].job.updatedAt);
  assert.deepEqual(store.listStrokes(), []);
  assert.equal((await (await sky.GET(new Request(url))).json()).job, null);

  let newCalls = 0;
  generator.generateStroke = async (agent) => ({ id: `new-${++newCalls}`, agent_id: agent.id, points: [{}, {}] });
  const stale = await sky.POST(request("stale-before-clear-01", 0));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "canvas_cleared");
  assert.equal(newCalls, 0);
  const fresh = await sky.POST(request("fresh-after-clear-01", 1));
  const freshFrames = (await fresh.text()).trim().split("\n").map(JSON.parse);
  assert.equal(freshFrames.at(-1).job.status, "complete");
  assert.equal(newCalls, 10);
  assert.equal(store.listStrokes().length, 10);
});

test("a single stroke deletion does not wipe unrelated Sky batches or reset agents", async () => {
  const { load, store, state } = setup();
  const job = { id: "keep", requestId: "keep-request-0001", status: "complete", entries: [] };
  state.skyBatchState().jobs.set(job.requestId, job);
  store.addStroke({ id: "remove-one", agent_id: "agent-001", points: [{}, {}] });
  store.addStroke({ id: "keep-one", agent_id: "agent-002", points: [{}, {}] });
  const route = load("app/api/strokes/route.ts");
  const response = await route.DELETE(new Request("http://localhost:3000/api/strokes?id=remove-one", { method: "DELETE" }));
  assert.equal(response.status, 200);
  assert.equal(state.canvasRevision(), 0);
  assert.equal(state.skyBatchState().jobs.get(job.requestId), job);
  assert.deepEqual(store.listStrokes().map((stroke) => stroke.id), ["keep-one"]);
});

test("legacy Sky copies from a canvas cleared before this fix cannot be restored or retried", async () => {
  const { load, store, state } = setup();
  const { createSkyBatch } = load("lib/skyBatch.ts");
  const agents = load("lib/agents.ts").makeAgents().slice(0, 10);
  const legacy = createSkyBatch("legacy", "legacy-request-0001", agents, "chaos", "order");
  legacy.status = "partial";
  legacy.entries.forEach((entry, index) => {
    entry.status = index < 8 ? "succeeded" : "failed";
    if (index < 8) entry.stroke = { id: `already-deleted-${index}`, agent_id: entry.agent.id, points: [{}, {}] };
  });
  const current = state.skyBatchState();
  current.jobs.set(legacy.requestId, legacy);
  current.latestId = legacy.requestId;
  const sky = load("app/api/skyBatch/route.ts");
  assert.deepEqual(store.listStrokes(), []);
  assert.equal((await (await sky.GET(new Request(url))).json()).job, null);
  assert.equal((await (await sky.GET(new Request(`${url}?requestId=${legacy.requestId}`))).json()).job, null);
  for (const req of [request(legacy.requestId, 0), request("retry-legacy-request-01", 0, { retryOf: legacy.requestId })]) {
    const response = await sky.POST(req);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "canvas_cleared");
  }
  assert.deepEqual(store.listStrokes(), [], "Read recovery never manufactures or restores deleted artwork");
});

test("ordinary generation started before reset cannot repopulate either canvas", async () => {
  const { load, store } = setup();
  const generator = load("lib/strokegen.ts");
  let resolve;
  generator.generateStroke = (agent) => new Promise((finish) => { resolve = () => finish({ id: "late-studio", agent_id: agent.id, points: [{}, {}] }); });
  const route = load("app/api/generateStroke/route.ts");
  const request = () => new Request("http://localhost:3000/api/generateStroke", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: "chaos", to: "order", canvasRevision: 0 }),
  });
  const pending = route.POST(request());
  await new Promise(setImmediate);
  store.clearStrokes();
  resolve();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "canvas_cleared");
  assert.deepEqual(store.listStrokes(), []);
  assert.equal((await route.POST(request())).status, 409);
});
