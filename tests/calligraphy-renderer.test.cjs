const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const load = createTypeScriptLoader();
const {
  MeteorRenderer, sampleBrushMaterial, sampleBrushTexture, sampleCalligraphyBundles,
  getBrushMaterialConfig, getBrushDisplayLimits,
} = load("render/meteorRenderer.ts");

function path(treatment = "calligraphy") {
  return {
    id: "brush-test", agent_id: "brush-agent", from: "ink", to: "flight",
    motion_type: "direct", created_at: 1, timestamp: 1, base_seed: 456,
    brush_treatment: treatment,
    points: Array.from({ length: 8 }, (_, i) => ({
      step: i, anchor: ["ink", "paper", "grain", "fiber", "wing", "wind", "sky", "flight"][i],
      x: i / 7, y: 0.5, intensity: 0.79, entropy: 0.72 - i * 0.03,
      confidence: 0.45 + i * 0.03, duration_ms: 150 + i * 60, stroke_width: 1, branch: 0,
    })),
  };
}

class Context {
  constructor() { this.frame = []; this.stack = []; }
  setTransform() {}
  clearRect() { this.frame = []; }
  beginPath() { this.points = []; }
  moveTo(x, y) { this.points.push(["M", x, y]); }
  lineTo(x, y) { this.points.push(["L", x, y]); }
  closePath() {}
  fill() { this.frame.push({ points: structuredClone(this.points), alpha: this.globalAlpha, color: typeof this.fillStyle === "object" ? { stops: this.fillStyle.stops, args: this.fillStyle.args } : this.fillStyle, composite: this.globalCompositeOperation }); }
  createLinearGradient(...args) { const stops = []; return { args, stops, addColorStop: (p, color) => stops.push([p, color]) }; }
  save() { this.stack.push({ globalAlpha: this.globalAlpha }); }
  restore() { Object.assign(this, this.stack.pop()); }
  clip() {}
  stroke() { this.frame.push({ points: structuredClone(this.points), alpha: this.globalAlpha, color: this.strokeStyle }); }
}

function harness(treatment = "calligraphy", length = 800, customControls, multicolor = false) {
  const context = new Context();
  const renderer = new MeteorRenderer({ style: {}, getContext: () => context });
  renderer.resize(1000, 600, 2);
  const artwork = path(treatment);
  if (multicolor) {
    artwork.points = [...artwork.points, ...structuredClone(artwork.points)].map((p, step) => ({ ...p, step }));
    artwork.generation_mode = "autonomous";
    artwork.mood = { timestamp: 1, entropy_shift: 0, drift_bias: 0, curvature_bias: 0, motion_variation: 0.85, color_variation: 0 };
  }
  const controls = customControls ?? [{ x: 0.1, y: 0.5 }, { x: 0.1 + length / 1000, y: 0.5 }];
  const before = structuredClone(artwork);
  const store = { controlPointsOf: () => controls, transformOf: () => ({ scale: 1 }) };
  const draw = (progress, options = {}, time = 0) => {
    renderer.draw(time, [artwork], [], store, null, null, { scale: 1, translateX: 0, translateY: 0 },
      new Map([[artwork.id, progress]]), options);
    assert.deepEqual(artwork, before, "material must not rewrite authored words, geometry or metrics");
    return structuredClone(context.frame);
  };
  return { draw, renderer, artwork, context };
}

const source = { entropy: 0.68, confidence: 0.48, intensity: 0.79, pressure: 1 };

