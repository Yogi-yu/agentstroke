const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const load = createTypeScriptLoader();
const { acceptSkySnapshot, readSkyProgress, skyDisplayLayout, skyPresentation } = load("lib/skyPresentation.ts");

function snapshot(successes = 0, failures = 0, status = "running", requestId = "new-request") {
  return {
    id: `job-${requestId}`, requestId, createdAt: 10, status,
    from: "混沌", to: "秩序",
    entries: Array.from({ length: 10 }, (_, index) => ({
      agent: { id: `agent-${index}`, name: `Agent ${index}` },
      status: index < successes ? "succeeded" : index < successes + failures ? "failed" : "queued",
      ...(index < successes ? { stroke: { id: `stroke-${index}`, agent_id: `agent-${index}` } } : {}),
      ...(index >= successes && index < successes + failures ? { error: "Model failed; no stroke saved." } : {}),
    })),
  };
}

test("empty and 0/10 states never mount a canvas; a pending new request immediately ignores the previous sky", () => {
  assert.equal(skyPresentation(null, false).showCanvas, false);
  assert.equal(skyPresentation(null, false).showProgress, false);
  const pending = skyPresentation(null, true);
  assert.equal(pending.headline, "Generating… 0/10");
  assert.equal(pending.showProgress, true);
  assert.equal(pending.showCanvas, false);
  assert.deepEqual(pending.paths, []);
  const previous = snapshot(10, 0, "complete", "old-request");
  assert.equal(acceptSkySnapshot(null, previous, null), null, "A fresh session must not import the server's latest completed sky");
  const current = acceptSkySnapshot(null, previous, "new-request");
  assert.equal(current, null, "Late latest-job GET must not resurrect the old sky");
  assert.equal(skyPresentation(current, true).showCanvas, false);
  assert.equal(skyPresentation(snapshot(), true).showCanvas, false);
});

test("mock NDJSON progressively reveals only successful strokes, preserving one canvas identity", async () => {
  const snapshots = [snapshot(), snapshot(0, 1), snapshot(1, 1), snapshot(3, 1), snapshot(9, 1, "partial")];
  const bytes = new TextEncoder().encode(snapshots.map((job) => JSON.stringify({ job })).join("\n"));
  const stream = new ReadableStream({
    start(controller) {
      for (let cursor = 0; cursor < bytes.length; cursor += 19) controller.enqueue(bytes.slice(cursor, cursor + 19));
      controller.close();
    },
  });
  let current = null;
  const frames = [];
  await readSkyProgress(stream, (job) => {
    assert.equal(job.from, "混沌");
    current = acceptSkySnapshot(current, job, "new-request");
    frames.push(skyPresentation(current, true));
  });
  assert.deepEqual(frames.map((frame) => frame.showCanvas), [false, false, true, true, true]);
  assert.deepEqual(frames.map((frame) => frame.succeeded), [0, 0, 1, 3, 9]);
  assert.deepEqual(frames.map((frame) => frame.completed), [0, 1, 2, 4, 10]);
  assert.equal(new Set(frames.filter((frame) => frame.showCanvas).map((frame) => frame.canvasKey)).size, 1);
  assert.equal(frames.at(-1).failed, 1);
  assert.equal(frames.at(-1).running, false, "A finished stream is not still generating while its HTTP connection closes");
  assert.equal(frames.at(-1).headline, "Generation finished · 10/10");
  assert.equal(frames.at(-1).paths.length, 9);
});

test("delayed polls and HMR recovery cannot rewind a live or completed batch", () => {
  const current = snapshot(4, 1);
  assert.equal(acceptSkySnapshot(current, snapshot(2), "new-request"), current);
  assert.equal(acceptSkySnapshot(current, snapshot(10, 0, "complete", "old-request"), "new-request"), current);
  const finished = snapshot(9, 1, "partial");
  assert.equal(acceptSkySnapshot(finished, snapshot(9, 1), "new-request"), finished);
  assert.equal(acceptSkySnapshot(finished, null, "new-request"), finished);
  const recovered = acceptSkySnapshot(null, current, "new-request");
  assert.equal(skyPresentation(recovered, false).running, true);
  assert.equal(skyPresentation(recovered, false).succeeded, 4);
});

test("all-failure results have honest completion but no canvas, and Replay changes only canvas identity", () => {
  const failed = skyPresentation(snapshot(0, 10, "failed"), false);
  assert.equal(failed.completed, 10);
  assert.equal(failed.failed, 10);
  assert.equal(failed.succeeded, 0);
  assert.equal(failed.showCanvas, false);
  const job = snapshot(10, 0, "complete");
  const original = skyPresentation(job, false, 0);
  const replay = skyPresentation(job, false, 1);
  assert.notEqual(original.canvasKey, replay.canvasKey);
  assert.deepEqual(original.paths, replay.paths);
  assert.equal(replay.headline, "Generation complete · 10/10");
});

test("one, five and ten results retain fixed desktop and mobile slots", () => {
  for (const portrait of [false, true]) {
    const slots = Array.from({ length: 10 }, (_, index) => `stroke-${index}`);
    const first = skyDisplayLayout(slots.map((id, index) => index === 0 ? id : ""), portrait);
    const middle = skyDisplayLayout(slots.map((id, index) => index < 5 ? id : ""), portrait);
    const full = skyDisplayLayout(slots, portrait);
    assert.equal(first.size, 1);
    assert.equal(middle.size, 5);
    assert.equal(full.size, 10);
    assert.deepEqual(first.get("stroke-0"), full.get("stroke-0"));
    for (const [id, box] of middle) assert.deepEqual(box, full.get(id));
    assert.equal(skyDisplayLayout(Array(10).fill(""), portrait).size, 0);
  }
});

test("sequence numbers prevent GET and stream reordering, including equal-score attempt updates", () => {
  const active = snapshot(2);
  active.updateSequence = 4;
  active.entries[2].status = "running";
  active.entries[2].attempts = 2;
  const stale = snapshot(2);
  stale.updateSequence = 3;
  stale.entries[2].status = "running";
  stale.entries[2].attempts = 1;
  assert.equal(acceptSkySnapshot(active, stale, "new-request"), active);
  assert.equal(acceptSkySnapshot(active, { ...active }, "new-request"), active, "Identical sequence should keep canvas data identity");
  const next = { ...active, updateSequence: 5 };
  assert.equal(acceptSkySnapshot(active, next, "new-request"), next);
  assert.equal(acceptSkySnapshot(active, snapshot(2), "new-request"), active, "Legacy snapshots cannot overwrite a newer sequenced batch");
});

test("active-stroke metadata is distinct from honest completed-stroke progress", () => {
  const job = snapshot(0);
  job.entries[0].status = "running";
  job.entries[0].startedAt = 1000;
  job.entries[0].attempts = 2;
  const result = skyPresentation(job, true);
  assert.equal(result.completed, 0);
  assert.equal(result.showCanvas, false);
  assert.equal(result.activeIndex, 0);
  assert.equal(result.activeEntry.startedAt, 1000);
  assert.equal(result.activeEntry.attempts, 2);
});
