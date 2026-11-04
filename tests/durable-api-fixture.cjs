const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

async function apiFixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "noema-api-test-"));
  const before = Object.fromEntries(["DATABASE_URL", "NOEMA_SQLITE_PATH", "NODE_ENV", "RENDER"].map(key => [key, process.env[key]]));
  // Tests must never inherit a developer's or production database connection.
  process.env.DATABASE_URL = "";
  process.env.RENDER = "";
  process.env.NODE_ENV = "test";
  process.env.NOEMA_SQLITE_PATH = join(temp, "test.sqlite");
  const load = createTypeScriptLoader();
  const request = (path, method = "GET", body, user = "a") => new Request(`http://localhost:3000${path}`, {
    method, headers: { cookie: `noema_visitor=${user.repeat(64)}`, origin: "http://localhost:3000", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // Different browser cookies intentionally resolve to one public canvas.
  const owner = _user => load("lib/sharedCanvas.ts").SHARED_CANVAS_OWNER;
  const store = load("lib/store.ts");
  const seed = load("lib/publishedCanvas.ts").createPublishedCanvas().strokes[0];
  const stroke = (id, agentId = seed.agent_id) => ({ ...structuredClone(seed), id, agent_id: agentId, created_at: Date.now(), generation_mode: "autonomous" });
  await store.listStrokes(owner("a"));
  load("lib/openrouter/client.ts").hasOpenRouterKey = () => true;
  t.after(async () => {
    await load("lib/database.ts").closeDatabases();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(temp, { recursive: true, force: true });
  });
  return { load, request, owner, store, stroke, seed };
}

module.exports = { apiFixture };
