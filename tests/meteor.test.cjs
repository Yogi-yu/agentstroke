const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

const load = createTypeScriptLoader();
const { getStrokePlayback, strokeDistanceAtTime } = load("engine/strokePlayback.ts");
const { MeteorRenderer, sampleMeteorCenterline, sampleBrushMaterial, getBrushMaterialConfig, sampleBrushTexture, getBrushDisplayLimits } = load("render/meteorRenderer.ts");
const { resolveVisualSignature } = load("engine/visualSignature.ts");
const { strokeDisplayView } = load("engine/strokeDisplayView.ts");

const MATERIALS = [
  { style: "hard", intensity: 0.65 },
  { style: "soft", intensity: 0.73 },
  { style: "watercolor", intensity: 0.79 },
  { style: "texture", intensity: 0.9 },
];

function makePath({ count = 6, dwell = 300, intensity = 0.75, entropy = 0.4, confidence = 0.7, seed = 128, id = "test-meteor" } = {}) {
  return {
    id, agent_id: "test-agent", from: "idea", to: "light", motion_type: "direct",
    created_at: 1, timestamp: 1, base_seed: seed,
    points: Array.from({ length: count }, (_, index) => ({
      step: index, anchor: `anchor-${index}`, x: index / Math.max(1, count - 1), y: 0.5,
      entropy: typeof entropy === "function" ? entropy(index) : entropy,
      confidence: typeof confidence === "function" ? confidence(index) : confidence,
      intensity, stroke_width: 1, branch: 0,
      duration_ms: typeof dwell === "function" ? dwell(index) : dwell,
    })),
  };
}

function near(actual, expected, message, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
}

test("duration stays inspectable, increases with dwell and decreases with intensity", () => {
  for (const count of [0, 1, 4, 8, 13]) {
    for (const intensity of [0, 0.5, 1]) {
      let previous = 0;
      for (const dwell of [0, 120, 500, 2000]) {
        const timing = getStrokePlayback(makePath({ count, dwell, intensity }));
        assert.ok(Number.isFinite(timing.durationMs));
        assert.ok(timing.durationMs >= 2200 && timing.durationMs <= 14000);
        assert.ok(timing.durationMs >= previous);
        assert.ok(timing.phaseSpeeds.every((speed) => speed >= 0.12 && speed <= 2));
        assert.ok(timing.phaseDurations.every((duration) => duration > 0));
        near(timing.phaseDurations.reduce((sum, duration) => sum + duration, 0), 1, "phase time sum");
        previous = timing.durationMs;
      }
    }
  }
  const durations = [0, 0.25, 0.5, 0.75, 1].map((intensity) =>
    getStrokePlayback(makePath({ count: 8, dwell: 350, intensity })).durationMs);
  assert.ok(durations.every((duration, index) => index === 0 || duration <= durations[index - 1]));
  assert.ok(durations[0] > durations.at(-1));
});

test("time-to-distance mapping is bounded, monotonic, deterministic and reaches each phase boundary", () => {
  for (const count of [0, 1, 4, 8, 13]) {
    const timing = getStrokePlayback(makePath({ count, dwell: (index) => 80 + index * 137 }));
    let previous = 0;
    for (let step = 0; step <= 1000; step++) {
      const progress = step / 1000;
      const distance = strokeDistanceAtTime(progress, timing);
      assert.ok(Number.isFinite(distance) && distance >= previous && distance <= 1);
      assert.equal(distance, strokeDistanceAtTime(progress, timing));
      previous = distance;
    }
    assert.equal(strokeDistanceAtTime(-1, timing), 0);
    assert.equal(strokeDistanceAtTime(0, timing), 0);
    assert.equal(strokeDistanceAtTime(1, timing), 1);
    assert.equal(strokeDistanceAtTime(2, timing), 1);
    let time = 0;
    timing.phaseDurations.forEach((duration, index) => {
      time += duration;
      near(strokeDistanceAtTime(time, timing), (index + 1) / timing.phaseDurations.length, "phase distance");
    });
  }
  const timing = getStrokePlayback(makePath({ dwell: (index) => index < 2 ? 100 : index < 4 ? 300 : 600 }));
  assert.ok(timing.phaseDurations[0] < timing.phaseDurations[1]);
  assert.ok(timing.phaseDurations[1] < timing.phaseDurations[2]);
});

