const test = require("node:test");
const assert = require("node:assert/strict");
const { apiFixture } = require("./durable-api-fixture.cjs");

test("clearing a canvas keeps all works in Archive and affects only its visitor", async t => {
  const f = await apiFixture(t);
  await f.store.addStroke(f.owner("a"), f.stroke("alice-private"));
  await f.store.addStroke(f.owner("b"), f.stroke("bob-private"));
  const strokes = f.load("app/api/strokes/route.ts");
  const archive = f.load("app/api/archive/route.ts");
  const detail = f.load("app/api/strokes/[id]/route.ts");
  const beforeB = await f.store.listStrokes(f.owner("b"));
  const pool = await f.store.listAgents(f.owner("a"));
  const result = await (await strokes.DELETE(f.request("/api/strokes", "DELETE"))).json();
  assert.equal(result.cleared, true); assert.equal(result.archived, true); assert.equal(result.canvasRevision, 1);
  assert.deepEqual(await f.store.listStrokes(f.owner("a")), []);
  assert.deepEqual(await f.store.listStrokes(f.owner("b")), beforeB);
  assert.deepEqual(await f.store.listAgents(f.owner("a")), pool);
  const ownArchive = await (await archive.GET(f.request("/api/archive?limit=1"))).json();
  assert.equal(ownArchive.total, 2); assert.equal(ownArchive.hasMore, true); assert.equal(ownArchive.strokes.length, 1);
  const all = await (await archive.GET(f.request("/api/archive"))).json();
  assert.ok(all.strokes.some(s => s.id === "alice-private")); assert.ok(!all.strokes.some(s => s.id === "bob-private"));
  assert.equal((await archive.POST(f.request("/api/archive", "POST", { id: "bob-private" }))).status, 404);
  assert.equal((await detail.GET(f.request("/api/strokes/bob-private"), { params: Promise.resolve({ id: "bob-private" }) })).status, 404);
  assert.equal((await detail.GET(f.request("/api/strokes/alice-private"), { params: Promise.resolve({ id: "alice-private" }) })).status, 200);
  const restore = await archive.POST(f.request("/api/archive", "POST", { id: "alice-private" }));
  assert.equal(restore.status, 200);
  assert.deepEqual((await f.store.listStrokes(f.owner("a"))).map(s => s.id), ["alice-private"]);
});

test("single hide, transforms and agent removal never mutate another visitor or delete art", async t => {
  const f = await apiFixture(t);
  const strokes = f.load("app/api/strokes/route.ts");
  const agents = f.load("app/api/agents/route.ts");
  await f.store.listStrokes(f.owner("b"));
  const original = await f.store.getStroke(f.owner("b"), f.seed.id);
  const transform = { translation: { x: .2, y: .3 }, rotation: 1, scale: 2 };
  assert.equal((await strokes.PATCH(f.request("/api/strokes", "PATCH", { id: f.seed.id, transform }))).status, 200);
  assert.deepEqual((await f.store.getStroke(f.owner("b"), f.seed.id)), original);
  assert.equal((await strokes.DELETE(f.request(`/api/strokes?id=${f.seed.id}`, "DELETE"))).status, 200);
  assert.ok(await f.store.getStroke(f.owner("a"), f.seed.id));
  assert.equal((await f.store.listStrokes(f.owner("b"))).length, 1);
  assert.equal(await f.store.canvasRevision(f.owner("a")), 0);
  assert.equal((await agents.DELETE(f.request("/api/agents", "DELETE"))).status, 200);
  assert.equal((await f.store.listAgents(f.owner("a"))).length, 0);
  assert.ok((await f.store.listAgents(f.owner("b"))).length > 0);
  assert.equal((await f.store.listArchivedStrokes(f.owner("a"))).total, 1);
});

test("a Sky call finishing after clear is archived, not restored, and remaining calls stop", async t => {
  const f = await apiFixture(t);
  let finish, calls = 0;
  f.load("lib/strokegen.ts").generateStroke = agent => new Promise(resolve => { calls++; finish = () => resolve(f.stroke("late-sky", agent.id)); });
  const sky = f.load("app/api/skyBatch/route.ts");
  const stream = await sky.POST(f.request("/api/skyBatch", "POST", { requestId: "clear-in-flight-0001", canvasRevision: 0 }));
  assert.equal(stream.status, 200);
  while (!finish) await new Promise(setImmediate);
  await f.store.clearStrokes(f.owner("a"));
  finish();
  const frames = (await stream.text()).trim().split("\n").map(JSON.parse);
  assert.equal(frames.at(-1).job.status, "cleared");
  assert.equal(calls, 1);
  assert.deepEqual(await f.store.listStrokes(f.owner("a")), []);
  assert.ok((await f.store.listArchivedStrokes(f.owner("a"))).strokes.some(s => s.id.startsWith("late-sky-")));
  assert.equal((await (await sky.GET(f.request("/api/skyBatch"))).json()).job, null);
  assert.equal((await sky.POST(f.request("/api/skyBatch", "POST", { requestId: "clear-in-flight-0001", canvasRevision: 1 }))).status, 409);
  assert.equal(calls, 1);
});

test("all mutations reject foreign origins and unavailable storage does not fake success", async t => {
  const f = await apiFixture(t);
  const routes = [
    ["app/api/strokes/route.ts", "DELETE", "/api/strokes"],
    ["app/api/agents/route.ts", "DELETE", "/api/agents"],
    ["app/api/archive/route.ts", "POST", "/api/archive"],
    ["app/api/agentChat/route.ts", "POST", "/api/agentChat"],
  ];
  for (const [file, method, path] of routes) {
    const request = f.request(path, method, method === "POST" ? {} : undefined); request.headers.set("origin", "https://evil.example");
    assert.equal((await f.load(file)[method](request)).status, 403);
  }
  f.store.clearStrokes = async () => { throw new Error("private-db-password"); };
  const failed = await f.load("app/api/strokes/route.ts").DELETE(f.request("/api/strokes", "DELETE"));
  assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes("private-db-password"));
  const health = f.load("app/api/health/route.ts");
  assert.deepEqual(await (await health.GET()).json(), { status: "ok", storage: "sqlite" });
  f.load("lib/database.ts").storageHealth = async () => { throw new Error("private-db-password"); };
  const unhealthy = await health.GET(); assert.equal(unhealthy.status, 503); assert.deepEqual(await unhealthy.json(), { status: "unavailable" });
});
