const test = require("node:test");
const assert = require("node:assert/strict");
const { harness, json, batch, deferred } = require("./sky-ui-harness.cjs");

test("Sky has no preset endpoint inputs, sends autonomous mode, and shows each agent's own journey", async () => {
  const app = harness(null);
  try {
    await app.settle();
    assert.deepEqual(app.inputs, []);
    assert.match(app.text, /Each agent chooses its own starting word/);
    app.setPost((body) => {
      assert.equal(body.mode, "autonomous");
      assert.equal(Object.hasOwn(body, "from"), false);
      assert.equal(Object.hasOwn(body, "to"), false);
      const job = batch(body.requestId);
      job.entries[0].stroke = { ...job.entries[0].stroke, from: "attention", to: "kinship", points: [{}, {}, {}, {}, {}] };
      job.entries.push({ ...job.entries[0], stroke: { ...job.entries[0].stroke, id: "another-route", from: "latency", to: "silence", points: [{}, {}] } });
      app.setServer(job);
      return json({ job });
    });
    app.generate();
    await app.settle();
    assert.match(app.text, /attention\s+→\s+kinship\s+·\s+5\s+steps/);
    assert.match(app.text, /latency\s+→\s+silence\s+·\s+2\s+steps/);
    assert.equal(app.canvas.props.paths.length, 2);
  } finally { app.close(); }
});

test("reset removes Sky immediately, late GET cannot restore it, and old signals preserve a newly generated sky", async () => {
  const app = harness();
  try {
    await app.settle();
    assert.equal(app.canvas.props.paths.length, 1);
    const oldRead = deferred();
    app.setGet(() => oldRead.promise);
    app.focus();
    app.reset(1);
    await app.settle();
    assert.equal(app.canvas, null);
    assert.equal(app.storedRequest, null);
    oldRead.resolve(json({ configured: true, canvasRevision: 0, job: batch() }));
    await app.settle();
    assert.equal(app.canvas, null);
    app.setGet(null);
    app.setPost((body) => {
      assert.equal(body.canvasRevision, 1);
      const job = batch(body.requestId, 1);
      app.setServer(job);
      return new Response(JSON.stringify({ job }) + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
    });
    app.generate();
    await app.settle();
    const id = app.canvas.props.paths[0].id;
    app.signal(0); app.signal(1);
    await app.settle();
    assert.equal(app.canvas.props.paths[0].id, id);
  } finally { app.close(); }
});

test("clear during a pending POST blocks stale rejection restore and its finally cannot unlock a new request", async () => {
  const app = harness(null);
  try {
    await app.settle();
    const old = deferred(), current = deferred();
    let oldSignal;
    app.setPost((body, signal) => { oldSignal = signal; return old.promise; });
    app.generate();
    app.reset(1);
    await app.settle();
    assert.equal(oldSignal.aborted, true);
    assert.equal(app.storedRequest, null);
    app.setPost(() => current.promise);
    app.generate();
    await app.settle();
    const newRequest = app.storedRequest;
    old.resolve(json({ code: "already_retried", job: batch(), error: "Already retried" }, 409));
    await app.settle();
    assert.equal(app.canvas, null);
    assert.equal(app.storedRequest, newRequest);
    assert.equal(app.submitButton.props.disabled, true);
    current.resolve(json({ job: batch(newRequest, 1) }));
    await app.settle();
    assert.equal(app.canvas.props.paths[0].id, `stroke-${newRequest}`);
  } finally { app.close(); }
});

test("a focus read cannot cancel an unregistered POST at the same revision; a cleared stream does reset", async () => {
  const app = harness(null);
  try {
    await app.settle();
    const pending = deferred();
    let signal, requestId;
    app.setPost((body, value) => { requestId = body.requestId; signal = value; return pending.promise; });
    app.generate();
    app.focus();
    await app.settle();
    assert.equal(signal.aborted, false);
    assert.equal(app.storedRequest, requestId);
    const ready = batch(requestId);
    const cleared = { ...ready, status: "cleared", entries: [], canvasRevision: 1 };
    pending.resolve(new Response(JSON.stringify({ job: ready }) + "\n" + JSON.stringify({ job: cleared }) + "\n", { headers: { "Content-Type": "application/x-ndjson" } }));
    await app.settle();
    assert.equal(app.canvas, null);
    assert.equal(app.storedRequest, null);
  } finally { app.close(); }
});

test("completed sky disappears on authoritative missing-job recovery without a browser reset signal", async () => {
  const legacy = batch();
  delete legacy.canvasRevision;
  const app = harness(legacy);
  try {
    await app.settle();
    assert.ok(app.canvas);
    app.setServer(null, 0);
    app.focus();
    await app.settle();
    assert.equal(app.canvas, null);
    assert.equal(app.storedRequest, null);
    app.remountEffects();
    await app.settle();
    assert.equal(app.submitButton.props.disabled, false);
  } finally { app.close(); }
});

test("a stale POST revision is rejected without restoring its old sky or request ID", async () => {
  const app = harness();
  try {
    await app.settle();
    app.setPost(() => json({ code: "canvas_cleared", canvasRevision: 1, error: "The canvas was cleared." }, 409));
    app.generate();
    await app.settle();
    assert.equal(app.canvas, null);
    assert.equal(app.storedRequest, null);
    assert.equal(app.submitButton.props.disabled, false);
  } finally { app.close(); }
});

test("StrictMode or HMR cleanup aborts a pending stream without leaving the page permanently busy", async () => {
  const app = harness(null);
  try {
    await app.settle();
    const pending = deferred();
    let signal, calls = 0;
    app.setPost((body, requestSignal) => { signal = requestSignal; calls++; return pending.promise; });
    app.generate();
    await app.settle();
    app.remountEffects();
    await app.settle();
    assert.equal(signal.aborted, true);
    app.setPost((body) => { calls++; return json({ job: batch(body.requestId) }); });
    app.generate();
    await app.settle();
    assert.equal(calls, 2);
    assert.ok(app.canvas);
    pending.resolve(json({ job: batch("obsolete-request") }));
    await app.settle();
    assert.notEqual(app.canvas.props.paths[0].id, "stroke-obsolete-request");
  } finally { app.close(); }
});

function strokeFrame(requestId, completed, sequence = completed + 1) {
  const now = Date.now();
  return {
    ...batch(requestId), createdAt: now - 6000, updatedAt: now, updateSequence: sequence,
    status: completed === 10 ? "complete" : "running",
    entries: Array.from({ length: 10 }, (_, index) => {
      const agent = { id: `author-${index % 3}`, name: `Author ${index % 3}`, category: "coding" };
      return {
        agent, status: index < completed ? "succeeded" : index === completed ? "running" : "queued",
        ...(index < completed ? { stroke: { id: `stroke-${index}`, agent_id: agent.id, from: "chaos", to: "order", points: [] } } : {}),
        ...(index === completed ? { startedAt: now - 2000, attempts: 1 } : {}),
      };
    }),
  };
}

test("ten separate stream frames append one stroke at a time, retain canvas identity and support repeated authors", async () => {
  const app = harness(null);
  let controller;
  try {
    await app.settle();
    app.setPost(() => new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "Content-Type": "application/x-ndjson" } }));
    app.generate();
    await app.settle();
    const requestId = app.storedRequest;
    const emit = (frame) => controller.enqueue(new TextEncoder().encode(JSON.stringify({ job: frame }) + "\n"));
    emit(strokeFrame(requestId, 0));
    await app.settle();
    assert.equal(app.progress, 0);
    assert.equal(app.canvas, null);
    assert.match(app.activityText, /Creating stroke 1 of 10/);
    assert.match(app.activityText, /Author 0.*Attempt 1.*2s\s+elapsed/);
    let canvasKey;
    const previousIds = [];
    for (let completed = 1; completed <= 10; completed++) {
      emit(strokeFrame(requestId, completed));
      await app.settle();
      assert.equal(app.progress, completed);
      assert.equal(app.canvas.props.paths.length, completed);
      assert.deepEqual(app.canvas.props.paths.slice(0, -1).map((stroke) => stroke.id), previousIds);
      previousIds.push(`stroke-${completed - 1}`);
      canvasKey ??= app.canvas.key;
      assert.equal(app.canvas.key, canvasKey);
      assert.equal(app.canvas.props.agents.length, 3, "Repeated authors do not duplicate Canvas agent identities");
      assert.equal(app.resultKeys.length, 10);
      assert.equal(new Set(app.resultKeys).size, 10, "React rows are keyed by stroke slots, not author IDs");
    }
    assert.equal(app.submitButton.props.disabled, false);
  } finally { controller?.close(); await app.settle(); app.close(); }
});