test("centerline keeps endpoints, removes duplicate/invalid controls and handles empty/single points", () => {
  assert.deepEqual(sampleMeteorCenterline([], 1000, 600), { points: [], length: 0 });
  assert.deepEqual(sampleMeteorCenterline([{ x: 0.3, y: 0.2 }], 1000, 600), {
    points: [{ x: 300, y: 120 }], length: 0,
  });
  const controls = [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.8 }, { x: 0.9, y: 0.3 }];
  const withDuplicates = controls.flatMap((point) => [point, point]);
  withDuplicates.splice(2, 0, { x: NaN, y: 0 }, { x: 0, y: Infinity });
  const sampled = sampleMeteorCenterline(controls, 1000, 600);
  assert.deepEqual(sampleMeteorCenterline(withDuplicates, 1000, 600), sampled);
  assert.deepEqual(sampled.points[0], { x: 100, y: 120 });
  near(sampled.points.at(-1).x, 900, "last x");
  near(sampled.points.at(-1).y, 180, "last y");
  assert.ok(sampled.length > 0 && Number.isFinite(sampled.length));
  assert.ok(sampled.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
});

test("rounded trajectory stays inside the controls' convex hull and is deterministic", () => {
  const controls = [{ x: 0.1, y: 0.15 }, { x: 0.9, y: 0.25 }, { x: 0.35, y: 0.9 }];
  const triangle = controls.map(({ x, y }) => ({ x: x * 1000, y: y * 600 }));
  for (const sharpness of [0, 0.5, 1]) {
    const sampled = sampleMeteorCenterline(controls, 1000, 600, sharpness);
    assert.deepEqual(sampleMeteorCenterline(controls, 1000, 600, sharpness), sampled);
    for (const point of sampled.points) {
      const sides = triangle.map((a, index) => {
        const b = triangle[(index + 1) % triangle.length];
        return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
      });
      assert.ok(sides.every((side) => side >= -1e-7) || sides.every((side) => side <= 1e-7), "spline escaped convex hull");
    }
  }
});

test("dense and long paths still produce at most 257 centerline samples", () => {
  const controls = Array.from({ length: 2000 }, (_, index) => ({ x: index % 2, y: index / 1999 }));
  const sampled = sampleMeteorCenterline(controls, 100000, 100000);
  assert.ok(sampled.points.length >= 2 && sampled.points.length <= 257);
  assert.ok(sampled.points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
});

// Records foreground operations after the last clear, including coordinates,
// alpha and pigment. This checks the renderer's contract without pretending to
// verify raster anti-aliasing or replacing the browser's visual acceptance test.
class RecordingContext {
  constructor() {
    this.globalAlpha = 1;
    this.fillStyle = "black";
    this.strokeStyle = "black";
    this.lineWidth = 1;
    this.lineCap = "butt";
    this.frame = [];
    this.currentPath = [];
    this.clips = [];
    this.stack = [];
    this.clears = 0;
  }
  setTransform(...values) { this.transform = values; }
  clearRect(...values) { this.clears++; this.frame = []; this.clear = values; }
  beginPath() { this.currentPath = []; }
  moveTo(...values) { this.currentPath.push(["moveTo", ...values]); }
  lineTo(...values) { this.currentPath.push(["lineTo", ...values]); }
  closePath() { this.currentPath.push(["closePath"]); }
  arc(...values) { this.currentPath.push(["arc", ...values]); }
  ellipse(...values) { this.currentPath.push(["ellipse", ...values]); }
  quadraticCurveTo(...values) { this.currentPath.push(["quadraticCurveTo", ...values]); }
  bezierCurveTo(...values) { this.currentPath.push(["bezierCurveTo", ...values]); }
  save() {
    const state = {};
    for (const key of ["globalAlpha", "fillStyle", "strokeStyle", "lineWidth", "lineCap", "lineJoin", "globalCompositeOperation", "transform", "clips"]) state[key] = this[key];
    this.stack.push(state);
  }
  restore() { assert.ok(this.stack.length, "unbalanced context restore"); Object.assign(this, this.stack.pop()); }
  clip() { this.clips = [...this.clips, this.currentPath.map((point) => [...point])]; }
  style(pigment = this.fillStyle) {
    return typeof pigment === "object"
      ? { args: [...pigment.args], stops: pigment.stops.map((stop) => [...stop]) }
      : pigment;
  }
  fill() { this.frame.push({ kind: "path", points: this.currentPath.map((point) => [...point]), alpha: this.globalAlpha, style: this.style() }); }
  stroke() { this.frame.push({ kind: "stroke", points: this.currentPath.map((point) => [...point]), alpha: this.globalAlpha, style: this.style(this.strokeStyle), width: this.lineWidth, cap: this.lineCap, clips: structuredClone(this.clips) }); }
  fillRect(...values) { this.frame.push({ kind: "rect", values, alpha: this.globalAlpha, style: this.style() }); }
  createRadialGradient(...args) {
    const stops = [];
    return { args, stops, addColorStop: (...stop) => stops.push(stop) };
  }
}

function rendererHarness(controls = [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }], pathOptions = {}) {
  const context = new RecordingContext();
  const canvas = { style: {}, width: 0, height: 0, getContext: () => context };
  const renderer = new MeteorRenderer(canvas);
  renderer.resize(1000, 600, 2);
  const path = makePath(pathOptions);
  const paths = [path];
  const agents = [];
  const store = { controlPointsOf: () => controls, transformOf: () => ({ scale: 1 }) };
  function draw(progress, options = {}, time = 0, frameOptions = {}) {
    renderer.draw(time, paths, agents, store, frameOptions.focusId ?? null, frameOptions.filterAgentId ?? null,
      frameOptions.view ?? { scale: 1, translateX: 0, translateY: 0 }, new Map([[path.id, progress]]), options);
    return structuredClone(context.frame);
  }
  return { renderer, context, canvas, path, draw };
}