test("calligraphy has its own matte split-ink recipe and physical loaded/lifted nib", () => {
  const recipe = getBrushMaterialConfig("calligraphy");
  assert.equal(recipe.surface, "split-ink");
  assert.equal(recipe.fiberCount, 7);
  assert.ok(recipe.highlightLightness - recipe.bodyLightness < 5, "no glossy plastic highlight");
  const press = sampleBrushMaterial("calligraphy", 2.2, 0.35, 0.3, 0.003);
  const lift = sampleBrushMaterial("calligraphy", 0.15, 0.35, 0.3, 0.003);
  assert.ok(press.width >= 10 && press.width <= 12);
  assert.ok(press.width > lift.width * 2.8, "press/lift must be an unmistakable physical change even in the loaded belly");
  assert.ok(sampleBrushMaterial("calligraphy", 2.2, 0.75, 0.3, 0.003).width >
    sampleBrushMaterial("calligraphy", 0.15, 0.75, 0.3, 0.003).width * 12, "released ink creates a strong late press/lift contrast");
  assert.ok(sampleBrushMaterial("calligraphy", 1, 0.98, 0.3, 0.003).width <
    sampleBrushMaterial("calligraphy", 1, 0.3, 0.3, 0.003).width * 0.3, "a final lift must narrow the swash");
  for (const p of [0, 0.15, 0.5, 1, 2.2, 6]) for (const t of [0, 0.02, 0.3, 0.8, 1]) {
    const material = sampleBrushMaterial("calligraphy", p, t, 1, 0.009, 2);
    assert.ok(Object.values(material).every(Number.isFinite));
    assert.ok(material.width > 0 && material.width <= 12);
  }
});

test("dry brush opens real irregular longitudinal gaps while preserving an uninterrupted central spine", () => {
  const texture = sampleBrushTexture("calligraphy", source, 0.67, 456);
  const bundles = sampleCalligraphyBundles(texture, 0.67);
  assert.equal(bundles.length, 7);
  assert.deepEqual(bundles, sampleCalligraphyBundles(texture, 0.67));
  const coverage = bundles.reduce((sum, b) => sum + b.high - b.low, 0);
  assert.ok(coverage < 1.5, "at least a quarter of a dry broad face must expose the substrate");
  const gaps = bundles.slice(1).map((b, i) => b.low - bundles[i].high);
  assert.ok(gaps.every(gap => gap > 0), "channels are omitted geometry, not painted dark stripes");
  assert.ok(new Set(gaps.map(gap => gap.toFixed(4))).size > 4, "no mechanically even comb marks");
  assert.ok(bundles.some(b => b.low < -0.07 && b.high > 0.07), "a solid central ink spine always remains");
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    const material = sampleBrushTexture("calligraphy", source, t, 456);
    const section = sampleCalligraphyBundles(material, t);
    section.forEach((b, j) => {
      assert.ok(b.low >= -1 && b.high <= 1 && b.high >= b.low, "all bundles stay inside the one nib footprint");
      if (j) assert.ok(b.low >= section[j - 1].high, "ink bundles must not fold over each other");
    });
    assert.ok(section.some(b => b.low <= -0.05 && b.high >= 0.05));
  }
  for (const width of [0, 0.6, 1.35, 2.4]) {
    const thin = sampleCalligraphyBundles(texture, 0.67, width);
    assert.ok(Math.abs(thin.reduce((sum, b) => sum + b.high - b.low, 0) - 2) < 1e-9,
      "thin brushes close their channels rather than fragment into specks");
  }
  const entry = sampleCalligraphyBundles(texture, 0);
  assert.ok(Math.abs(entry.reduce((sum, b) => sum + b.high - b.low, 0) - 2) < 1e-9,
    "all hairs join in the loaded entry");
});

test("calligraphy geometry is not watercolor with another alpha and uses no halo, particles or erasing", () => {
  const ink = harness().draw(0.65, { retainTrace: true });
  const wash = harness("original").draw(0.65, { retainTrace: true });
  assert.notDeepEqual(ink.map(x => x.points), wash.map(x => x.points));
  assert.ok(ink.every(op => op.alpha >= 0.82 && op.alpha <= 1), "all ink bundles are dense pigment, not a wash/halo");
  assert.ok(ink.every(op => op.composite === "source-over"), "gaps must not erase stars or other strokes");
  assert.ok(ink.every(op => op.points.length >= 4 && op.points.every(p => p[0] === "M" || p[0] === "L")),
    "only swept connected ribbons, never detached circle/ellipse/rectangle stamps");
  assert.ok(ink.length <= 260 * 7, "material remains bounded to seven layers");
  assert.ok(ink.length <= 7 * 17, "continuous long fills avoid hundreds of transverse antialias seams");
});

