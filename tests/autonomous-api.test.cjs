const test = require("node:test");
const assert = require("node:assert/strict");
const { apiFixture } = require("./durable-api-fixture.cjs");

async function setup(t) {
  const f = await apiFixture(t);
  const calls = [];
  const generator = f.load("lib/strokegen.ts");
  generator.generateStroke = async (agent, from, to, timestamp, previous, options) => {
    calls.push({ agent, from, to, options });
    return { ...f.stroke(`mock-${calls.length}`, agent.id), from: "origin", to: "destination" };
  };
  return { ...f, calls, generator, route: f.load("app/api/generateStroke/route.ts"), post: body => f.request("/api/generateStroke", "POST", body) };
}

test("autonomous endpoints ignore site-provided words and persist the canonical instrument", async t => {
  const f = await setup(t);
  for (const body of [{}, { from: "chaos", to: "order", agent_id: f.seed.agent_id }]) {
    const response = await f.route.POST(f.post(body));
    assert.equal(response.status, 200);
    const { stroke } = await response.json();
    assert.equal(stroke.from, "origin");
    assert.equal(stroke.to, "destination");
    assert.ok(stroke.brush_treatment);
    assert.deepEqual(await f.store.getStroke(f.owner("a"), stroke.id), stroke);
  }
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.from, ""); assert.equal(call.to, "");
    assert.equal(call.options.mode, "autonomous"); assert.equal(call.options.requireModel, true);
  }
});

test("invalid body, mode, revision and foreign origin make no model calls", async t => {
  const f = await setup(t);
  for (const body of [null, [], 3, { mode: "fixed" }, { mode: false }, { mode: null }, { canvasRevision: -1 }, { canvasRevision: "0" }, { agent_id: 0 }]) {
    assert.equal((await f.route.POST(f.post(body))).status, 400, JSON.stringify(body));
  }
  const foreign = f.post({}); foreign.headers.set("origin", "https://evil.example");
  assert.equal((await f.route.POST(foreign)).status, 403);
  assert.equal(f.calls.length, 0);
});

test("anonymous generation needs no cookie and becomes visible to another device", async t => {
  const f = await setup(t);
  const req = f.post({}); req.headers.delete("cookie");
  const response = await f.route.POST(req);
  assert.equal(response.status, 200);
  const { stroke } = await response.json();
  const other = await f.load("app/api/strokes/route.ts").GET(f.request("/api/strokes", "GET", undefined, "b"));
  assert.ok((await other.json()).strokes.some(s => s.id === stroke.id));
  assert.equal(f.calls.length, 1);
});

test("simultaneous fixed-example requests restore one public work without paid generation", async t => {
  const f = await setup(t);
  await f.store.clearStrokes(f.owner("a"));
  const responses = await Promise.all([f.route.POST(f.post({ mode: "example", canvasRevision: 1 })), f.route.POST(f.post({ mode: "example", canvasRevision: 1 }))]);
  assert.ok(responses.every(r => r.status === 200));
  assert.equal(f.calls.length, 0);
  assert.deepEqual((await f.store.listStrokes(f.owner("a"))).map(s => s.id), [f.seed.id]);
  for (const response of responses) {
    const result = await response.json(); assert.equal(result.stroke.id, f.seed.id); assert.equal(result.reused, true);
  }
  assert.equal((await f.route.POST(f.post({ mode: "example", canvasRevision: 0 }))).status, 409);
});

test("a late generation after clear is archived without refilling the canvas", async t => {
  const f = await setup(t);
  let finish;
  f.generator.generateStroke = agent => new Promise(resolve => { finish = () => resolve(f.stroke("late-studio", agent.id)); });
  const pending = f.route.POST(f.post({ canvasRevision: 0 }));
  while (!finish) await new Promise(setImmediate);
  await f.store.clearStrokes(f.owner("a"));
  finish();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).archived, true);
  assert.deepEqual(await f.store.listStrokes(f.owner("a")), []);
  assert.ok((await f.store.listArchivedStrokes(f.owner("a"))).strokes.some(s => s.id.startsWith("late-studio-")));
});

test("safe model errors never fabricate artwork and DB failures never report successful saves", async t => {
  const f = await setup(t);
  f.generator.generateStroke = async () => { throw Object.assign(new Error("secret-provider-payload"), { status: 401 }); };
  const failed = await f.route.POST(f.post({}));
  assert.equal(failed.status, 503);
  const error = await failed.json(); assert.equal(error.code, "authentication"); assert.ok(!JSON.stringify(error).includes("secret-provider-payload"));
  f.generator.generateStroke = async agent => f.stroke("not-saved", agent.id);
  f.store.addStroke = async () => { throw new Error("postgres://password@private-db"); };
  const unavailable = await f.route.POST(f.post({}));
  assert.equal(unavailable.status, 503);
  const body = await unavailable.json(); assert.equal(body.code, "storage_unavailable"); assert.ok(!JSON.stringify(body).includes("password"));
  assert.equal((await f.store.listStrokes(f.owner("a"))).length, 1);
});