test("zero progress and zero lifecycle opacity clear the canvas without foreground geometry", () => {
  const { draw, context, path, canvas } = rendererHarness();
  assert.ok(draw(0.6).length > 0);
  assert.deepEqual(draw(0), []);
  assert.deepEqual(draw(0.8, { opacityById: new Map([[path.id, 0]]) }), []);
  assert.equal(context.clears, 3);
  assert.deepEqual(context.clear, [0, 0, canvas.width, canvas.height]);
});

test("seeking backwards clears future geometry and revisiting a time gives exactly the same frame", () => {
  const { draw } = rendererHarness();
  const first = draw(0.25, { retainTrace: true }, 1000);
  assert.ok(first.length > 0);
  draw(0.9, { retainTrace: true }, 9000);
  const backwards = draw(0.25, { retainTrace: true }, 90000);
  assert.deepEqual(backwards, first);
  assert.deepEqual(backwards, rendererHarness().draw(0.25, { retainTrace: true }));
  // At 25% the center is x=300. Every material surface and its tapered nib
  // must stop there; no future route or disconnected head is emitted.
  for (const operation of backwards) {
    if (operation.kind === "rect") assert.ok(operation.values[0] + operation.values[2] <= 308 + 1e-7);
    else for (const command of operation.points) {
      if (command[0] === "moveTo" || command[0] === "lineTo") assert.ok(command[1] <= 300 + 1e-7);
      if (command[0] === "arc") near(command[1], 300, "head x at seek position");
    }
  }
});

test("a single-point meteor is finite and full paths have bounded foreground work", () => {
  const point = rendererHarness([{ x: 0.3, y: 0.2 }]).draw(0.5);
  assert.equal(point.length, 1, "a genuine zero-length gesture should be one compact filled nib");
  assert.ok(!JSON.stringify(point).includes("null"), "NaN would serialize as null");
  const controls = Array.from({ length: 1000 }, (_, index) => ({ x: index % 2, y: index / 999 }));
  for (const { intensity } of MATERIALS) {
    const frame = rendererHarness(controls, { intensity }).draw(1, { retainTrace: true });
    assert.ok(frame.length <= (256 + 4) * 8, "at most 256 centerline segments + 4 nib samples, with eight material/deposit layers");
    assert.ok(frame.every((operation) => Number.isFinite(operation.alpha) && operation.alpha >= 0 && operation.alpha <= 1));
  }
});

test("four materials have different physical profiles with bounded pressure-responsive widths", () => {
  const materialProfiles = [];
  for (const { style, intensity } of MATERIALS) {
    assert.equal(resolveVisualSignature(makePath({ intensity })).brush_style, style);
    const sample = sampleBrushMaterial(style, 1, 0.45, 0.3, 0.003);
    materialProfiles.push(JSON.stringify(sample));
    for (const scale of [0.75, 1, 1.6]) {
      const widths = [];
      for (const pressure of [0.15, 0.3, 0.6, 1, 1.4, 2.2, 3.2]) {
        for (const progress of [0, 0.1, 0.5, 0.9, 1]) {
          for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
            const material = sampleBrushMaterial(style, pressure, progress, angle, 0.003, scale);
            assert.ok(Object.values(material).every(Number.isFinite), `${style} material must be finite`);
            assert.ok(material.width > 0 && material.width <= 12, `${style} width is bounded`);
            assert.ok(material.tipLength >= 0 && material.fiberCount >= 0);
            widths.push(material.width);
          }
        }
      }
      assert.ok(Math.max(...widths) > Math.min(...widths) * 1.25, `${style} must have observable width variation`);
      const low = sampleBrushMaterial(style, 0.32, 0.5, 0.3, 0.003, scale);
      const high = sampleBrushMaterial(style, 1.72, 0.5, 0.3, 0.003, scale);
      assert.ok(high.width > low.width * 1.1, `${style} must respond to pressure, not only opacity`);
    }
  }
  assert.equal(new Set(materialProfiles).size, 4, "materials must not share one physical profile");
});

