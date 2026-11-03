const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const load = createTypeScriptLoader();
const { selectSkyAgents, createSkyBatch, retrySkyBatch, runSkyBatch, skyGenerationError } = load("lib/skyBatch.ts");
const catalog = Array.from({ length: 23 }, (_, index) => ({ id: `agent-${index}`, name: `Agent ${index}` }));

test("selects ten stroke slots from only existing authors, balanced and without adjacent repeats", () => {
  const before = JSON.stringify(catalog);
  for (const pool of [catalog.slice(0, 1), catalog.slice(0, 2), catalog.slice(0, 3), catalog.slice(0, 7), catalog.slice(0, 15), [catalog[0], catalog[0]]]) {
    for (const random of [() => 0, () => 0.42, () => .999999]) {
      const selected = selectSkyAgents(pool, random);
      assert.equal(selected.length, 10);
      assert.ok(selected.every((agent) => pool.includes(agent)));
      const authors = [...new Set(pool.map((agent) => agent.id))];
      const counts = authors.map((id) => selected.filter((agent) => agent.id === id).length);
      assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, "Shuffle rounds use authors evenly");
      if (authors.length > 1) assert.ok(selected.every((agent, i) => !i || agent.id !== selected[i - 1].id));
      if (authors.length >= 10) assert.equal(new Set(selected.map((agent) => agent.id)).size, 10);
      else assert.ok(authors.every((id) => selected.some((agent) => agent.id === id)));
    }
  }
  assert.equal(JSON.stringify(catalog), before);
  assert.throws(() => selectSkyAgents([]), /No agents are available/);
});

test("strict batch runs one slot at a time and emits each result before starting the next", async () => {
  const selected = selectSkyAgents(catalog.slice(0, 3), () => .42);
  const batch = createSkyBatch("job", "request", selected, "chaos", "order");
  assert.equal(batch.mode, "autonomous");
  assert.equal(batch.from, "");
  assert.equal(batch.to, "");
  assert.equal(batch.updateSequence, 0);
  assert.equal(batch.updatedAt, batch.createdAt);
  let active = 0;
  let peak = 0;
  const calls = [];
  const saved = [];
  const snapshots = [];
  await runSkyBatch(batch, {
    generate: async (agent, index) => {
      if (index > 0) {
        const previousResult = snapshots.find((snapshot) => snapshot.entries[index - 1].status === "succeeded" || snapshot.entries[index - 1].status === "failed");
        assert.ok(previousResult, "Prior completion must be emitted before the next model call");
        assert.equal(previousResult.entries[index].status, "queued");
      }
      calls.push(agent.id);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 4 + (index % 3)));
      active--;
      if (index === 2 || index === 8) throw new Error("provider 429 rate limit");
      return { id: `stroke-${index}`, agent_id: agent.id, points: [{}, {}] };
    },
    persist: (stroke) => saved.push(stroke),
  }, () => snapshots.push(JSON.parse(JSON.stringify(batch))));
  assert.equal(peak, 1);
  assert.equal(calls.length, 10);
  assert.deepEqual(calls, selected.map((agent) => agent.id));
  assert.equal(new Set(calls).size, 3);
  assert.equal(saved.length, 8);
  assert.equal(batch.status, "partial");
  assert.ok(batch.finishedAt >= batch.createdAt);
  assert.equal(batch.entries.filter((entry) => entry.status === "failed").length, 2);
  assert.ok(batch.entries.filter((entry) => entry.status === "failed").every((entry) => !entry.stroke && entry.error));
  assert.ok(snapshots.some((snapshot) => snapshot.entries.some((entry) => entry.status === "running") && snapshot.entries.some((entry) => entry.status === "queued")));
  assert.ok(snapshots.every((snapshot) => snapshot.entries.filter((entry) => entry.status === "running").length <= 1));
  assert.ok(batch.startedAt >= batch.createdAt);
  assert.ok(batch.updatedAt >= batch.finishedAt);
  for (const [index, entry] of batch.entries.entries()) {
    assert.ok(entry.startedAt >= batch.startedAt);
    assert.ok(entry.finishedAt >= entry.startedAt);
    if (index > 0) assert.ok(entry.startedAt >= batch.entries[index - 1].finishedAt);
  }
  snapshots.forEach((snapshot, index) => {
    assert.equal(snapshot.updateSequence, index + 1);
    if (index > 0) assert.ok(snapshot.updatedAt >= snapshots[index - 1].updatedAt);
  });
  assert.equal(batch.updateSequence, 21, "Ten start/result pairs plus final batch status");
});

test("invalid and failed model outputs never manufacture or save replacement strokes", async () => {
  const batch = createSkyBatch("job", "request", catalog.slice(0, 10), "chaos", "order");
  let saved = 0;
  await runSkyBatch(batch, {
    generate: async (agent, index) => {
      if (index % 2) throw new Error("API key secret-should-not-leak");
      return { id: "invalid", agent_id: "wrong-agent", points: [] };
    },
    persist: () => saved++,
  });
  assert.equal(saved, 0);
  assert.equal(batch.status, "failed");
  assert.ok(batch.entries.every((entry) => entry.status === "failed" && !entry.stroke));
  assert.ok(!JSON.stringify(batch).includes("secret-should-not-leak"));
  assert.equal(skyGenerationError(new Error("timed out")), "The model timed out. No stroke was saved.");
});

