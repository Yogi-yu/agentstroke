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
    if (name === "@/components/CanvasPlaybackControls") return { default: "fixture-playback-controls" };
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
    get progressProps() { return find((node) => node.type === "progress")?.props; },
    get activityText() { return textOf(find((node) => node.props?.className === "sky-active")); },
    get resultKeys() { return all((node) => /^sky-result /.test(node.props?.className ?? "")).map((node) => node.key); },
    get storedRequest() { return sessionStorage.getItem("noema:sky-request-id"); },
    get submitButton() { return find((node) => node.type === "button" && node.props.type === "submit"); },
    get inputs() { return all((node) => node.type === "input"); },
    get playbackControls() { return find((node) => node.type === "fixture-playback-controls"); },
    get modeButtons() { return all((node) => node.type === "button" && /Standard sky|Spherical sky/.test(textOf(node))); },
    chooseMode: (mode) => find((node) => node.type === "button" && textOf(node).includes(mode === "sphere" ? "Spherical sky" : "Standard sky")).props.onClick(),
    chooseDisplay: (mode) => find((node) => node.type === "button" && textOf(node) === (mode === "static" ? "Static · Final form" : mode === "sphere" ? "Sphere" : "Animated")).props.onClick(),
    retry: () => find((node) => node.props?.className === "sky-retry").props.onClick(),
    replay: () => find((node) => node.type === "button" && textOf(node) === "Replay sky").props.onClick(),
    get text() { return textOf(tree); },
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

module.exports = { harness, json, batch, deferred };