test("material recipes distinguish cut faces, ink bellies, wet sediment and dry fibers", () => {
  const recipes = MATERIALS.map(({ style }) => getBrushMaterialConfig(style));
  assert.deepEqual(recipes.map((recipe) => recipe.surface), ["cut-face", "ink-belly", "wet-sediment", "dry-fibers"]);
  assert.deepEqual(recipes.map((recipe) => recipe.fiberCount), [0, 3, 0, 5]);
  assert.equal(recipes[0].edgeRoughness, 0, "hard nib edges must remain clean");
  assert.ok(recipes[2].edgeRoughness > recipes[1].edgeRoughness, "watercolor must have a more irregular wet boundary");
  assert.ok(recipes[3].highlightLightness - recipes[3].grooveLightness > 60, "dry-brush grooves need visible pigment contrast");
  assert.ok(recipes[2].sedimentContrast > recipes[0].sedimentContrast, "watercolor needs real variable pigment deposits");
});

test("material deposits are seeded, continuous, bounded and responsive to the original semantic attributes", () => {
  const source = { entropy: 0.5, confidence: 0.65, intensity: 0.78, pressure: 1 };
  for (const { style } of MATERIALS) {
    for (const seed of [0, 128, 4294967295]) {
      for (let i = 0; i <= 100; i++) {
        const progress = i / 100;
        const material = sampleBrushTexture(style, source, progress, seed);
        assert.deepEqual(material, sampleBrushTexture(style, source, progress, seed));
        assert.ok(Object.values(material).every(Number.isFinite));
        assert.ok(material.leftEdge > 0.38 && material.leftEdge <= 1, "wet edges may visibly recede but must not sever the body");
        assert.ok(material.rightEdge > 0.38 && material.rightEdge <= 1);
        assert.ok(material.pigmentLoad >= 0 && material.pigmentLoad <= 1);
        assert.ok(material.dryness >= 0 && material.dryness <= 1);
        const next = sampleBrushTexture(style, source, Math.min(1, progress + 0.00001), seed);
        for (const key of Object.keys(material)) assert.ok(Math.abs(material[key] - next[key]) < 0.005, `${style}/${key} must not flicker or jump between samples`);
      }
    }
    const material = sampleBrushTexture(style, source, 0.37, 128);
    const reseeded = sampleBrushTexture(style, source, 0.37, 256);
    assert.notEqual(material.depositOffset, reseeded.depositOffset, "new seeds should move deposits, not only recolor them");
    const lowEntropy = sampleBrushTexture(style, { ...source, entropy: 0.1 }, 0.37, 128);
    const highEntropy = sampleBrushTexture(style, { ...source, entropy: 0.9 }, 0.37, 128);
    assert.ok(highEntropy.dryness > lowEntropy.dryness);
    assert.ok(highEntropy.grooveWidth > lowEntropy.grooveWidth, "entropy opens actual dry channels");
    const lowConfidence = sampleBrushTexture(style, { ...source, confidence: 0.1 }, 0.37, 128);
    const highConfidence = sampleBrushTexture(style, { ...source, confidence: 0.9 }, 0.37, 128);
    assert.ok(highConfidence.dryness < lowConfidence.dryness);
    assert.ok(highConfidence.pigmentLoad > lowConfidence.pigmentLoad);
    const lowIntensity = sampleBrushTexture(style, { ...source, intensity: 0.2 }, 0.37, 128);
    const highIntensity = sampleBrushTexture(style, { ...source, intensity: 0.95 }, 0.37, 128);
    assert.ok(highIntensity.pigmentLoad > lowIntensity.pigmentLoad);
    const lifted = sampleBrushTexture(style, { ...source, pressure: 0.32 }, 0.37, 128);
    const pressed = sampleBrushTexture(style, { ...source, pressure: 1.72 }, 0.37, 128);
    assert.ok(pressed.grooveWidth < lifted.grooveWidth, "pressure must close physical grooves");
  }
});