test("an open stalled stream still polls, appends server results, and ignores late out-of-order frames", async () => {
  const app = harness(null);
  let controller, signal;
  try {
    await app.settle();
    app.setPost((body, requestSignal) => {
      signal = requestSignal;
      return new Response(new ReadableStream({ start(value) {
        controller = value;
        value.enqueue(new TextEncoder().encode(JSON.stringify({ job: strokeFrame(body.requestId, 0, 1) }) + "\n"));
      } }), { headers: { "Content-Type": "application/x-ndjson" } });
    });
    app.generate();
    await app.settle();
    const requestId = app.storedRequest;
    app.setServer(strokeFrame(requestId, 3, 5));
    await app.poll();
    assert.equal(app.canvas.props.paths.length, 3);
    assert.equal(app.progress, 3);
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ job: strokeFrame(requestId, 1, 2) }) + "\n"));
    await app.settle();
    assert.equal(app.progress, 3);
    app.setServer(strokeFrame(requestId, 10, 12));
    await app.poll();
    assert.equal(app.canvas.props.paths.length, 10);
    assert.equal(app.submitButton.props.disabled, false);
    assert.equal(signal.aborted, true, "Confirmed completion releases a buffered transport");
    assert.equal(app.requests.filter((request) => request.method === "POST").length, 1);
  } finally { controller?.close(); await app.settle(); app.close(); }
});

test("polling starts before the POST has returned its first frame and never repeats generation", async () => {
  const app = harness(null);
  const pending = deferred();
  try {
    await app.settle();
    app.setPost(() => pending.promise);
    app.generate();
    await app.settle();
    const requestId = app.storedRequest;
    assert.equal(app.progress, 0);
    app.setServer(strokeFrame(requestId, 1, 3));
    await app.poll();
    assert.equal(app.progress, 1);
    assert.equal(app.canvas.props.paths.length, 1);
    assert.equal(app.requests.filter((request) => request.method === "POST").length, 1);
  } finally { app.close(); }
});
