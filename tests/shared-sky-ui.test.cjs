const test = require("node:test");
const assert = require("node:assert/strict");
const { harness, batch, json, deferred } = require("./sky-ui-harness.cjs");

test("a fresh device without a remembered request displays the public sky with GET only", async () => {
  const app = harness(batch("desktop-created-sky"), { rememberedRequest: null });
  try {
    await app.settle();
    assert.equal(app.canvas.props.paths[0].id, "stroke-desktop-created-sky");
    assert.match(app.text, /The latest public batch.*No login/);
    assert.ok(app.requests.every(request => request.url === "/api/skyBatch" && request.method !== "POST"));
  } finally { app.close(); }
});

test("stale browser storage never pins a phone to an obsolete or cleared batch", async () => {
  const app = harness(batch("new-public-sky"), { rememberedRequest: "obsolete-private-sky" });
  try {
    await app.settle();
    assert.equal(app.canvas.props.paths[0].id, "stroke-new-public-sky");
    assert.ok(app.requests.every(request => !request.url.includes("requestId=")));
  } finally { app.close(); }
});

test("an initially empty device polls and discovers another visitor's newly generated sky", async () => {
  const app = harness(null);
  try {
    await app.settle();
    assert.equal(app.canvas, null);
    app.setServer(batch("other-visitor-sky"));
    await app.poll();
    assert.equal(app.canvas.props.paths[0].id, "stroke-other-visitor-sky");
    app.setServer(batch("newer-shared-sky"));
    await app.poll();
    assert.equal(app.canvas.props.paths[0].id, "stroke-newer-shared-sky");
    assert.equal(app.requests.filter(request => request.method === "POST").length, 0);
  } finally { app.close(); }
});

test("a public clear followed by a new batch is accepted together without waiting for a second poll", async () => {
  const app = harness(batch("old-sky"));
  try {
    await app.settle();
    app.setServer(batch("after-clear", 1), 1);
    await app.poll();
    assert.equal(app.canvas.props.paths[0].id, "stroke-after-clear");
    assert.equal(app.storedRequest, "after-clear");
  } finally { app.close(); }
});

test("a stale null GET cannot erase a newer successful snapshot at the same revision", async () => {
  const app = harness(batch("saved-sky"));
  const old = deferred(), latest = deferred();
  try {
    await app.settle();
    let reads = 0;
    app.setGet(() => ++reads === 1 ? old.promise : latest.promise);
    app.focus(); app.focus();
    latest.resolve(json({ configured: true, canvasRevision: 0, job: batch("saved-sky") }));
    await app.settle();
    old.resolve(json({ configured: true, canvasRevision: 0, job: null }));
    await app.settle();
    assert.equal(app.canvas.props.paths[0].id, "stroke-saved-sky");
  } finally { app.close(); }
});

test("a latest GET cannot restore the previous sky while a local POST is not registered yet", async () => {
  const app = harness(batch("previous-sky"));
  const pending = deferred();
  try {
    await app.settle();
    app.setPost(() => pending.promise);
    app.generate(); await app.settle();
    const requestId = app.storedRequest;
    await app.poll();
    assert.equal(app.canvas, null);
    assert.equal(app.storedRequest, requestId);
    assert.equal(app.submitButton.props.disabled, true);
    pending.resolve(json({ job: batch(requestId) }));
    await app.settle();
    assert.equal(app.canvas.props.paths[0].id, `stroke-${requestId}`);
  } finally { app.close(); }
});

test("a concurrent generation conflict follows the winning public batch instead of showing an old private result", async () => {
  const app = harness(batch("previous-sky"));
  try {
    await app.settle();
    const winner = { ...batch("winning-public-sky"), status: "running", updateSequence: 1 };
    app.setPost(() => json({ code: "active", job: winner }, 409));
    app.generate(); await app.settle();
    assert.equal(app.canvas.props.paths[0].id, "stroke-winning-public-sky");
    assert.equal(app.submitButton.props.disabled, true);
    assert.match(app.text, /Another visitor is generating this shared sky/);
    app.setServer({ ...winner, status: "complete", updateSequence: 2 });
    await app.poll();
    assert.equal(app.submitButton.props.disabled, false);
    assert.equal(app.requests.filter(request => request.method === "POST").length, 1);
  } finally { app.close(); }
});

test("a GET captured before POST commit cannot rewind a newly completed public batch", async () => {
  const previous = batch("previous-sky");
  const app = harness(previous);
  const pendingPost = deferred(), pendingRead = deferred();
  try {
    await app.settle();
    app.setPost(() => pendingPost.promise);
    app.generate(); await app.settle();
    const requestId = app.storedRequest;
    app.setGet(() => pendingRead.promise);
    app.focus();
    const current = { ...batch(requestId), createdAt: previous.createdAt + 100 };
    pendingPost.resolve(json({ job: current }));
    await app.settle();
    pendingRead.resolve(json({ configured: true, canvasRevision: 0, job: previous }));
    await app.settle();
    assert.equal(app.canvas.props.paths[0].id, `stroke-${requestId}`);
    assert.equal(app.storedRequest, requestId);
  } finally { app.close(); }
});