test("strong pressure valleys, wet pools and dry channels are physically visible without exceeding twelve pixels", () => {
  for (const { style } of MATERIALS) {
    const lifted = sampleBrushMaterial(style, 0.15, 0.5, 0.3, 0.003);
    const pressed = sampleBrushMaterial(style, 2.2, 0.5, 0.3, 0.003);
    assert.ok(lifted.width >= 0.35 && lifted.width <= 1.25, `${style}: a lifted phase must be thin but continuous`);
    assert.ok(pressed.width >= 5 && pressed.width <= 12, `${style}: pressed phase must be visibly broad and bounded`);
    assert.ok(pressed.width / lifted.width >= 5, `${style}: new pressure range must produce a large physical contrast`);
  }
  const source = { entropy: 0.7, confidence: 0.5, intensity: 0.79, pressure: 1 };
  const wet = Array.from({ length: 201 }, (_, i) => sampleBrushTexture("watercolor", source, i / 200, 768));
  const spread = (key) => Math.max(...wet.map((sample) => sample[key])) - Math.min(...wet.map((sample) => sample[key]));
  assert.ok(spread("leftEdge") > 0.2, "the wet boundary must visibly undulate, not just change alpha");
  assert.ok(spread("depositWidth") > 0.9, "pigment must form broad and narrow internal pools");
  assert.ok(spread("grooveBreakup") > 0.7, "dry channels must physically open and close along the ribbon");
  assert.ok(getBrushMaterialConfig("watercolor").sedimentContrast >= 35, "wet pigment pools require strong value contrast");
  assert.ok(getBrushMaterialConfig("texture").grooveLightness <= 3, "dry channels should expose a dark substrate");

  const { draw } = rendererHarness(undefined, { intensity: 0.9, entropy: 0.75, confidence: 0.45 });
  const frame = draw(1, { retainTrace: true });
  const channels = frame.filter((operation) => operation.kind === "stroke");
  assert.ok(Math.max(...channels.map((channel) => channel.width)) > 1, "dry grooves must be wider than hairlines");
  assert.ok(channels.every((channel) => channel.width > 0 && channel.width <= 2.45 && channel.clips.length === 1));
  assert.ok(!frame.some((operation) => operation.kind === "rect" || operation.points?.some((point) => ["arc", "ellipse"].includes(point[0]))));
});

test("short high-frequency gestures keep thin connected peaks instead of a string of beads", () => {
  for (const changes of [3, 5, 8]) {
    const short = getBrushDisplayLimits(32, changes, 16);
    assert.ok(short.maxWidth <= Math.max(1.35, 32 / changes * 0.48));
    assert.ok(short.tipLength <= 32 * 0.14 && short.tipLength <= 32 / changes * 0.72);
    assert.ok(short.minConnector >= 0.65, "interior pressure valleys must retain a readable connector");
  }
  assert.equal(getBrushDisplayLimits(800, 8, 16).maxWidth, 12, "long strokes must retain the full pressure range");
  for (const { intensity } of MATERIALS) {
    const harness = rendererHarness([{ x: 0.4, y: 0.5 }, { x: 0.432, y: 0.5 }], { intensity });
    const frame = harness.draw(1, { retainTrace: true });
    const changes = resolveVisualSignature(harness.path).width_change_count;
    const limit = getBrushDisplayLimits(32, changes, 16).maxWidth;
    const maxHalfEnvelope = limit * 1.6 / 2 + 0.15;
    for (const operation of frame) for (const point of operation.points ?? []) {
      if (point[0] === "moveTo" || point[0] === "lineTo") assert.ok(Math.abs(point[2] - 300) <= maxHalfEnvelope, "short peaks and halo must remain slender relative to phase spacing");
    }
    assert.ok(!frame.some((operation) => operation.points?.some((point) => point[0] === "arc")), "peak pressure must never add round stamps");
  }
});

test("deposits and dry channels survive seeking without detached marks or a shared plastic highlight", () => {
  const pigmentCounts = new Map();
  for (const { style, intensity } of MATERIALS) {
    const { path, draw } = rendererHarness(undefined, {
      intensity,
      entropy: (index) => 0.15 + index * 0.14,
      confidence: (index) => 0.9 - index * 0.12,
      dwell: (index) => 150 + index * 90,
      seed: 271,
    });
    const first = draw(0.63, { retainTrace: true });
    draw(0.91, { retainTrace: true });
    assert.deepEqual(draw(0.63, { retainTrace: true }, 987654), first, `${style} deposits must remain anchored to the path`);
    assert.ok(!first.some((operation) => operation.kind === "rect" || operation.points?.some((point) => ["arc", "ellipse"].includes(point[0]))), "materials must not emit dots, stamps or detached highlights");
    pigmentCounts.set(style, new Set(first.map((operation) => operation.style)).size);
    const faded = draw(0.63, { retainTrace: true, opacityById: new Map([[path.id, 0.4]]) });
    assert.deepEqual(faded.map(({ alpha, ...surface }) => surface), first.map(({ alpha, ...surface }) => surface), "lifecycle opacity must not change the material structure");
    faded.forEach((operation, index) => near(operation.alpha, first[index].alpha * 0.4, "whole-material lifecycle fade", 1e-8));
    const fibers = first.filter((operation) => operation.kind === "stroke");
    if (style === "soft" || style === "texture") {
      assert.ok(new Set(fibers.map((operation) => operation.width.toFixed(4))).size > 3, "pressure and dryness must vary actual channel widths");
      assert.ok(fibers.every((operation) => operation.clips.length === 1), "every dry channel must be clipped to one continuous body");
    } else assert.equal(fibers.length, 0, `${style} should not reuse the dry-brush fiber treatment`);
  }
  assert.ok(pigmentCounts.get("watercolor") > 20, "watercolor needs many sediment densities along its continuous color layers");
});

