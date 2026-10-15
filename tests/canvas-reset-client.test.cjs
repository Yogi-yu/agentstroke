const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

const agent = { id: "reset-test-agent", name: "Reset fixture", category: "research" };
const stroke = (id) => ({ id, agent_id: agent.id, from: "chaos", to: "order", points: [] });
const response = (body, ok = true) => ({ ok, json: async () => body });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(t) {
  const saved = new Map(["window", "CustomEvent", "fetch"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const browser = new EventTarget();
  const values = new Map();
  const writes = [];
  const calls = [];
  let handleFetch = () => { throw new Error("Unexpected mocked fetch"); };
  browser.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); writes.push({ key, value }); },
    removeItem: (key) => values.delete(key),
  };
  class TestCustomEvent extends Event {
    constructor(type, options = {}) {
      super(type);
      this.detail = options.detail;
    }
  }
  Object.defineProperties(globalThis, {
    window: { configurable: true, writable: true, value: browser },
    CustomEvent: { configurable: true, writable: true, value: TestCustomEvent },
    fetch: {
      configurable: true, writable: true,
      value: async (url, options = {}) => {
        const call = { url, method: options.method ?? "GET", options };
        calls.push(call);
        return handleFetch(call);
      },
    },
  });
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const load = createTypeScriptLoader();
  const reset = load("lib/canvasReset.ts");
  const { appStore } = load("state/appStore.ts");
  const remote = (value, key = reset.CANVAS_RESET_STORAGE) => {
    const event = new Event("storage");
    Object.defineProperties(event, {
      key: { value: key },
      newValue: { value: typeof value === "string" ? value : JSON.stringify(value) },
    });
    browser.dispatchEvent(event);
  };
  const local = (canvasRevision, id = "local-fixture") => browser.dispatchEvent(new TestCustomEvent(reset.CANVAS_RESET_EVENT, {
    detail: { canvasRevision, id },
  }));
  const setFetch = (handler) => { handleFetch = handler; };
  const seed = async (revision = 4, strokes = [stroke("existing")]) => {
    setFetch(({ url, method }) => {
      assert.equal(method, "GET");
      if (url === "/api/agents") return response({ agents: [agent], capacity: 10 });
      assert.equal(url, "/api/strokes");
      return response({ strokes, canvasRevision: revision });
    });
    await appStore.bootstrap();
    calls.length = 0;
  };
  return { browser, writes, calls, reset, store: appStore, remote, local, setFetch, seed };
}

test("reset signals reach this tab and storage listeners, ignoring stale or invalid revisions", (t) => {
  const h = harness(t);
  const received = [];
  const unsubscribe = h.reset.subscribeCanvasReset((signal) => received.push(signal));
  h.reset.publishCanvasReset(7);
  assert.equal(received.length, 1);
  assert.equal(received[0].canvasRevision, 7);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].key, h.reset.CANVAS_RESET_STORAGE);
  assert.deepEqual(JSON.parse(h.writes[0].value), received[0]);

  h.remote({ canvasRevision: 8, id: "other-tab" });
  h.remote({ canvasRevision: 7, id: "late-old-tab" });
  h.local(8, "same-revision-different-id");
  h.remote("not-json");
  h.remote({ canvasRevision: 9, id: "unrelated" }, "another-storage-key");
  h.local(-1);
  h.local(8.5);
  h.remote({ canvasRevision: 9, id: null });
  assert.deepEqual(received.map((signal) => signal.canvasRevision), [7, 8]);
  unsubscribe();
  h.remote({ canvasRevision: 9, id: "after-unsubscribe" });
  h.local(10);
  assert.equal(received.length, 2);
  assert.deepEqual(h.calls, [], "Signals must not issue requests");
});

test("same-tab reset still works when browser storage is unavailable", (t) => {
  const h = harness(t);
  const received = [];
  h.reset.subscribeCanvasReset((signal) => received.push(signal.canvasRevision));
  h.browser.localStorage.setItem = () => { throw new Error("Storage denied"); };
  assert.doesNotThrow(() => h.reset.publishCanvasReset(3));
  h.reset.publishCanvasReset(-1);
  h.reset.publishCanvasReset(Number.NaN);
  assert.deepEqual(received, [3]);
});

test("successful clear empties strokes, retains agents, increments resetRevision and broadcasts once", async (t) => {
  const h = harness(t);
  await h.seed();
  const events = [];
  h.reset.subscribeCanvasReset((signal) => events.push(signal));
  h.setFetch(({ url, method }) => {
    assert.equal(url, "/api/strokes");
    assert.equal(method, "DELETE");
    return response({ cleared: true, canvasRevision: 5 });
  });
  assert.equal(await h.store.clear(), true);
  const snapshot = h.store.getSnapshot();
  assert.deepEqual(snapshot.strokes, []);
  assert.deepEqual(snapshot.agents, [agent]);
  assert.equal(snapshot.resetRevision, 1);
  assert.equal(snapshot.clearing, false);
  assert.equal(snapshot.generating, false);
  assert.equal(h.calls.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].canvasRevision, 5);
  assert.equal(h.writes.length, 1);
});

