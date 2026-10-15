const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const batch = (requestId = "remembered-request", revision = 0) => ({
  id: `job-${requestId}`, requestId, canvasRevision: revision, createdAt: 10 + revision,
  from: "chaos", to: "order", status: "complete",
  entries: [{ agent: { id: "fixture-agent", name: "Fixture", category: "coding" }, status: "succeeded", stroke: { id: `stroke-${requestId}`, agent_id: "fixture-agent", from: "chaos", to: "order", points: [] } }],
});

// Tiny hook harness executes the actual SkyPage event/effect code with mocked
// browser APIs. It never mounts WebGL, reaches a server or calls a model.
function harness(initialJob = batch()) {
  const originals = Object.fromEntries(["window", "document", "sessionStorage", "CustomEvent", "fetch", "setTimeout", "clearTimeout"].map((key) => [key, globalThis[key]]));
  const scheduledPolls = new Map();
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== 1500 && delay !== 5000) return originals.setTimeout(callback, delay, ...args);
    const id = {};
    scheduledPolls.set(id, () => callback(...args));
    return id;
  };
  globalThis.clearTimeout = (id) => { if (!scheduledPolls.delete(id)) originals.clearTimeout(id); };
  const storage = () => { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) }; };
  const browser = new EventTarget();
  browser.localStorage = storage();
  browser.matchMedia = () => Object.assign(new EventTarget(), { matches: false });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  globalThis.window = browser;
  globalThis.document = document;
  globalThis.sessionStorage = storage();
  globalThis.CustomEvent = class extends Event { constructor(type, options) { super(type); this.detail = options.detail; } };
  if (initialJob) sessionStorage.setItem("noema:sky-request-id", initialJob.requestId);
  let serverJob = initialJob;
  let revision = initialJob?.canvasRevision ?? 0;
  let getOverride = null;
  let post = () => { throw new Error("Unexpected mock POST"); };
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    if (options.method === "POST") return post(JSON.parse(options.body), options.signal);
    return getOverride ? getOverride() : json({ configured: true, canvasRevision: revision, job: serverJob });
  };

  const slots = [];
  let cursor = 0, dirty = true, tree, pendingEffects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (value) => {
        const next = typeof value === "function" ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; if (!slots[index]) slots[index] = { current: initial }; return slots[index]; },
    useMemo(factory, dependencies) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { value: factory(), dependencies };
      return slots[index].value;
    },
    useCallback(callback, dependencies) { return hooks.useMemo(() => callback, dependencies); },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (slots[index] && same(slots[index].dependencies, dependencies)) return;
      const previous = slots[index];
      slots[index] = { dependencies, callback, effect: true };
      pendingEffects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback(); });
    },
  };
  const load = createTypeScriptLoader();
  const reset = load("lib/canvasReset.ts");
  const source = fs.readFileSync(path.resolve(__dirname, "../app/sky/page.tsx"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name === "react") return hooks;
    if (name === "next/link") return { default: "a" };
    if (name === "@/components/CanvasView") return { default: "fixture-canvas" };
    if (name === "@/components/StrokePlayerPanel") return { default: "fixture-player" };
    if (name === "@/lib/agents") return { agentRenderStyle: () => ({}) };
    if (name.startsWith("@/")) return load(name.slice(2) + ".ts");
    return require(name);
  };
  new Function("require", "module", "exports", compiled)(localRequire, module, module.exports);
  const render = () => {
    for (let count = 0; dirty && count < 30; count++) {
      dirty = false; cursor = 0; tree = module.exports.default();
      const effects = pendingEffects; pendingEffects = []; effects.forEach((run) => run());
    }
    assert.equal(dirty, false, "Mock hook render must settle");
  };
  const settle = async () => { for (let index = 0; index < 12; index++) { await new Promise((done) => setImmediate(done)); render(); } };
  const find = (predicate, node = tree) => {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) { for (const child of node) { const match = find(predicate, child ?? null); if (match) return match; } return null; }
    return predicate(node) ? node : find(predicate, node.props?.children ?? null);
  };
  const all = (predicate, node = tree) => {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap((child) => all(predicate, child ?? null));
    return [...(predicate(node) ? [node] : []), ...all(predicate, node.props?.children ?? null)];
  };
  const textOf = (node) => typeof node === "string" || typeof node === "number" ? String(node)
    : Array.isArray(node) ? node.map(textOf).join(" ") : node?.props ? textOf(node.props.children) : "";
  render();
  return {
    settle, requests,
    get canvas() { return find((node) => node.type === "fixture-canvas"); },
    get progress() { return find((node) => node.type === "progress")?.props.value; },
    get activityText() { return textOf(find((node) => node.props?.className === "sky-active")); },
    get resultKeys() { return all((node) => /^sky-result /.test(node.props?.className ?? "")).map((node) => node.key); },
    get storedRequest() { return sessionStorage.getItem("noema:sky-request-id"); },
    get submitButton() { return find((node) => node.type === "button" && node.props.type === "submit"); },
    generate: () => find((node) => node.type === "form").props.onSubmit({ preventDefault() {} }),
    focus: () => browser.dispatchEvent(new Event("focus")),
    poll: async () => {
      const [id, callback] = scheduledPolls.entries().next().value ?? [];
      assert.ok(callback, "An active request must schedule read-only reconciliation");
      scheduledPolls.delete(id);
      await callback();
      await settle();
    },
    reset: (nextRevision) => { revision = nextRevision; serverJob = null; reset.publishCanvasReset(nextRevision); },
    signal: (value) => reset.publishCanvasReset(value),
    setGet: (callback) => { getOverride = callback; },
    setPost: (callback) => { post = callback; },
    setServer: (job, nextRevision = job?.canvasRevision ?? revision) => { serverJob = job; revision = nextRevision; },
    remountEffects: () => { for (const slot of slots) if (slot?.effect) { slot.cleanup?.(); slot.cleanup = slot.callback(); } },
    close: () => {
      for (const slot of slots) slot?.cleanup?.();
      for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    },
  };
}

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