test("four brush types produce genuinely different geometry rather than recolored identical lines", () => {
  const geometryFingerprints = [];
  for (const { style, intensity } of MATERIALS) {
    const harness = rendererHarness(undefined, { intensity });
    const frame = harness.draw(0.6, { retainTrace: true });
    assert.ok(frame.length > 0, `${style} must render`);
    geometryFingerprints.push(JSON.stringify(frame.map((operation) => ({
      kind: operation.kind, points: operation.points, values: operation.values, width: operation.width,
    }))));
    assert.ok(!frame.some((operation) => operation.points?.some((command) => command[0] === "arc")),
      `${style} must use its shaped nib, not a shared circular head`);
    assert.equal(harness.context.stack.length, 0, "material drawing must restore canvas state");
    if (style === "texture" || style === "soft") {
      const fibers = frame.filter((operation) => operation.kind === "stroke");
      assert.ok(fibers.length > 0, "texture must include continuous fibers");
      assert.ok(fibers.every((fiber) => fiber.clips.length > 0), "fibers must stay clipped to their ribbon");
      const fiberCount = sampleBrushMaterial(style, 1, 0.5, 0, 0.003).fiberCount;
      const segmentsPerFiber = fibers.length / fiberCount;
      assert.ok(Number.isInteger(segmentsPerFiber) && segmentsPerFiber > 1);
      for (let fiber = 0; fiber < fiberCount; fiber++) {
        const chain = fibers.slice(fiber * segmentsPerFiber, (fiber + 1) * segmentsPerFiber);
        chain.forEach((segment, index) => {
          const start = segment.points.find((command) => command[0] === "moveTo");
          const end = segment.points.findLast((command) => command[0] === "lineTo");
          assert.ok(start && end, "fiber must be a line, not a stamp");
          assert.ok(Math.hypot(end[1] - start[1], end[2] - start[2]) > 0);
          assert.equal(segment.cap, "butt", "joined fibers should not introduce round dot stamps");
          if (index > 0) {
            const previous = chain[index - 1].points.findLast((command) => command[0] === "lineTo");
            near(start[1], previous[1], "continuous fiber x");
            near(start[2], previous[2], "continuous fiber y");
          }
        });
      }
    }
  }
  assert.equal(new Set(geometryFingerprints).size, 4);
});

test("each material remains deterministic when seeking and leaves future trajectory undrawn", () => {
  for (const { style, intensity } of MATERIALS) {
    const { draw, path } = rendererHarness(undefined, { intensity });
    const first = draw(0.25, { retainTrace: true }, 1000);
    draw(0.9, { retainTrace: true }, 9000);
    assert.deepEqual(draw(0.25, { retainTrace: true }, 30000), first, `${style} backwards seek`);
    assert.deepEqual(draw(0), [], `${style} zero progress`);
    assert.deepEqual(draw(0.6, { opacityById: new Map([[path.id, 0]]) }), [], `${style} zero opacity`);
    for (const operation of first) {
      if (operation.kind === "rect") assert.ok(operation.values[0] + operation.values[2] <= 312 + 1e-7);
      else for (const command of operation.points) {
        if (command[0] === "moveTo" || command[0] === "lineTo") assert.ok(command[1] <= 312 + 1e-7, `${style} rendered future route`);
        if (command[0] === "quadraticCurveTo" || command[0] === "bezierCurveTo") {
          for (let index = 1; index < command.length; index += 2) assert.ok(command[index] <= 312 + 1e-7);
        }
      }
    }
  }
});

test("hit testing follows the rounded visible centerline rather than the old control-point corner", () => {
  const controls = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }];
  const { renderer, path, draw } = rendererHarness(controls);
  const signature = resolveVisualSignature(path);
  const centerline = sampleMeteorCenterline(controls, 1000, 600, signature.turn_sharpness);
  const roundedPoint = centerline.points.reduce((best, point) => {
    const gap = Math.min(Math.abs(point.y - 60), Math.abs(point.x - 900));
    return gap > best.gap ? { ...point, gap } : best;
  }, { x: 0, y: 0, gap: 0 });
  assert.ok(roundedPoint.gap > 12, "fixture must differ from the former hit map");
  draw(1, { retainTrace: true });
  assert.equal(renderer.hitTest(roundedPoint.x, roundedPoint.y), path.id);
  assert.equal(renderer.hitTest(900, 60), null, "invisible old corner must not be clickable");
});

