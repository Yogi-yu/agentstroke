// Contract tests for the autonomous studio. Added without local execution for
// this release, as requested; provider calls are never made by these fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTypeScriptLoader } = require('./load-typescript.cjs');
const example = require('../data/published-canvas.json').strokes[0];

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noema-autopilot-contract-'));
  const keys = ['DATABASE_URL', 'NOEMA_SQLITE_PATH', 'RENDER', 'NODE_ENV', 'NOEMA_AUTOPILOT_RUNTIME', 'NOEMA_AUTOPILOT_DISABLED', 'NEXT_PHASE'];
  const environment = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  delete process.env.DATABASE_URL;
  delete process.env.RENDER;
  process.env.NODE_ENV = 'test';
  process.env.NOEMA_SQLITE_PATH = path.join(directory, 'fixture.sqlite');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const load = createTypeScriptLoader();
  const database = load('lib/database.ts');
  const owner = load('lib/sharedCanvas.ts').SHARED_CANVAS_OWNER;
  const auto = load('lib/autopilotStore.ts');
  const store = load('lib/store.ts');
  t.after(async () => {
    await database.closeDatabases();
    for (const key of keys) {
      if (environment[key] === undefined) delete process.env[key];
      else process.env[key] = environment[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    load, database, owner, auto, store,
    now: () => now,
    advance: milliseconds => { now += milliseconds; return now; },
    async state() {
      return database.databaseTransaction(async db => {
        const row = (await db.query('SELECT payload FROM noema_autopilot WHERE owner_id=$1', [owner])).rows[0];
        return row ? JSON.parse(row.payload) : null;
      });
    },
    async tickToDue() {
      const due = (await this.state()).nextGenerationAt;
      while (now + 30_000 < due) {
        now += 30_000;
        assert.equal(await auto.claimAutopilotTick(now), null);
      }
      now = due;
      return auto.claimAutopilotTick(now);
    },
  };
}

function artwork(id, agentId, createdAt) {
  return { ...structuredClone(example), id, agent_id: agentId ?? example.agent_id, created_at: createdAt, timestamp: createdAt, brush_treatment: undefined };
}

test('autopilot is gated to an opted-in Render production runtime, never a local process or build', () => {
  const keys = ['RENDER', 'NODE_ENV', 'NOEMA_AUTOPILOT_RUNTIME', 'NOEMA_AUTOPILOT_DISABLED', 'NEXT_PHASE'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const { autopilotEnabled } = createTypeScriptLoader()('lib/autopilotStore.ts');
  try {
    Object.assign(process.env, { RENDER: 'true', NODE_ENV: 'production', NOEMA_AUTOPILOT_RUNTIME: '1' });
    delete process.env.NOEMA_AUTOPILOT_DISABLED; delete process.env.NEXT_PHASE;
    assert.equal(autopilotEnabled(), true);
    process.env.NEXT_PHASE = 'phase-production-build';
    assert.equal(autopilotEnabled(), false);
    delete process.env.NEXT_PHASE; process.env.NOEMA_AUTOPILOT_DISABLED = '1';
    assert.equal(autopilotEnabled(), false);
    delete process.env.NOEMA_AUTOPILOT_DISABLED; delete process.env.NOEMA_AUTOPILOT_RUNTIME;
    assert.equal(autopilotEnabled(), false);
    process.env.NOEMA_AUTOPILOT_RUNTIME = '1'; delete process.env.RENDER;
    assert.equal(autopilotEnabled(), false);
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
  }
});

test('startup waits five minutes, recruits to the target, and simultaneous workers claim only one fresh creator', async t => {
  const f = fixture(t);
  assert.equal(await f.auto.claimAutopilotTick(f.now()), null);
  const initial = await f.store.listAgents(f.owner);
  assert.equal(initial.length, 40);
  assert.equal(f.store.agentCapacity(), 50);
  const due = (await f.state()).nextGenerationAt;
  assert.equal(due, f.now() + 300_000);
  while (f.now() + 30_000 < due) {
    f.advance(30_000);
    assert.equal(await f.auto.claimAutopilotTick(f.now()), null);
  }
  f.advance(due - f.now());
  const results = await Promise.all([f.auto.claimAutopilotTick(f.now()), f.auto.claimAutopilotTick(f.now())]);
  const claims = results.filter(Boolean);
  assert.equal(claims.length, 1);
  assert.ok(!initial.some(agent => agent.id === claims[0].agent.id));
  assert.equal((await f.store.listAgents(f.owner)).length, 41);
  assert.equal((await f.state()).nextGenerationAt, f.now() + 300_000);
  await f.auto.failAutopilotClaim(claims[0].runId, 'The model is temporarily unavailable.', f.now());
  f.advance(30_000);
  assert.equal(await f.auto.claimAutopilotTick(f.now()), null, 'failure cannot trigger paid retries each maintenance tick');
});

test('service sleep discards missed slots; a fresh runtime resumes with one future interval, not a burst', async t => {
  const f = fixture(t);
  await f.auto.claimAutopilotTick(f.now());
  f.advance(60 * 60_000);
  assert.equal(await f.auto.claimAutopilotTick(f.now()), null);
  assert.equal((await f.state()).nextGenerationAt, f.now() + 300_000);
  assert.equal((await f.store.listAgents(f.owner)).length, 40);
  const claim = await f.tickToDue();
  assert.ok(claim);
  const due = (await f.state()).nextGenerationAt;
  f.advance(60_000);
  assert.equal(await f.auto.claimAutopilotTick(f.now()), null, 'an overlapping runtime must not steal the healthy lease');
  assert.equal((await f.state()).nextGenerationAt, due, 'rolling deployment must not postpone a healthy schedule');
  assert.equal(await f.auto.heartbeatAutopilotClaim(claim.runId, f.now()), true);
});

test('expired leases fence late completions while retaining the paid artwork in Archive', async t => {
  const f = fixture(t);
  await f.auto.claimAutopilotTick(f.now());
  const claim = await f.tickToDue();
  assert.ok(claim);
  f.advance(f.auto.AUTOPILOT_LEASE_MS + 1);
  assert.equal(await f.auto.heartbeatAutopilotClaim(claim.runId, f.now()), false);
  assert.equal(await f.auto.claimAutopilotTick(f.now()), null);
  assert.equal(await f.auto.finishAutopilotClaim(claim, artwork('provider-id', claim.agent.id, f.now()), f.now()), false);
  const canonicalId = `stroke-auto-${claim.runId}`;
  assert.ok(await f.store.getStroke(f.owner, canonicalId));
  assert.ok(!(await f.store.listStrokes(f.owner)).some(stroke => stroke.id === canonicalId));
  assert.equal((await f.state()).nextGenerationAt, f.now() + 300_000);
});

test('clear during an in-flight creation is respected and a repeated completion is idempotent', async t => {
  const f = fixture(t);
  await f.auto.claimAutopilotTick(f.now());
  const claim = await f.tickToDue();
  assert.ok(claim);
  await f.store.clearStrokes(f.owner);
  const work = artwork('provider-id', claim.agent.id, f.now());
  assert.equal(await f.auto.finishAutopilotClaim(claim, work, f.now()), false);
  assert.equal(await f.auto.finishAutopilotClaim(claim, { ...work, from: 'changed' }, f.now()), false);
  assert.deepEqual(await f.store.listStrokes(f.owner), []);
  const saved = await f.store.getStroke(f.owner, `stroke-auto-${claim.runId}`);
  assert.equal(saved.from, work.from);
  assert.equal((await f.store.listArchivedStrokes(f.owner)).total, 2, 'one original example plus one immutable scheduled artwork');
  assert.equal((await f.store.getAgent(f.owner, claim.agent.id)).creative_count, 1);
});

test('FIFO uses canvas admission, never model timestamps, and restore/read/duplicate-save preserve immutable originals', async t => {
  const f = fixture(t);
  await f.store.clearStrokes(f.owner);
  for (let i = 0; i < 52; i++) {
    await f.store.addStroke(f.owner, artwork(`fifo-${i}`, undefined, f.now() - i * 1000));
  }
  let visible = new Set((await f.store.listStrokes(f.owner)).map(stroke => stroke.id));
  assert.equal(visible.size, 50);
  assert.ok(!visible.has('fifo-0') && !visible.has('fifo-1'));
  assert.ok(visible.has('fifo-51'), 'new arrivals may carry older authored timestamps');
  const oldestVisible = await f.store.getStroke(f.owner, 'fifo-2');
  await f.store.addStroke(f.owner, oldestVisible);
  await f.store.addStroke(f.owner, artwork('fifo-52', undefined, f.now()));
  visible = new Set((await f.store.listStrokes(f.owner)).map(stroke => stroke.id));
  assert.ok(!visible.has('fifo-2'), 'a retry must not change queue priority');
  await f.store.restoreStroke(f.owner, 'fifo-0');
  visible = new Set((await f.store.listStrokes(f.owner)).map(stroke => stroke.id));
  assert.equal(visible.size, 50);
  assert.ok(visible.has('fifo-0') && !visible.has('fifo-3'));
  assert.equal((await f.store.listArchivedStrokes(f.owner)).total, 54);
  assert.equal((await f.store.getStroke(f.owner, 'fifo-1')).created_at, f.now() - 1000);
});

test('real activity protects one agent while idle profiles retire, historical identity survives and reads do not heartbeat', async t => {
  const f = fixture(t);
  await f.auto.claimAutopilotTick(f.now());
  const pool = await f.store.listAgents(f.owner);
  const newcomers = pool.filter(agent => agent.id.startsWith('agent-live-'));
  assert.ok(newcomers.length >= 2);
  const active = newcomers[0], inactive = newcomers[1];
  f.advance(570_000);
  await f.store.touchAgentActivity(f.owner, active.id);
  const touchedAt = f.now();
  f.advance(30_000);
  await f.database.databaseTransaction(db => f.store.maintainAgentPoolInTransaction(db, f.owner, f.now()));
  const maintained = await f.store.listAgents(f.owner);
  assert.equal(maintained.length, 40);
  assert.ok(maintained.some(agent => agent.id === active.id));
  assert.ok(!maintained.some(agent => agent.id === inactive.id));
  assert.equal((await f.store.getAgent(f.owner, inactive.id)).name, inactive.name);
  f.advance(15_000);
  await f.store.listAgents(f.owner); await f.store.getAgent(f.owner, active.id);
  assert.equal((await f.store.getAgent(f.owner, active.id)).last_active_at, touchedAt);
  for (let i = 0; i < 15; i++) await f.store.attractAgent(f.owner);
  assert.equal((await f.store.listAgents(f.owner)).length, 50, 'manual recruitment shares the hard cap');
});
