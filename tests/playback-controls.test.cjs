const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const pureLoad = createTypeScriptLoader();
const { clampMotionSpeed, scaledMotionDelta, motionSpeedLabel, DEFAULT_SPHERE_CONTROLS } = pureLoad("engine/playbackControls.ts");
const { getStrokePlayback, strokeDistanceAtTime } = pureLoad("engine/strokePlayback.ts");
const source = file => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("motion multiplier is bounded at 0.25–3 with safe default and concise labels", () => {
  for (const [value, expected] of [[-5, 0.25], [0, 0.25], [0.25, 0.25], [0.75, 0.75], [1, 1], [2.5, 2.5], [3, 3], [100, 3], [NaN, 1], [Infinity, 1]]) {
    assert.equal(clampMotionSpeed(value), expected);
  }
  assert.equal(motionSpeedLabel(0.25), "0.25×");
  assert.equal(motionSpeedLabel(1), "1×");
  assert.equal(motionSpeedLabel(3), "3×");
  assert.equal(motionSpeedLabel(NaN), "1×");
  assert.equal(scaledMotionDelta(-20, 3), 0);
  assert.equal(scaledMotionDelta(NaN, 3), 0);
  assert.equal(scaledMotionDelta(Infinity, 3), 0);
  assert.equal(scaledMotionDelta(100, 0.25), 25);
  assert.equal(scaledMotionDelta(100, 3), 300);
  assert.equal(scaledMotionDelta(100, NaN), 100);
});

const textOf = node => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(textOf).join("") : node?.props ? textOf(node.props.children) : "";
const find = (tree, predicate) => {
  if (tree == null || typeof tree !== "object") return null;
  if (Array.isArray(tree)) return tree.map(child => find(child, predicate)).find(Boolean) ?? null;
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
};