test("failed DELETE preserves strokes and sends no reset signal", async (t) => {
  const h = harness(t);
  const existing = stroke("keep-on-failure");
  await h.seed(4, [existing]);
  const events = [];
  h.reset.subscribeCanvasReset((signal) => events.push(signal));
  h.setFetch(({ url, method }) => {
    assert.equal(url, "/api/strokes");
    if (method === "DELETE") return response({ error: "Failure" }, false);
    assert.equal(method, "GET");
    return response({ strokes: [existing], canvasRevision: 4 });
  });
  assert.equal(await h.store.clear(), false);
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = h.store.getSnapshot();
  assert.deepEqual(snapshot.strokes, [existing]);
  assert.deepEqual(snapshot.agents, [agent]);
  assert.equal(snapshot.resetRevision, 0);
  assert.equal(snapshot.clearing, false);
  assert.deepEqual(events, []);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.calls.map(({ method }) => method), ["DELETE", "GET"], "Recovery reads state without repeating DELETE");
});

test("an invalid clear acknowledgement cannot clear local state or publish a reset", async (t) => {
  const h = harness(t);
  const existing = stroke("keep-unconfirmed");
  await h.seed(4, [existing]);
  h.setFetch(({ method }) => method === "DELETE"
    ? response({ cleared: true, canvasRevision: "5" })
    : response({ strokes: [existing], canvasRevision: 4 }));
  assert.equal(await h.store.clear(), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.store.getSnapshot().strokes, [existing]);
  assert.equal(h.store.getSnapshot().resetRevision, 0);
  assert.deepEqual(h.writes, []);
});

test("a delayed pre-clear refresh cannot repopulate the cleared canvas", async (t) => {
  const h = harness(t);
  await h.seed();
  const pending = deferred();
  h.setFetch(({ url, method }) => {
    assert.equal(url, "/api/strokes");
    return method === "DELETE" ? response({ cleared: true, canvasRevision: 5 }) : pending.promise;
  });
  const refresh = h.store.refresh();
  assert.equal(await h.store.clear(), true);
  pending.resolve(response({ strokes: [stroke("late-refresh")], canvasRevision: 4 }));
  await refresh;
  assert.deepEqual(h.store.getSnapshot().strokes, []);
  assert.equal(h.store.getSnapshot().resetRevision, 1);
});

test("a delayed pre-clear generation response cannot restore its stroke", async (t) => {
  const h = harness(t);
  await h.seed();
  const pending = deferred();
  h.setFetch(({ url, method, options }) => {
    if (url === "/api/generateStroke") {
      assert.equal(method, "POST");
      assert.equal(JSON.parse(options.body).canvasRevision, 4);
      return pending.promise;
    }
    assert.equal(url, "/api/strokes");
    assert.equal(method, "DELETE");
    return response({ cleared: true, canvasRevision: 5 });
  });
  const generation = h.store.generate("chaos", "order", agent.id);
  assert.equal(h.store.getSnapshot().generating, true);
  assert.equal(await h.store.clear(), true);
  pending.resolve(response({ stroke: stroke("late-generation"), canvasRevision: 4 }));
  await generation;
  assert.deepEqual(h.store.getSnapshot().strokes, []);
  assert.equal(h.store.getSnapshot().generating, false);
});

test("an old generation finally cannot unset the generating flag of a newer request", async (t) => {
  const h = harness(t);
  await h.seed();
  const oldResponse = deferred();
  const newResponse = deferred();
  let generations = 0;
  h.setFetch(({ url, method, options }) => {
    if (url === "/api/generateStroke") {
      generations++;
      assert.equal(JSON.parse(options.body).canvasRevision, generations === 1 ? 4 : 5);
      return generations === 1 ? oldResponse.promise : newResponse.promise;
    }
    assert.equal(url, "/api/strokes");
    assert.equal(method, "DELETE");
    return response({ cleared: true, canvasRevision: 5 });
  });
  const oldGeneration = h.store.generate("old", "stroke", agent.id);
  await h.store.clear();
  const newGeneration = h.store.generate("new", "stroke", agent.id);
  assert.equal(h.store.getSnapshot().generating, true);
  oldResponse.resolve(response({ stroke: stroke("obsolete"), canvasRevision: 4 }));
  await oldGeneration;
  assert.equal(h.store.getSnapshot().generating, true, "Old finally must not unlock the new request");
  assert.deepEqual(h.store.getSnapshot().strokes, []);
  const current = stroke("current-generation");
  newResponse.resolve(response({ stroke: current, canvasRevision: 5 }));
  await newGeneration;
  assert.equal(h.store.getSnapshot().generating, false);
  assert.deepEqual(h.store.getSnapshot().strokes, [current]);
});

test("a new stroke at the current revision survives delayed equal or older reset signals", async (t) => {
  const h = harness(t);
  await h.seed(5, []);
  const current = stroke("created-after-reset");
  h.setFetch(({ url }) => {
    assert.equal(url, "/api/generateStroke");
    return response({ stroke: current, canvasRevision: 5 });
  });
  await h.store.generate("new", "sky", agent.id);
  h.remote({ canvasRevision: 5, id: "delayed-equal-reset" });
  h.local(4, "delayed-older-reset");
  assert.deepEqual(h.store.getSnapshot().strokes, [current]);
  assert.equal(h.store.getSnapshot().resetRevision, 0);

  h.remote({ canvasRevision: 6, id: "actual-new-reset" });
  assert.deepEqual(h.store.getSnapshot().strokes, []);
  assert.equal(h.store.getSnapshot().resetRevision, 1);
  assert.deepEqual(h.store.getSnapshot().agents, [agent]);
  h.local(6, "duplicate-new-reset");
  assert.equal(h.store.getSnapshot().resetRevision, 1);
  assert.equal(h.calls.length, 1, "Reset notifications do not initiate generation or deletion");
});