test("calligraphy scrubbing is deterministic, stops at the single pointed head and keeps authored data untouched", () => {
  const { draw, renderer, artwork } = harness();
  const first = draw(0.35, { retainTrace: true });
  draw(0.95, { retainTrace: true });
  assert.deepEqual(draw(0.35, { retainTrace: true }, 99999), first);
  const headX = 100 + 800 * 0.35;
  const headPoints = first.flatMap(op => op.points).filter(p => Math.abs(p[1] - headX) < 1e-8);
  assert.ok(headPoints.length >= 7);
  assert.ok(headPoints.every(p => Math.abs(p[2] - 300) < 1e-8), "every hair converges on one pointed head");
  assert.ok(first.flatMap(op => op.points).every(p => p[1] <= headX + 1e-8), "no future path or detached leading tip");
  assert.deepEqual(draw(0), []);
  assert.deepEqual(draw(0.35, { opacityById: new Map([[artwork.id, 0]]) }), []);
  draw(0.7, { trailRetention: 0.8 });
  assert.equal(renderer.hitTest(100, 300, 1), artwork.id);
  draw(0.7, { trailRetention: 0.2 });
  assert.equal(renderer.hitTest(100, 300, 1), null);
  assert.equal(renderer.hitTest(660, 300, 1), artwork.id);
});

test("very short calligraphy remains a legible single slim gesture, not a bundle of round blobs", () => {
  for (const length of [8, 16, 32]) {
    const frame = harness("calligraphy", length).draw(1, { retainTrace: true });
    const max = getBrushDisplayLimits(length, 8, 19).maxWidth;
    assert.ok(frame.length > 0);
    assert.ok(frame.flatMap(op => op.points).every(p => Number.isFinite(p[1]) && Number.isFinite(p[2])));
    assert.ok(frame.flatMap(op => op.points).every(p => Math.abs(p[2] - 300) <= max * 0.62 + 0.6));
  }
});

test("closed and returning paths keep palette/alpha local to travel, never a degenerate full-loop gradient", () => {
  const loop = Array.from({ length: 65 }, (_, i) => ({ x: 0.5 + Math.cos(i / 64 * Math.PI * 2) * 0.28, y: 0.5 + Math.sin(i / 64 * Math.PI * 2) * 0.28 }));
  const returning = [{ x: 0.1, y: 0.4 }, { x: 0.8, y: 0.4 }, { x: 0.1, y: 0.42 }, { x: 0.8, y: 0.44 }];
  for (const controls of [loop, returning]) for (const multi of [false, true]) {
    const { draw } = harness("calligraphy", 800, controls, multi);
    const retained = draw(1, { retainTrace: true });
    if (!multi) assert.ok(retained.every(op => typeof op.color === "string"), "monochrome retained ink is a solid full-loop fill");
    const animated = draw(0.95, { trailRetention: 0.8 });
    assert.ok(animated.length > 1, "animated alpha needs local travel-aware spans");
    for (const op of [...retained, ...animated]) {
      if (typeof op.color === "string") continue;
      const [x1, y1, x2, y2] = op.color.args;
      assert.ok(Math.hypot(x2 - x1, y2 - y1) > 0.001, "a gradient must never collapse onto a closed loop endpoint");
      assert.ok(op.color.stops.every(([p, color]) => Number.isFinite(p) && p >= 0 && p <= 1 && !color.includes("NaN")));
      assert.ok(op.color.stops.every(([p], i) => !i || p >= op.color.stops[i - 1][0]), "gradient stops follow traveled distance");
    }
    draw(0.2, { trailRetention: 0.8 });
    assert.deepEqual(draw(0.95, { trailRetention: 0.8 }, 10000), animated);
  }
});
