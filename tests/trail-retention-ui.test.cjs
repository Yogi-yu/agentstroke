const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

const storageKey = "noema.snapshot.trail-retention";

// Run the real Studio component and slider with mocked hooks, storage and
// CanvasView. The harness never starts a server, runs WebGL or generates art.
function studioHarness({ saved = null, storageUnavailable = false } = {}) {
  const values = new Map(saved === null ? [] : [[storageKey, saved]]);
  const writes = [];
  const storage = {
    getItem(key) { if (storageUnavailable) throw new Error("Storage unavailable"); return values.get(key) ?? null; },
    setItem(key, value) { if (storageUnavailable) throw new Error("Storage unavailable"); values.set(key, value); writes.push([key, value]); },
  };
  const snapshot = {
    agents: [{ id: "agent", category: "coding" }],
    strokes: [{ id: "stroke", agent_id: "agent", from: "chaos", to: "order", points: [] }],
    ready: true, resetRevision: 0,
  };
  const calls = [];
  const appStore = new Proxy({}, { get: (_, method) => () => { calls.push(method); } });
  const slots = [];
  let cursor = 0, dirty = true, pendingEffects = [], tree;
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
    useRef(initial) { const index = cursor++; return slots[index] ?? (slots[index] = { current: initial }); },
    useId() { return "trail-retention-test"; },
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
      slots[index] = { dependencies };
      pendingEffects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback(); });
    },
  };
  const pureLoad = createTypeScriptLoader();
  const loadUI = (file) => {
    const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "..", file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const module = { exports: {} };
    const localRequire = (name) => {
      if (name === "react") return hooks;
      if (name === "next/link") return { default: "a" };
      if (name.startsWith("@/components/")) return { default: name.slice("@/components/".length) };
      if (name === "@/lib/agents") return { agentRenderStyle: () => ({ hue: 200 }) };
      if (name === "@/state/appStore") return { useApp: () => snapshot, appStore };
      if (name.startsWith("@/")) return pureLoad(name.slice(2) + ".ts");
      return require(name);
    };
    new Function("require", "module", "exports", "window", "localStorage", "setInterval", "clearInterval", compiled)(
      localRequire, module, module.exports, new EventTarget(), storage, () => 1, () => {},
    );
    return module.exports.default;
  };
  const Home = loadUI("app/studio/page.tsx");
  const Control = loadUI("components/TrailRetentionControl.tsx");
  const find = (predicate, node = tree) => {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) { for (const child of node) { const found = find(predicate, child ?? null); if (found) return found; } return null; }
    return predicate(node) ? node : find(predicate, node.props?.children ?? null);
  };
  const textOf = (node) => typeof node === "string" || typeof node === "number" ? String(node)
    : Array.isArray(node) ? node.map(textOf).join("") : node?.props ? textOf(node.props.children) : "";
  const render = () => {
    for (let count = 0; dirty && count < 30; count++) {
      dirty = false; cursor = 0; tree = Home();
      const effects = pendingEffects; pendingEffects = []; effects.forEach((run) => run());
    }
    assert.equal(dirty, false, "Studio hooks must settle");
  };
  const control = () => find((node) => node.type === "TrailRetentionControl");
  const sliderTree = () => control() ? Control(control().props) : null;
  render();
  return {
    render, calls, writes, values,
    get canvas() { return find((node) => node.type === "CanvasView"); },
    get control() { return control(); },
    get slider() { return find((node) => node.type === "input", sliderTree()); },
    get hint() { return textOf(find((node) => node.props?.className === "snapshot-trail-hint", sliderTree())); },
    get output() { return textOf(find((node) => node.type === "output", sliderTree())); },
    get label() { return find((node) => node.type === "label", sliderTree()); },
    input(value) { this.slider.props.onChange({ currentTarget: { value } }); render(); },
    change(value) { control().props.onChange(value); render(); },
    click(label) {
      const button = find((node) => node.type === "button" && textOf(node.props.children) === label);
      assert.ok(button, `Button exists: ${label}`); button.props.onClick(); render();
    },
    edit() { this.canvas.props.onRequestEdit("stroke"); render(); },
    close() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test("Studio defaults to 20 percent and the accessible native range updates CanvasView live without remounting", () => {
  const app = studioHarness();
  try {
    const canvas = app.canvas;
    assert.equal(canvas.props.trailRetention, 0.2);
    assert.equal(app.output, "20%");
    assert.equal(app.slider.props.min, 20);
    assert.equal(app.slider.props.max, 80);
    assert.equal(app.slider.props.step, 1, "Native keyboard arrows change retention by one percent");
    assert.equal(app.label.props.htmlFor, app.slider.props.id);
    assert.equal(app.label.props.children, "Trail retention");
    assert.equal(app.slider.props["aria-valuetext"], "20% of the stroke");
    assert.ok(app.slider.props["aria-describedby"]);
    assert.equal(app.writes.length, 0, "Mount must not overwrite a saved preference before reading it");

    for (const [input, fraction] of [["20", 0.2], ["53", 0.53], ["80", 0.8]]) {
      app.input(input);
      assert.equal(app.canvas.props.trailRetention, fraction);
      assert.equal(app.output, `${input}%`);
      assert.equal(app.values.get(storageKey), String(fraction));
      assert.equal(app.canvas.key, canvas.key, "Retention must not remount the canvas");
      assert.equal(app.canvas.props.paths, canvas.props.paths, "Retention must not replace or mutate strokes");
      assert.equal(app.canvas.props.agents, canvas.props.agents);
      assert.equal(app.canvas.props.playback, undefined, "Retention must not seek or replay animation");
    }
    assert.deepEqual(app.calls, ["bootstrap"], "No generation, reset, or persistence of artwork is requested");
  } finally { app.close(); }
});

test("stored fractional preferences restore safely and clamp to the supported range", () => {
  for (const [saved, expected] of [["0.36", 0.36], ["0.2", 0.2], ["0.8", 0.8], ["-1", 0.2], ["2", 0.8], ["bad", 0.2], ["NaN", 0.2], ["Infinity", 0.2], ["", 0.2], [" ", 0.2], [null, 0.2]]) {
    const app = studioHarness({ saved });
    try {
      assert.equal(app.canvas.props.trailRetention, expected, String(saved));
      assert.equal(app.output, `${Math.round(expected * 100)}%`);
      assert.equal(app.writes.length, 0);
    } finally { app.close(); }
  }
});

test("live changes stay bounded and continue working when browser storage is unavailable", () => {
  const app = studioHarness({ storageUnavailable: true });
  try {
    assert.equal(app.canvas.props.trailRetention, 0.2);
    app.input("55");
    assert.equal(app.canvas.props.trailRetention, 0.55);
    app.change(-3);
    assert.equal(app.canvas.props.trailRetention, 0.2);
    app.change(3);
    assert.equal(app.canvas.props.trailRetention, 0.8);
    app.change(NaN);
    assert.equal(app.canvas.props.trailRetention, 0.2);
  } finally { app.close(); }
});

test("static and edit modes disable the slider with clear English hints without changing the preference", () => {
  const app = studioHarness({ saved: "0.45" });
  try {
    app.click("Static · Final form");
    assert.equal(app.slider.props.disabled, true);
    assert.equal(app.hint, "Animated mode only");
    app.input("70");
    assert.equal(app.canvas.props.trailRetention, 0.45);
    app.click("Animated");
    assert.equal(app.slider.props.disabled, false);
    assert.match(app.hint, /45%/);
    app.edit();
    assert.equal(app.slider.props.disabled, true);
    assert.equal(app.hint, "Unavailable while editing");
    app.input("20");
    assert.equal(app.canvas.props.trailRetention, 0.45);
    assert.equal(app.output, "45%");
  } finally { app.close(); }
});

test("cinematic mode hides the toolbar without removing CanvasView or its retention setting", () => {
  const app = studioHarness({ saved: "0.3" });
  try {
    const canvas = app.canvas;
    app.click("Cinematic mode");
    assert.equal(app.control, null);
    assert.equal(app.canvas.key, canvas.key);
    assert.equal(app.canvas.props.trailRetention, 0.3);
    app.click("Exit Cinematic Mode");
    assert.ok(app.control);
    assert.equal(app.output, "30%");
  } finally { app.close(); }
});

test("mobile list tabs hide the toolbar and the range keeps a 44px touch target", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");
  assert.match(css, /\.app:not\(\[data-mtab="canvas"\]\)\s+\.snapshot-trail-controls\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.snapshot-trail-controls\s+input\[type="range"\]\s*\{[^}]*min-height:\s*44px/);
});