test("hit testing respects reveal, delayed tail erosion, lifecycle opacity and CSS coordinates under zoom/pan", () => {
  const { renderer, path, draw } = rendererHarness();
  draw(0.25, { retainTrace: true });
  assert.equal(renderer.hitTest(300, 300), path.id);
  assert.equal(renderer.hitTest(820, 300), null, "future route is not clickable");
  draw(0.8, { trailRetention: 0.8 });
  assert.equal(renderer.hitTest(740, 300), path.id);
  assert.equal(renderer.hitTest(100, 300), path.id, "the complete drawn route remains visible through 80%");
  draw(0.83, { trailRetention: 0.8 });
  assert.equal(renderer.hitTest(100, 300, 2), path.id, "the rear fades gradually rather than disappearing at 80%");
  draw(0.86, { trailRetention: 0.8 });
  assert.equal(renderer.hitTest(100, 300, 2), null, "the now-transparent rear no longer intercepts clicks");
  draw(1, { trailRetention: 0.8 });
  assert.equal(renderer.hitTest(100, 300), null, "erased rear is not clickable after completion");
  assert.equal(renderer.hitTest(740, 300), path.id, "most of the arrived trace is still present");
  for (const opacity of [0, 0.01]) {
    draw(0.8, { opacityById: new Map([[path.id, opacity]]) });
    assert.equal(renderer.hitTest(740, 300), null, "faded meteors cannot intercept clicks");
  }
  draw(0);
  assert.equal(renderer.hitTest(100, 300), null);
  draw(0.5, { retainTrace: true }, 0, { view: { scale: 1.5, translateX: 0.1, translateY: 0.1 } });
  assert.equal(renderer.hitTest(850, 510), path.id, "DPR2 must not scale CSS pointer coordinates twice");
  assert.equal(renderer.hitTest(500, 300), null, "untransformed coordinates no longer match");
  draw(0.5, {}, 0, { filterAgentId: "another-agent" });
  assert.equal(renderer.hitTest(500, 300), null, "filtered strokes are not clickable");
  draw(0.5, {}, 0, { focusId: "another-stroke" });
  assert.equal(renderer.hitTest(500, 300), null, "unfocused strokes are not clickable");
});

test("all animated materials default to 20 percent retention, then feather their rear away deterministically", () => {
  for (const { style, intensity } of MATERIALS) {
    for (const endX of [0.13, 0.9]) {
      const { draw, renderer, path } = rendererHarness([{ x: 0.1, y: 0.5 }, { x: endX, y: 0.5 }], { intensity });
      const frames = [0.05, 0.1, 0.2].map((progress) => draw(progress));
      for (const frame of frames) {
        const rear = frame.find((operation) => operation.kind === "path");
        assert.ok(rear, `${style} has a connected rear surface`);
        near(rear.alpha, 0.035, `${style} rear halo does not age before 20%`);
      }
      const halfFaded = draw(0.23).find((operation) => operation.kind === "path");
      assert.ok(halfFaded.alpha > 0 && halfFaded.alpha < 0.035, `${style} rear fades only after threshold`);
      draw(1);
      assert.equal(renderer.hitTest(100, 300, 0.1), null, `${style} erased rear cannot be selected`);
      assert.deepEqual(draw(0.1, {}, 99999), frames[1], `${style} replay restores the full early trace`);
      draw(1, { retainTrace: true });
      assert.equal(renderer.hitTest(100, 300, 0.1), path.id, `${style} static/detail/sky keep the whole trace`);
    }
  }
});

test("changing trail retention updates an existing animation and its hit area without restarting it", () => {
  const { renderer, path, draw } = rendererHarness();
  const full = draw(0.7, { trailRetention: 0.8 });
  assert.equal(renderer.hitTest(100, 300, 2), path.id);
  assert.equal(renderer.hitTest(660, 300, 2), path.id, "head is at the current animation progress");
  const short = draw(0.7, { trailRetention: 0.2 });
  assert.notDeepEqual(short, full);
  assert.equal(renderer.hitTest(100, 300, 2), null);
  assert.equal(renderer.hitTest(300, 300, 2), null);
  assert.equal(renderer.hitTest(660, 300, 2), path.id, "adjustment does not reset or move the head");
  draw(0.7, { trailRetention: 0.5 });
  assert.equal(renderer.hitTest(100, 300, 2), null);
  assert.equal(renderer.hitTest(300, 300, 2), path.id, "intermediate retention reveals an intermediate tail");
  assert.deepEqual(draw(0.7, { trailRetention: 0.8 }), full, "increasing retention restores older pigment immediately");
  assert.equal(renderer.hitTest(100, 300, 2), path.id);
});

