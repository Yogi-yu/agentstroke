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
  }, () => { throw new Error("disconnected browser"); });
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
  await runSkyBatch(source, {
    generate: async (agent, index) => {
      if (index === 2 || index === 8) throw Object.assign(new Error("secret-provider-payload"), { code: "timeout", attempts: 2 });
      return { id: `original-${index}`, agent_id: agent.id, points: [{}, {}] };
    }, persist: () => {},
  });
  const retry = retrySkyBatch(source, "retry", "retry-request-0001");
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

test("batch API GET is read-only and POST deduplicates requests, rejects overlap and streams progress", async () => {
  // These replacements run only in this isolated Node process. No network or
  // real provider call is made, and no running application's store is touched.
  const client = load("lib/openrouter/client.ts");
  const generator = load("lib/strokegen.ts");
  const store = load("lib/store.ts");
  const { makeAgents } = load("lib/agents.ts");
  const agents = makeAgents();
  let availableAgents = [];
  let calls = 0;
  let active = 0;
  let peak = 0;
  let failRemaining = 0;
  const saved = [];
  client.hasOpenRouterKey = () => true;
  store.listAgents = () => availableAgents;
  store.ensureCatalogAgents = () => { throw new Error("Sky must never create or attract agents"); };
  store.listStrokes = () => saved;
  store.addStroke = (stroke) => { saved.push(stroke); return stroke; };
  generator.generateStroke = async (agent, from, to, timestamp, previous, options) => {
    assert.equal(options.requireModel, true);
    active++;
    peak = Math.max(peak, active);
    const index = calls++;
    const fail = failRemaining-- > 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    if (fail) throw Object.assign(new Error("provider timeout"), { code: "timeout" });
    options.onAttempt(2);
    return { id: `api-stroke-${index}`, agent_id: agent.id, from, to, timestamp, points: [{}, {}] };
  };
  // This API mock supplies an empty canvas, independently of release artwork.
  globalThis.__noemaSkyBatches = {
    jobs: new Map(), seenRequestIds: new Set(), activeId: null, latestId: null,
    canvasRevision: 0, controllers: new Map(),
  };
  const route = load("app/api/skyBatch/route.ts");
  const url = "http://localhost:3000/api/skyBatch";
  const request = (requestId, extra = {}) => new Request(url, { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify({ requestId, from: "chaos", to: "order", ...extra }) });
  const empty = await (await route.GET(new Request(url))).json();
  assert.equal(empty.job, null);
  assert.equal(calls, 0);

  const noAgents = await route.POST(request("empty-pool-request-00"));
  assert.equal(noAgents.status, 409);
  assert.equal((await noAgents.json()).code, "empty_agent_pool");
  assert.equal(calls, 0);
  assert.equal(globalThis.__noemaSkyBatches.jobs.size, 0);
  availableAgents = agents.slice(0, 3);
  const poolBefore = JSON.stringify(availableAgents);
  assert.ok(route.maxDuration >= 600, "The route accommodates ten sequential 60-second slots");

  const first = await route.POST(request("first-request-0001"));
  assert.match(first.headers.get("content-type"), /ndjson/);
  const reused = await (await route.POST(request("first-request-0001"))).json();
  assert.equal(reused.reused, true);
  const overlap = await route.POST(request("other-request-0002"));
  assert.equal(overlap.status, 409);
  const frames = (await first.text()).trim().split("\n").map(JSON.parse);
  assert.equal(calls, 10);
  assert.equal(saved.length, 10);
  assert.equal(peak, 1);
  assert.equal(JSON.stringify(availableAgents), poolBefore);
  assert.equal(frames[0].job.entries.filter((entry) => entry.status === "queued").length, 10);
  assert.equal(frames.at(-1).job.status, "complete");
  assert.equal(frames.at(-1).job.entries.length, 10);
  assert.equal(new Set(frames.at(-1).job.entries.map((entry) => entry.agent.id)).size, 3);
  assert.ok(frames.every((frame) => frame.job.entries.filter((entry) => entry.status === "running").length <= 1));
  frames.forEach((frame, index) => {
    assert.equal(frame.job.updateSequence, index);
    if (index > 0) assert.ok(frame.job.updatedAt >= frames[index - 1].job.updatedAt);
  });

  const replayed = await (await route.POST(request("first-request-0001"))).json();
  assert.equal(replayed.reused, true);
  assert.equal(calls, 10);
  const restored = await (await route.GET(new Request(url))).json();
  assert.equal(restored.job.status, "complete");
  assert.equal(calls, 10);
  client.hasOpenRouterKey = () => false;
  const unconfigured = await route.POST(request("no-provider-key-0003"));
  assert.equal(unconfigured.status, 503);
  assert.equal(calls, 10);
  globalThis.__noemaSkyBatches.jobs.delete("first-request-0001");
  client.hasOpenRouterKey = () => true;
  const expiredReplay = await route.POST(request("first-request-0001"));
  assert.equal(expiredReplay.status, 409);
  assert.equal(calls, 10, "Evicting a large result must not permit a duplicate paid request");

  failRemaining = 2;
  const partialResponse = await route.POST(request("partial-request-0004"));
  const partial = (await partialResponse.text()).trim().split("\n").map(JSON.parse).at(-1).job;
  assert.equal(partial.status, "partial");
  assert.equal(calls, 20);
  const preservedIds = partial.entries.flatMap((entry) => entry.stroke ? [entry.stroke.id] : []);
  assert.equal(preservedIds.length, 8);
  const retryResponse = await route.POST(request("retry-request-0005", { retryOf: partial.requestId }));
  const duplicateRetry = await (await route.POST(request("retry-request-0005", { retryOf: partial.requestId }))).json();
  assert.equal(duplicateRetry.reused, true);
  const staleRetry = await route.POST(request("stale-retry-request-06", { retryOf: partial.requestId }));
  assert.equal(staleRetry.status, 409);
  assert.equal((await staleRetry.json()).code, "already_retried");
  const retryFrames = (await retryResponse.text()).trim().split("\n").map(JSON.parse);
  assert.equal(calls, 22, "Retry calls only the two failed stroke slots");
  assert.equal(saved.length, 20, "The eight prior successes are not saved twice");
  assert.equal(retryFrames[0].job.entries.filter((entry) => entry.status === "succeeded").length, 8);
  const complete = retryFrames.at(-1).job;
  assert.equal(complete.status, "complete");
  assert.equal(complete.canvasId, partial.id);
  assert.ok(preservedIds.every((id) => complete.entries.some((entry) => entry.stroke?.id === id)));
  const refreshedOriginal = await (await route.GET(new Request(`${url}?requestId=${partial.requestId}`))).json();
  assert.equal(refreshedOriginal.resumedFrom, partial.requestId);
  assert.equal(refreshedOriginal.job.requestId, complete.requestId, "Refreshing the original failed batch resumes its completed retry");
  assert.equal(calls, 22, "Recovery GET must never trigger model calls");
  for (const [id, extra, status] of [
    ["complete-retry-request-07", { retryOf: complete.requestId }, 409],
    ["missing-retry-request-008", { retryOf: "unavailable-request-00" }, 404],
    ["malformed-retry-request-9", { retryOf: 123 }, 400],
    ["stale-retry-request-0010", { retryOf: partial.requestId }, 409],
  ]) assert.equal((await route.POST(request(id, extra))).status, status);
  assert.equal(calls, 22, "Invalid or stale retries never call models");
});
