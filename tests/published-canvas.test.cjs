const test = require("node:test");
const assert = require("node:assert/strict");
const snapshot = require("../data/published-canvas.json");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

const expectedIds = [
  "stroke-1792019589820-agent-019",
  "stroke-1792019589921-agent-000",
  "stroke-1792019590033-agent-012",
  "stroke-1792019590123-agent-008",
  "stroke-1792019590220-agent-001",
  "stroke-1792019590321-agent-006",
  "stroke-1792019590432-agent-018",
  "stroke-1792019590591-agent-017",
  "stroke-1792019590660-agent-007",
  "stroke-1792019590787-agent-003",
];

function coldStart() {
  // Isolated test-process globals only; never touches a running site's canvas.
  delete globalThis.__strokeState;
  delete globalThis.__noemaSkyBatches;
  const load = createTypeScriptLoader();
  return { load, store: load("lib/store.ts"), sky: load("lib/skyBatchStore.ts") };
}

test("the release contains the exact ten existing artworks and 23 public agent identities", () => {
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.capturedAt, "2026-10-15T01:34:35.116Z");
  assert.equal(snapshot.trailRetention, 0.2);
  assert.equal(snapshot.agents.length, 23);
  assert.equal(new Set(snapshot.agents.map((agent) => agent.id)).size, 23);
  assert.deepEqual(snapshot.strokes.map((stroke) => stroke.id), expectedIds);
  const authors = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  for (const stroke of snapshot.strokes) {
    assert.ok(authors.has(stroke.agent_id));
    assert.equal(stroke.from, "chaos");
    assert.equal(stroke.to, "order");
    assert.ok(stroke.points.length >= 2);
    assert.equal(stroke.points[0].anchor, stroke.from);
    assert.equal(stroke.points.at(-1).anchor, stroke.to);
    assert.ok(Number.isFinite(stroke.timestamp));
    assert.ok(Number.isFinite(stroke.base_seed));
    assert.ok(Number.isFinite(stroke.variation_seed));
    assert.equal(stroke.visual_signature.version, 1);
  }
  assert.equal(snapshot.skyBatch.status, "complete");
  assert.equal(snapshot.skyBatch.canvasRevision, snapshot.canvasRevision);
  assert.equal(snapshot.skyBatch.entries.length, 10);
  snapshot.skyBatch.entries.forEach((entry, index) => {
    assert.equal(entry.status, "succeeded");
    assert.deepEqual(entry.stroke, snapshot.strokes[index]);
    assert.deepEqual(entry.agent, authors.get(entry.stroke.agent_id));
  });
  const inspect = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.doesNotMatch(key, /api.?key|secret|authorization|password|access.?token|chat.?history/i);
      inspect(child);
    }
  };
  inspect(snapshot);
});

test("published canvas factories deep-clone nested artwork, agents, and Sky provenance", () => {
  const { createPublishedCanvas } = createTypeScriptLoader()("lib/publishedCanvas.ts");
  const first = createPublishedCanvas();
  const second = createPublishedCanvas();
  assert.deepEqual(first, snapshot);
  first.agents[0].name = "Changed locally";
  first.strokes[0].points[0].anchor = "changed";
  first.strokes[0].visual_signature.color_hues[0] = -1;
  first.skyBatch.entries[0].stroke.points.length = 0;
  first.skyBatch.entries[0].agent.name = "Changed batch author";
  assert.deepEqual(second, snapshot);
  assert.deepEqual(createPublishedCanvas(), snapshot);
});

test("cold startup restores Studio and a completed idle Sky with revision and request tombstone", async () => {
  const { load, store, sky } = coldStart();
  // Initialize Sky first: each store must be independently safe to bootstrap.
  const current = sky.skyBatchState();
  const publishedJob = current.jobs.get(snapshot.skyBatch.requestId);
  assert.deepEqual(publishedJob, snapshot.skyBatch);
  assert.equal(current.latestId, snapshot.skyBatch.requestId);
  assert.ok(current.seenRequestIds.has(snapshot.skyBatch.requestId));
  assert.equal(current.activeId, null);
  assert.equal(current.controllers.size, 0);
  assert.equal(current.canvasRevision, snapshot.canvasRevision);
  assert.deepEqual(store.listAgents(), snapshot.agents);
  assert.deepEqual(store.listStrokes(), snapshot.strokes);
  const route = load("app/api/skyBatch/route.ts");
  const url = "http://localhost:3000/api/skyBatch";
  const response = await (await route.GET(new Request(url))).json();
  assert.deepEqual(response.job, snapshot.skyBatch);
  // Recovering the published ID is a read even with generation unavailable.
  load("lib/openrouter/client.ts").hasOpenRouterKey = () => false;
  load("lib/strokegen.ts").generateStroke = () => { throw new Error("Must not generate"); };
  const replay = await route.POST(new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ requestId: snapshot.skyBatch.requestId, canvasRevision: snapshot.canvasRevision }),
  }));
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).reused, true);
  assert.equal(store.listStrokes().length, 10);
});

test("existing live state and edits survive module reload without release overwrite", () => {
  const { store, sky } = coldStart();
  const first = store.listStrokes()[0];
  first.points[0].anchor = "runtime edit";
  store.removeStroke(expectedIds[1]);
  store.removeAgent("agent-022");
  const current = sky.skyBatchState();
  current.canvasRevision = 7;
  const reloaded = createTypeScriptLoader();
  assert.equal(reloaded("lib/store.ts").listStrokes()[0], first);
  assert.equal(reloaded("lib/store.ts").listStrokes().length, 9);
  assert.equal(reloaded("lib/store.ts").listAgents().length, 22);
  assert.equal(reloaded("lib/skyBatchStore.ts").skyBatchState(), current);
  assert.equal(reloaded("lib/skyBatchStore.ts").canvasRevision(), 7);
  assert.deepEqual(reloaded("lib/publishedCanvas.ts").createPublishedCanvas(), snapshot);
});

test("clearing artwork or agents never resurrects the seed on reads, reloads, or old Sky requests", async () => {
  const { store, sky } = coldStart();
  assert.equal(store.clearStrokes(), 10);
  assert.equal(sky.canvasRevision(), snapshot.canvasRevision + 1);
  assert.equal(store.listAgents().length, 23, "Canvas reset preserves the agent pool");
  assert.equal(store.clearAgents(), 23);
  const load = createTypeScriptLoader();
  assert.deepEqual(load("lib/store.ts").listStrokes(), []);
  assert.deepEqual(load("lib/store.ts").listAgents(), []);
  const current = load("lib/skyBatchStore.ts").skyBatchState();
  assert.equal(current.jobs.size, 0);
  assert.equal(current.latestId, null);
  assert.ok(current.seenRequestIds.has(snapshot.skyBatch.requestId));
  const route = load("app/api/skyBatch/route.ts");
  const url = "http://localhost:3000/api/skyBatch";
  assert.equal((await (await route.GET(new Request(url))).json()).job, null);
  const replay = await route.POST(new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ requestId: snapshot.skyBatch.requestId, canvasRevision: current.canvasRevision }),
  }));
  assert.equal(replay.status, 409);
  assert.deepEqual(store.listStrokes(), []);
  assert.deepEqual(store.listAgents(), []);
});
