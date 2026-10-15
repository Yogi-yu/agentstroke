const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const load = createTypeScriptLoader();
const { retrySkyBatch } = load("lib/skyBatch.ts");
const { acceptSkySnapshot, skyDisplayLayout, skyPresentation } = load("lib/skyPresentation.ts");

function partialBatch() {
  return {
    id: "original-canvas", requestId: "original-request", createdAt: 1,
    from: "chaos", to: "order", status: "partial",
    entries: Array.from({ length: 10 }, (_, index) => ({
      agent: { id: `agent-${index}`, name: `Agent ${index}` },
      ...(index === 2 || index === 7
        ? { status: "failed", error: "The model timed out.", attempts: 2 }
        : { status: "succeeded", stroke: { id: `stroke-${index}`, agent_id: `agent-${index}`, points: [{}, {}] } }),
    })),
  };
}

test("pending failed-only retry retains every successful stroke and the canvas identity", () => {
  const source = partialBatch();
  const before = skyPresentation(source, false, 3);
  const pending = skyPresentation(source, true, 3);
  assert.equal(pending.running, false, "The UI keeps the confirmed result until a retry job is accepted; its request button reports Starting retry");
  assert.equal(pending.showCanvas, true);
  assert.equal(pending.canvasKey, before.canvasKey);
  assert.deepEqual(pending.paths, before.paths);

  const retry = retrySkyBatch(source, "retry-job", "retry-request");
  const resumed = skyPresentation(retry, false, 3);
  assert.equal(resumed.canvasKey, before.canvasKey);
  assert.deepEqual(resumed.paths, before.paths);
  assert.equal(resumed.completed, 8);
  assert.equal(resumed.succeeded, 8);
  assert.equal(resumed.failed, 0);
  assert.equal(resumed.running, true);
});

test("a matching retry can reset progress without a stale source snapshot rewinding it", () => {
  const source = partialBatch();
  const retry = retrySkyBatch(source, "retry-job", "retry-request");
  const accepted = acceptSkySnapshot(source, retry, "retry-request");
  assert.equal(accepted, retry);
  assert.equal(acceptSkySnapshot(accepted, source, "retry-request"), accepted);
  assert.equal(acceptSkySnapshot(null, retry, "retry-request"), retry, "Refresh restores the active retry by its own request ID");
  assert.equal(skyPresentation(accepted, false).succeeded, 8);
});

test("noncontiguous retry results preserve fixed positions and do not remount existing artwork", () => {
  const source = partialBatch();
  const retry = retrySkyBatch(source, "retry-job", "retry-request");
  const originalKey = skyPresentation(source, false).canvasKey;
  const slotIds = (job) => job.entries.map((entry) => entry.stroke?.id ?? "");
  for (const portrait of [false, true]) {
    const original = skyDisplayLayout(slotIds(source), portrait);
    retry.entries[2] = { ...retry.entries[2], status: "succeeded", stroke: { id: "retry-stroke-2", agent_id: "agent-2", points: [{}, {}] } };
    const progressing = skyDisplayLayout(slotIds(retry), portrait);
    for (const [id, box] of original) assert.deepEqual(progressing.get(id), box);
    assert.equal(skyPresentation(retry, false).canvasKey, originalKey);
  }
});

test("successive partial retries retain the original canvas while Replay changes only its key", () => {
  const first = partialBatch();
  const second = retrySkyBatch(first, "second-job", "second-request");
  second.entries[2] = { ...second.entries[2], status: "succeeded", stroke: { id: "second-stroke", agent_id: "agent-2", points: [{}, {}] } };
  second.entries[7] = { ...second.entries[7], status: "failed", error: "The model timed out." };
  second.status = "partial";
  const third = retrySkyBatch(second, "third-job", "third-request");
  assert.equal(skyPresentation(third, false).canvasKey, skyPresentation(first, false).canvasKey);
  assert.equal(skyPresentation(third, false).succeeded, 9);
  assert.deepEqual(skyPresentation(third, false).paths, skyPresentation(second, false).paths);
  const replay = skyPresentation(third, false, 1);
  assert.notEqual(replay.canvasKey, skyPresentation(third, false).canvasKey);
  assert.deepEqual(replay.paths, skyPresentation(third, false).paths);
});