test("retention settings cannot shorten retained static/detail/sky traces or bypass safe limits", () => {
  for (const { intensity } of MATERIALS) {
    const { draw, renderer, path } = rendererHarness(undefined, { intensity });
    const retained = draw(1, { retainTrace: true, trailRetention: 0.8 });
    for (const trailRetention of [0.2, 0.5, 0.8]) {
      assert.deepEqual(draw(1, { retainTrace: true, trailRetention }), retained);
      assert.equal(renderer.hitTest(100, 300, 2), path.id);
    }
    assert.deepEqual(draw(0.7, { trailRetention: -10 }), draw(0.7, { trailRetention: 0.2 }));
    assert.deepEqual(draw(0.7, { trailRetention: 100 }), draw(0.7, { trailRetention: 0.8 }));
    for (const trailRetention of [undefined, NaN, Infinity]) {
      assert.deepEqual(draw(0.7, { trailRetention }), draw(0.7, { trailRetention: 0.2 }));
    }
  }
});

test("per-path layout views affect drawing and hit testing without changing persisted geometry", () => {
  const context = new RecordingContext();
  const transforms = [];
  context.setTransform = (...values) => { context.transform = values; transforms.push(values); };
  const renderer = new MeteorRenderer({ style: {}, width: 0, height: 0, getContext: () => context });
  renderer.resize(1000, 600, 2);
  const controls = [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }];
  const paths = [makePath({ id: "upper" }), makePath({ id: "lower" }), makePath({ id: "fallback" })];
  const original = structuredClone({ controls, paths });
  const store = { controlPointsOf: () => controls, transformOf: () => ({ scale: 1 }) };
  renderer.draw(0, paths, [], store, null, null, { scale: 1, translateX: 0.1, translateY: 0 },
    new Map(paths.map((path) => [path.id, 0.6])), {
      retainTrace: true,
      viewById: new Map([
        ["upper", { scale: 0.5, translateX: 0.1, translateY: 0.1 }],
        ["lower", { scale: 0.6, translateX: 0.25, translateY: 0.55 }],
      ]),
    });
  assert.equal(renderer.hitTest(300, 210), "upper", "CSS hit coordinates must use the upper path camera");
  assert.equal(renderer.hitTest(500, 510), "lower", "CSS hit coordinates must use the lower path camera");
  assert.equal(renderer.hitTest(500, 300), "fallback", "a missing per-path view must fall back to the common view");
  assert.equal(renderer.hitTest(450, 210), null, "the upper path future route is still unclickable");
  assert.equal(renderer.hitTest(100, 300), null, "old untransformed coordinates must not intercept clicks");
  assert.ok(transforms.some((values) => JSON.stringify(values) === JSON.stringify([1, 0, 0, 1, 200, 120])));
  assert.ok(transforms.some((values) => JSON.stringify(values) === JSON.stringify([1.2, 0, 0, 1.2, 500, 660])));
  assert.ok(transforms.some((values) => JSON.stringify(values) === JSON.stringify([2, 0, 0, 2, 200, 0])));
  assert.deepEqual({ controls, paths }, original, "display layout must never rewrite stored paths or transforms");
});

test("readability enlargement separates a compact route without magnifying its nib or click coordinates", () => {
  const controls = [{ x: 0.49, y: 0.5 }, { x: 0.51, y: 0.5 }];
  const { renderer, path, draw, context } = rendererHarness(controls, { intensity: 0.79 });
  const camera = { scale: 1, translateX: 0, translateY: 0 };
  const view = strokeDisplayView(controls, { scale: 1, rotation: 0, translation: { x: 0, y: 0 } },
    { width: 1000, height: 600 }, camera);
  near(view.scale, 4, "twenty-pixel footprint receives fourfold display enlargement");
  const operations = draw(1, { retainTrace: true, viewById: new Map([[path.id, view]]) });
  near(context.transform[0], 8, "DPR2 and local display scale compose once");
  assert.equal(renderer.hitTest(462, 300, 2), path.id, "enlarged beginning is clickable outside old footprint");
  assert.equal(renderer.hitTest(540, 300, 2), path.id, "enlarged end is clickable");
  assert.equal(renderer.hitTest(575, 300, 2), null);
  const ribbonY = operations.filter((op) => op.kind === "path").flatMap((op) =>
    op.points.filter((point) => ["moveTo", "lineTo"].includes(point[0])).map((point) => point[2]));
  assert.ok(ribbonY.length > 0);
  assert.ok((Math.max(...ribbonY) - Math.min(...ribbonY)) * view.scale <= 16,
    "physical nib stays bounded in screen pixels, not four times as wide");
  draw(0.25, { retainTrace: true, viewById: new Map([[path.id, view]]) });
  assert.equal(renderer.hitTest(540, 300, 2), null, "future enlarged route is not clickable");
});