test("one existing author can produce ten separate strokes; exactly ten slots remain required", async () => {
  assert.throws(() => createSkyBatch("j", "r", Array(9).fill(catalog[0]), "chaos", "order"), /ten stroke slots/);
  assert.throws(() => createSkyBatch("j", "r", Array(11).fill(catalog[0]), "chaos", "order"), /ten stroke slots/);
  const batch = createSkyBatch("job", "request", Array(10).fill(catalog[0]), "chaos", "order");
  await runSkyBatch(batch, { generate: async (agent, index) => ({ id: String(index), agent_id: agent.id, points: [{}, {}] }), persist: () => {} });
  assert.equal(batch.status, "complete");
  assert.equal(batch.entries.filter((entry) => entry.stroke).length, 10);
});

test("retry only generates failed entries, preserves saved strokes and reports automatic attempts", async () => {
  const source = createSkyBatch("original", "original-request-01", selectSkyAgents(catalog.slice(0, 3), () => .42), "chaos", "order");
  // Simulate a previously published fixed-pair batch from the old version.
  delete source.mode;
  source.from = "chaos";
  source.to = "order";
  await runSkyBatch(source, {
    generate: async (agent, index) => {
      if (index === 2 || index === 8) throw Object.assign(new Error("secret-provider-payload"), { code: "timeout", attempts: 2 });
      return { id: `original-${index}`, agent_id: agent.id, points: [{}, {}] };
    }, persist: () => {},
  });
  const retry = retrySkyBatch(source, "retry", "retry-request-0001");
  assert.equal(retry.mode, "autonomous");
  assert.equal(retry.from, "");
  assert.equal(retry.to, "");
  assert.equal(retry.canvasId, source.id);
  assert.equal(retry.entries.filter((entry) => entry.status === "queued").length, 2);
  const calls = [], saved = [], frames = [];
  await runSkyBatch(retry, {
    generate: async (agent, index, onAttempt) => {
      calls.push(index);
      onAttempt(1);
      onAttempt(2);
      onAttempt(2);
      return { id: `retry-${index}`, agent_id: agent.id, points: [{}, {}] };
    }, persist: (stroke) => saved.push(stroke),
  }, () => frames.push(JSON.parse(JSON.stringify(retry))));
  assert.deepEqual(calls, [2, 8]);
  assert.equal(saved.length, 2);
  assert.equal(retry.status, "complete");
  for (let i = 0; i < 10; i++) {
    if (i !== 2 && i !== 8) assert.equal(retry.entries[i].stroke, source.entries[i].stroke);
  }
  assert.equal(source.status, "partial", "Retry must not mutate the previous result");
  assert.ok(frames.some((frame) => frame.entries.some((entry) => entry.status === "running" && entry.attempts === 2)));
  assert.equal(retry.updateSequence, 7, "Two start/retry/result triples plus final state, no duplicate attempt events");
  assert.equal(retry.entries[2].attempts, 2);
  assert.equal(retry.entries[8].attempts, 2);
  frames.forEach((frame, index) => assert.equal(frame.updateSequence, index + 1));
  assert.ok(!JSON.stringify(source).includes("secret-provider-payload"));
  assert.throws(() => retrySkyBatch(retry, "j", "r"), /finished batch/);
  const again = retrySkyBatch(source, "retry-again", "retry-request-0002");
  let duplicateCalls = 0;
  const finishedSequence = retry.updateSequence;
  await runSkyBatch(retry, { generate: () => { duplicateCalls++; throw new Error(); }, persist: () => {} });
  assert.equal(duplicateCalls, 0, "An already processed batch cannot repeat paid generations");
  assert.equal(retry.updateSequence, finishedSequence, "A no-op replay cannot look like new progress");
  assert.equal(again.entries.filter((entry) => entry.status === "queued").length, 2);
});

test("a failed durable checkpoint stops before another paid model call", async () => {
  const batch = createSkyBatch("job", "request", catalog.slice(0, 10));
  let calls = 0;
  await assert.rejects(runSkyBatch(batch, {
    generate: async agent => { calls++; return { id: "result", agent_id: agent.id, points: [{}, {}] }; },
    persist: async () => {},
  }, async () => { throw new Error("Database unavailable"); }), /Database unavailable/);
  assert.equal(calls, 0);
  assert.equal(batch.entries.filter(entry => entry.status === "succeeded").length, 0);
});

test("async persistence is awaited and a completed in-flight work is retained after cancellation", async () => {
  const batch = createSkyBatch("job", "request", catalog.slice(0, 10));
  const controller = new AbortController();
  const saved = [];
  let calls = 0;
  await runSkyBatch(batch, {
    signal: controller.signal,
    generate: async agent => { calls++; controller.abort(); return { id: "late-result", agent_id: agent.id, points: [{}, {}] }; },
    persist: async stroke => { await new Promise(setImmediate); saved.push(stroke); },
  });
  assert.equal(calls, 1);
  assert.equal(batch.status, "cleared");
  assert.equal(saved.length, 1);
  assert.equal(batch.entries[0].stroke.id, "late-result");
});
