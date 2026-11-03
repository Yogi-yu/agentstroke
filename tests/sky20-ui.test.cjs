const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { harness, json, deferred } = require("./sky-ui-harness.cjs");

function frame(requestId, completed = 0, count = 20, sequence = completed + 1) {
  const now = Date.now();
  return {
    id: `job-${requestId}`, requestId, canvasRevision: 0, mode: "autonomous",
    skyMode: count === 20 ? "sphere" : "standard", targetCount: count,
    from: "", to: "", createdAt: now - 6000, updatedAt: now, updateSequence: sequence,
    status: completed === count ? "complete" : "running",
    entries: Array.from({ length: count }, (_, index) => {
      const agent = { id: `agent-${index % 4}`, name: `Agent ${index % 4}`, category: "coding" };
      return {
        agent, status: index < completed ? "succeeded" : index === completed ? "running" : "queued",
        ...(index < completed ? { stroke: { id: `stroke-${requestId}-${index}`, agent_id: agent.id, from: "spark", to: "horizon", points: [{}, {}] } } : {}),
        ...(index === completed ? { startedAt: now - 1000, attempts: 1 } : {}),
      };
    }),
  };
}

test("Spherical sky submits exactly one twenty-stroke request and shows 0/20 before its first frame", async () => {
  const app = harness(null);
  const pending = deferred();
  try {
    await app.settle();
    assert.match(app.text, /Generate 10 strokes/);
    assert.equal(app.canvas, null);
    app.chooseMode("sphere");
    await app.settle();
    assert.match(app.text, /Generate 20 strokes/);
    assert.equal(app.requests.filter(request => request.method === "POST").length, 0);
    assert.equal(app.canvas, null, "Choosing the mode alone must not show a fabricated sky");
    app.setPost(body => {
      assert.equal(body.mode, "autonomous");
      assert.equal(body.skyMode, "sphere");
      assert.equal(Object.hasOwn(body, "count"), false, "Server chooses the allowed count from the mode");
      return pending.promise;
    });
    app.generate();
    await app.settle();
    assert.equal(app.progressProps.value, 0);
    assert.equal(app.progressProps.max, 20);
    assert.match(app.text, /Generating… 0\/20/);
    assert.ok(app.modeButtons.every(button => button.props.disabled));
    app.chooseMode("standard");
    app.generate();
    await app.settle();
    assert.equal(app.progressProps.max, 20);
    assert.equal(app.requests.filter(request => request.method === "POST").length, 1);
    pending.resolve(json({ job: frame(app.storedRequest, 20) }));
    await app.settle();
    assert.equal(app.canvas.props.paths.length, 20);
  } finally { app.close(); }
});

test("twenty progressive results appear one by one with correct percentages and a stable spherical canvas", async () => {
  const app = harness(null);
  let controller;
  try {
    await app.settle();
    app.chooseMode("sphere"); await app.settle();
    app.setPost(() => new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "Content-Type": "application/x-ndjson" } }));
    app.generate(); await app.settle();
    const requestId = app.storedRequest;
    let canvasKey;
    for (let completed = 0; completed <= 20; completed++) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ job: frame(requestId, completed) }) + "\n"));
      await app.settle();
      assert.equal(app.progress, completed);
      assert.equal(app.progressProps.max, 20);
      assert.match(app.progressProps["aria-valuetext"], new RegExp(`^${completed}/20 completed`));
      if (completed === 0) { assert.equal(app.canvas, null); continue; }
      assert.equal(app.canvas.props.paths.length, completed);
      assert.equal(app.canvas.props.displayMode, "sphere");
      assert.equal(app.canvas.props.motionSpeed, 1);
      assert.equal(app.canvas.props.trailRetention, 0.2);
      canvasKey ??= app.canvas.key;
      assert.equal(app.canvas.key, canvasKey);
      assert.equal(app.resultKeys.length, 20);
      assert.equal(new Set(app.resultKeys).size, 20);
      if (completed === 10) assert.match(app.text, /50\s*%/);
    }
    assert.match(app.text, /Generation complete · 20\/20/);
    assert.match(app.text, /100\s*%/);
    assert.equal(app.canvas.props.agents.length, 4, "Twenty slots do not create twenty agents");
    assert.equal(app.submitButton.props.disabled, false);
  } finally { controller?.close(); await app.settle(); app.close(); }
});