function compileUI(file, modules, environment = {}) {
  const compiled = ts.transpileModule(source(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  const localRequire = name => modules[name] ?? (name.startsWith("@/") ? pureLoad(name.slice(2)) : require(name));
  new Function("require", "module", "exports", ...Object.keys(environment), compiled)(localRequire, module, module.exports, ...Object.values(environment));
  return module.exports.default;
}

test("compact dock has an accessible live motion range and camera-only buttons", () => {
  const calls = [];
  const Control = compileUI("components/CanvasPlaybackControls.tsx", {
    react: { useEffect() {}, useId: () => "motion-rate-test", useRef: value => ({ current: value }) },
    "@/components/TrailRetentionControl": { default: "TrailRetentionControl" },
  });
  const base = {
    displayMode: "sphere", trailRetention: 0.2, motionSpeed: 1,
    sphereControls: { ...DEFAULT_SPHERE_CONTROLS, resetKey: 12 },
    onMotionSpeedChange: value => calls.push(["speed", value]),
    onSphereControlsChange: value => calls.push(["camera", value]),
    onTrailRetentionChange: value => calls.push(["trail", value]),
  };
  const tree = Control(base);
  const slider = find(tree, node => node.type === "input");
  const label = find(tree, node => node.type === "label");
  assert.equal(tree.props.className, "canvas-playback-dock");
  assert.equal(tree.props["aria-label"], "Canvas playback controls");
  assert.equal(slider.props.min, 0.25); assert.equal(slider.props.max, 3); assert.equal(slider.props.step, 0.25);
  assert.equal(slider.props.value, 1); assert.equal(slider.props.disabled, false);
  assert.equal(label.props.htmlFor, slider.props.id); assert.equal(textOf(label), "Motion speed");
  assert.equal(slider.props["aria-valuetext"], "1 times normal speed");
  assert.ok(find(tree, node => node.props?.id === slider.props["aria-describedby"]));
  assert.equal(textOf(find(tree, node => node.type === "output")), "1×");
  slider.props.onChange({ currentTarget: { value: "99" } });
  assert.deepEqual(calls.shift(), ["speed", 3]);
  find(tree, node => node.type === "button" && textOf(node) === "Reset view").props.onClick();
  assert.deepEqual(calls.shift(), ["camera", { autoRotate: true, playing: true, resetKey: 13 }]);
  const rotate = find(tree, node => node.type === "button" && textOf(node) === "Auto-rotate on");
  assert.equal(rotate.props["aria-pressed"], true);
  rotate.props.onClick();
  assert.deepEqual(calls.shift(), ["camera", { autoRotate: false, playing: true, resetKey: 12 }]);
  find(tree, node => node.type === "button" && textOf(node) === "Pause strokes").props.onClick();
  assert.deepEqual(calls.shift(), ["camera", { autoRotate: true, playing: false, resetKey: 12 }]);
  for (const props of [{ ...base, displayMode: "static" }, { ...base, editMode: true }]) {
    const disabled = find(Control(props), node => node.type === "input");
    assert.equal(disabled.props.disabled, true);
    disabled.props.onChange({ currentTarget: { value: "2" } });
    assert.equal(calls.length, 0);
  }
});

function sphereHarness(paths) {
  const slots = [], effects = [], frameQueue = new Map(), frames = [], rotations = [];
  let cursor = 0, frameId = 0, mounts = 0, dataSets = 0, props;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hooks = {
    forwardRef: component => component,
    useRef(value) { const index = cursor++; return slots[index] ?? (slots[index] = { current: value }); },
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; }];
    },
    useImperativeHandle() {},
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (slots[index] && same(slots[index].dependencies, dependencies)) return;
      const old = slots[index]; slots[index] = { dependencies };
      effects.push(() => { old?.cleanup?.(); slots[index].cleanup = callback(); });
    },
  };
  const canvas = {
    parentElement: { clientWidth: 800, clientHeight: 600 }, style: {},
    addEventListener() {}, removeEventListener() {},
  };
  const mockDocument = {
    hidden: false, createElement: () => ({ width: 1, height: 1, style: {} }),
    addEventListener() {}, removeEventListener() {},
  };
  class Store {
    setData(next) { this.paths = next; dataSets++; }
    controlPointsOf(id) { return this.paths.find(path => path.id === id)?.points ?? []; }
    transformOf() { return { scale: 1, rotation: 0, translateX: 0, translateY: 0 }; }
    updateTransform() { throw new Error("Presentation must not mutate artwork"); }
  }
  class Brush {
    constructor(atlas) { this.atlas = atlas; mounts++; }
    resize(width, height) { this.atlas.width = width; this.atlas.height = height; }
    draw(_now, paths, agents, _store, _focus, _filter, _view, progress) { frames.push({ paths, agents, progress: new Map(progress) }); }
    dispose() {}
  }
  class Renderer {
    resize() {}
    draw(_atlas, rotation) { rotations.push({ ...rotation }); }
    dispose() {}
  }
  const Component = compileUI("components/SphereCanvasView.tsx", {
    react: hooks, "@/state/strokeStore": { StrokeStore: Store },
    "@/render/meteorRenderer": { MeteorRenderer: Brush },
    "@/render/sphereRenderer": { SphereRenderer: Renderer },
  }, {
    document: mockDocument,
    window: { devicePixelRatio: 1, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: callback => { frameQueue.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frameQueue.delete(id),
  });
  const render = changes => {
    props = { ...props, ...changes }; cursor = 0;
    const tree = Component(props, null);
    find(tree, node => node.type === "canvas").props.ref.current = canvas;
    while (effects.length) effects.shift()();
  };
  render({ paths, agents: [{ id: "agent", style: { hue: 200 } }], selectedStrokeId: null, filterAgentId: null,
    onSelectStroke() {}, motionSpeed: 1, sphereControls: { ...DEFAULT_SPHERE_CONTROLS } });
  return {
    render, frames, rotations,
    get mounts() { return mounts; }, get dataSets() { return dataSets; },
    frame(now) { assert.equal(frameQueue.size, 1); const [id, callback] = frameQueue.entries().next().value; frameQueue.delete(id); callback(now); },
    close() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test("live speed changes only future elapsed time and never restart or rewrite authored paths", () => {
  const makePath = (id, dwell) => ({
    id, agent_id: "agent", from: "seed", to: "light", created_at: Date.now(), motion_type: "direct",
    points: Array.from({ length: 5 }, (_, step) => ({ step, anchor: "word", x: 0.1 + step * 0.1, y: 0.4,
      entropy: 0.4, confidence: 0.7, intensity: 0.7, duration_ms: dwell, stroke_width: 1, branch: 0 })),
  });
  const paths = [makePath("short-timing", 100), makePath("long-timing", 600)];
  const before = structuredClone(paths);
  const timings = paths.map(getStrokePlayback);
  assert.notEqual(timings[0].durationMs, timings[1].durationMs);
  const harness = sphereHarness(paths);
  const check = elapsed => {
    const frame = harness.frames.at(-1);
    assert.equal(frame.paths, paths);
    paths.forEach((path, index) => near(frame.progress.get(path.id), strokeDistanceAtTime(elapsed / timings[index].durationMs, timings[index])));
  };
  try {
    harness.frame(100); check(0);
    harness.frame(200); check(100);
    const atOne = harness.rotations.at(-1).yaw;
    harness.render({ motionSpeed: 3 });
    harness.frame(300); check(400);
    near(harness.rotations.at(-1).yaw - atOne, 300 * 0.00007);
    harness.render({ motionSpeed: 0.25 });
    harness.frame(400); check(425);
    harness.render({ sphereControls: { autoRotate: true, playing: true, resetKey: 1 } });
    harness.frame(500); check(450);
    harness.render({ sphereControls: { autoRotate: false, playing: false, resetKey: 1 } });
    harness.frame(600); check(450);
    const pausedYaw = harness.rotations.at(-1).yaw;
    harness.frame(700); check(450);
    near(harness.rotations.at(-1).yaw, pausedYaw);
    harness.render({ motionSpeed: 3, sphereControls: { autoRotate: true, playing: true, resetKey: 1 } });
    harness.frame(800); check(750);
    assert.equal(harness.mounts, 1, "Changing controls must not recreate the brush/clock");
    assert.equal(harness.dataSets, 1, "Speed changes must not rebuild artwork data");
    assert.deepEqual(paths, before);
    assert.deepEqual(paths.map(getStrokePlayback), timings, "Authored speed differences remain intact");
  } finally { harness.close(); }
});

test("planar and spherical playback share the multiplier while detail scrubbing remains independent", () => {
  const planar = source("components/CanvasView.tsx");
  const sphere = source("components/SphereCanvasView.tsx");
  assert.match(planar, /scaledMotionDelta\(delta, motionSpeedRef\.current\)/);
  assert.equal((planar.match(/flight\.elapsed \+= motionDelta;/g) ?? []).length, 2, "Both arranged skies and looping planar strokes scale elapsed time");
  assert.match(planar, /delta \* controls\.speed \/ flight\.timing\.durationMs/, "Detail player continues to own its explicit speed and timeline");
  assert.match(sphere, /flight\.elapsed \+= motionDelta;/);
  assert.match(sphere, /rotation\.current\.yaw \+= motionDelta \* 0\.00007/);
  assert.match(sphere, /\}, \[sphereControls\?\.resetKey\]\)/);
  assert.doesNotMatch(sphere, /\}, \[(?:motionSpeed|sphereControls)\]\)/, "Rate/control changes cannot remount the renderer effect");
});