test("restored spherical work selects Sphere once while later polls respect the user's presentation choice", async () => {
  const restored = frame("saved-spherical-job", 20);
  const app = harness(restored);
  try {
    await app.settle();
    assert.equal(app.canvas.props.displayMode, "sphere");
    app.chooseDisplay("static"); await app.settle();
    app.setServer({ ...restored, updateSequence: 100 });
    app.focus(); await app.settle();
    assert.equal(app.canvas.props.displayMode, "static");
    app.playbackControls.props.onMotionSpeedChange(2);
    app.playbackControls.props.onTrailRetentionChange(0.45);
    await app.settle();
    assert.equal(app.canvas.props.motionSpeed, 2);
    assert.equal(app.canvas.props.trailRetention, 0.45);
    app.chooseMode("standard"); await app.settle();
    assert.match(app.text, /Generate 10 strokes/);
    assert.equal(app.progressProps.max, 20, "Displayed job totals stay twenty when choosing the next ten-stroke generation");
    assert.match(app.text, /Generation complete · 20\/20/);
    assert.equal(app.requests.filter(request => request.method === "POST").length, 0);
  } finally { app.close(); }
});

test("retrying a partial twenty-stroke sky preserves its original count even after selecting Standard sky", async () => {
  const partial = frame("partial-spherical-job", 20);
  partial.status = "partial";
  for (const index of [3, 7, 14]) partial.entries[index] = { agent: partial.entries[index].agent, status: "failed", error: "Model unavailable." };
  const app = harness(partial);
  try {
    await app.settle();
    app.chooseMode("standard"); await app.settle();
    app.setPost(body => {
      assert.equal(body.skyMode, "sphere");
      assert.equal(body.retryOf, partial.requestId);
      const retry = { ...partial, id: `retry-${body.requestId}`, requestId: body.requestId, canvasId: partial.id, status: "running", updateSequence: 1 };
      retry.entries = partial.entries.map(entry => entry.status === "failed" ? { agent: entry.agent, status: "queued" } : entry);
      return json({ job: retry });
    });
    app.retry(); await app.settle();
    assert.equal(app.progressProps.max, 20);
    assert.equal(app.progress, 17);
    assert.equal(app.canvas.props.paths.length, 17);
    assert.equal(app.requests.filter(request => request.method === "POST").length, 1);
    assert.ok(app.modeButtons.every(button => button.props.disabled));
  } finally { app.close(); }
});

test("Sky exposes both English generation modes and compact controls without making mode changes a generation request", () => {
  const source = fs.readFileSync(path.join(__dirname, "../app/sky/page.tsx"), "utf8");
  assert.match(source, /Standard sky/);
  assert.match(source, /Spherical sky/);
  assert.match(source, /20 strokes · One rotating sphere/);
  assert.match(source, /presentedCanvasRef\.current !== identity/);
  assert.match(source, /generationLocked = running \|\| requesting \|\| needsRecovery/);
  assert.match(source, /motionSpeed=\{motionSpeed\} sphereControls=\{sphereControls\}/);
  assert.match(source, /<CanvasPlaybackControls/);
  assert.doesNotMatch(source, /completed \* 10|max=\{SKY_BATCH_SIZE\}|\$\{completed\}\/10/);
});

test("Replay sky resumes paused strokes without changing automatic rotation or generating again", async () => {
  const app = harness(frame("replay-spherical-job", 20));
  try {
    await app.settle();
    const originalPaths = app.canvas.props.paths;
    const originalKey = app.canvas.key;
    app.playbackControls.props.onSphereControlsChange({ autoRotate: false, playing: false, resetKey: 3 });
    await app.settle();
    assert.equal(app.canvas.props.sphereControls.playing, false);
    app.replay(); await app.settle();
    assert.equal(app.canvas.props.sphereControls.playing, true);
    assert.equal(app.canvas.props.sphereControls.autoRotate, false);
    assert.equal(app.canvas.props.sphereControls.resetKey, 3);
    assert.notEqual(app.canvas.key, originalKey);
    assert.deepEqual(app.canvas.props.paths, originalPaths);
    assert.equal(app.requests.filter(request => request.method === "POST").length, 0);
  } finally { app.close(); }
});
