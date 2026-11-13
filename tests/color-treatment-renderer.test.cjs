const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

const load = createTypeScriptLoader();
const { colorTreatmentForIndex, resolveColorTreatment, pigmentHsl, createNaturalPigment, sampleNaturalPigment } = load("engine/colorTreatment.ts");
const { hashStr } = load("simulation/rng.ts");
const { resolveVisualSignature, buildVisualPath, sampleWidthProfile } = load("engine/visualSignature.ts");
const { getStrokePlayback, strokeDistanceAtTime } = load("engine/strokePlayback.ts");
const { MeteorRenderer } = load("render/meteorRenderer.ts");

const MATERIALS = [
  { style: "hard", intensity: 0.65 },
  { style: "soft", intensity: 0.73 },
  { style: "watercolor", intensity: 0.79 },
  { style: "texture", intensity: 0.9 },
  { style: "calligraphy", intensity: 0.79 },
];
const MODES = ["linear", "curved", "spiral", "recursive", "oscillatory", "fragmented"];
const PIGMENTS = ["color", "core", "rim", "groove"];

function artwork(material, count = 16, geometry = "curved", tone = "bright") {
  return {
    id: `pigment-${material.style}-${count}-${geometry}`,
    agent_id: "pigment-agent", from: "ink", to: "flight", motion_type: "direct",
    created_at: 100, timestamp: 100, base_seed: 456, variation_seed: 987321,
    generation_mode: "autonomous", geometry_mode: geometry, motion_model: "wave",
    brush_treatment: material.style === "calligraphy" ? "calligraphy" : "original",
    color_treatment: tone,
    transform: { scale: 1.1, rotation: 0.23, translation: { x: 0.02, y: -0.03 } },
    mood: { timestamp: 100, entropy_shift: 0, drift_bias: 0.28, curvature_bias: 0.35, motion_variation: 0.85, color_variation: -0.1 },
    points: Array.from({ length: count }, (_, step) => ({
      step, anchor: ["ink", "paper", "grain", "fiber", "wing", "wind", "sky", "flight"][step % 8],
      x: count === 1 ? 0.5 : 0.1 + step / (count - 1) * 0.8,
      y: 0.5 + Math.sin(step * 0.7) * 0.12,
      entropy: 0.46 + step % 3 * 0.08, confidence: 0.54 + step % 4 * 0.05,
      intensity: material.intensity, stroke_width: 1, branch: step % 3 === 0 ? 1 : 0,
      duration_ms: 200 + step * 30,
    })),
  };
}

function withoutTone(signature) {
  const copy = structuredClone(signature);
  delete copy.color_treatment;
  return copy;
}

function hsl(value) {
  const match = /^hsl\(([-\d.]+)\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.]+))?\)$/.exec(value);
  assert.ok(match, `expected an HSL pigment, received ${value}`);
  return { hue: Number(match[1]), saturation: Number(match[2]), lightness: Number(match[3]), alpha: match[4] === undefined ? undefined : Number(match[4]) };
}

function paint(value) {
  if (value.startsWith("hsl(")) return { format: "hsl", ...hsl(value) };
  const match = /^rgb\(([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(value);
  assert.ok(match, `expected opaque RGB pigment or an existing HSL color, received ${value}`);
  const rgb = match.slice(1, 4).map(Number);
  assert.ok(rgb.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 255));
  return { format: "rgb", rgb, alpha: match[4] === undefined ? undefined : Number(match[4]) };
}

test("independent allocation gives exactly half muted in every ten/twenty consecutive slots", () => {
  for (const seed of [0, 1, 2, 37, 981, 4294967295]) {
    for (const start of [0, 1, 2, 19, 100]) {
      for (const length of [10, 20]) {
        const tones = Array.from({ length }, (_, i) => colorTreatmentForIndex(start + i, seed));
        assert.equal(tones.filter(tone => tone === "muted").length, length / 2);
        assert.equal(tones.filter(tone => tone === "bright").length, length / 2);
        assert.deepEqual(tones, Array.from({ length }, (_, i) => colorTreatmentForIndex(start + i, seed)));
        for (let i = 1; i < length; i++) assert.notEqual(tones[i], tones[i - 1]);
      }
    }
  }
});

test("legacy assignment is namespaced by stable artwork id, not ordering, neighbours, agents or seeds", () => {
  const works = Array.from({ length: 40 }, (_, index) => ({ id: `legacy-${index}` }));
  const expected = new Map(works.map(path => [path.id, colorTreatmentForIndex(hashStr(`noema-pigment-v1:${path.id}`))]));
  for (const list of [works, [...works].reverse(), works.filter((_, i) => i % 3 === 0)]) {
    for (const path of list) {
      assert.equal(resolveColorTreatment(path), expected.get(path.id));
      assert.equal(resolveColorTreatment({ ...path, base_seed: 100, variation_seed: 999, agent_id: "different" }), expected.get(path.id));
      assert.equal(resolveColorTreatment(JSON.parse(JSON.stringify(path))), expected.get(path.id));
      for (const tone of ["bright", "muted"]) assert.equal(resolveColorTreatment({ ...path, color_treatment: tone }), tone);
    }
  }
  assert.deepEqual(works, Array.from({ length: 40 }, (_, index) => ({ id: `legacy-${index}` })), "resolution cannot mutate old snapshots");
  assert.equal(resolveColorTreatment({ id: "legacy-0", color_treatment: "invalid" }), expected.get("legacy-0"));
});

test("changing only pigment treatment preserves every non-tone signature field, route, width and playback phase", () => {
  for (const material of MATERIALS) for (const count of [1, 4, 16]) for (const geometry of MODES) {
    const bright = artwork(material, count, geometry, "bright");
    const muted = { ...structuredClone(bright), color_treatment: "muted" };
    const before = structuredClone({ bright, muted });
    const a = resolveVisualSignature(bright);
    const b = resolveVisualSignature(muted);
    assert.equal(a.brush_style, material.style);
    assert.equal(a.color_treatment, "bright");
    assert.equal(b.color_treatment, "muted");
    assert.deepEqual(withoutTone(a), withoutTone(b), `${material.style}/${count}/${geometry}: palette hues, pressure, duration and motion remain exact`);
    assert.deepEqual(buildVisualPath(bright.points, a, bright.variation_seed), buildVisualPath(muted.points, b, muted.variation_seed));
    const timeA = getStrokePlayback(bright), timeB = getStrokePlayback(muted);
    assert.deepEqual(timeA, timeB);
    for (const progress of [0, 0.02, 0.17, 0.5, 0.83, 1]) {
      assert.equal(sampleWidthProfile(a.width_profile, progress), sampleWidthProfile(b.width_profile, progress));
      assert.equal(strokeDistanceAtTime(progress, timeA), strokeDistanceAtTime(progress, timeB));
    }
    assert.deepEqual({ bright, muted }, before, "appearance resolution must not rewrite original artwork");
  }
});

test("the bright palette retains its original hue, saturation and lightness exactly", () => {
  for (const hue of [0, 37.2, 118, 210, 299.9, 359.9]) {
    for (const saturation of [52, 61, 68, 82, 88]) {
      for (const lightness of [2, 5, 21, 23, 30, 32, 37, 47, 59, 67, 76, 86, 88, 100]) {
        const bright = hsl(pigmentHsl(hue, saturation, lightness));
        assert.equal(bright.hue, hue);
        assert.equal(bright.saturation, saturation);
        assert.equal(bright.lightness, lightness);
        assert.equal(bright.alpha, undefined);
      }
    }
  }
});

// Record the real renderer's commands, not a substitute drawing algorithm.
// Colors are separate from coordinates and alpha so invariance is testable.
class Context {
  constructor() {
    this.frame = []; this.stack = []; this.globalAlpha = 1;
    this.fillStyle = "black"; this.strokeStyle = "black"; this.lineWidth = 1;
    this.lineCap = "butt"; this.lineJoin = "miter"; this.clips = [];
  }
  setTransform(...args) { this.transform = args; }
  clearRect() { this.frame = []; }
  beginPath() { this.points = []; }
  moveTo(...args) { this.points.push(["M", ...args]); }
  lineTo(...args) { this.points.push(["L", ...args]); }
  closePath() { this.points.push(["Z"]); }
  arc(...args) { this.points.push(["arc", ...args]); }
  ellipse(...args) { this.points.push(["ellipse", ...args]); }
  quadraticCurveTo(...args) { this.points.push(["quadratic", ...args]); }
  bezierCurveTo(...args) { this.points.push(["bezier", ...args]); }
  clip() { this.clips = [...this.clips, structuredClone(this.points)]; }
  color(paint) { return typeof paint === "object" ? structuredClone({ stops: paint.stops, args: paint.args }) : paint; }
  // clip() creates immutable snapshots. Share them across operations just as
  // Canvas shares its active clip, instead of duplicating a large swept shape
  // for every bristle segment. The frame clone still preserves full geometry.
  fill() { this.frame.push({ kind: "fill", points: structuredClone(this.points), alpha: this.globalAlpha, color: this.color(this.fillStyle), transform: this.transform, composite: this.globalCompositeOperation, clips: this.clips }); }
  stroke() { this.frame.push({ kind: "stroke", points: structuredClone(this.points), alpha: this.globalAlpha, color: this.color(this.strokeStyle), width: this.lineWidth, cap: this.lineCap, join: this.lineJoin, transform: this.transform, composite: this.globalCompositeOperation, clips: this.clips }); }
  createLinearGradient(...args) { const stops = []; return { args, stops, addColorStop: (position, color) => stops.push([position, color]) }; }
  createRadialGradient(...args) { return this.createLinearGradient(...args); }
  save() {
    const state = {};
    for (const key of ["globalAlpha", "fillStyle", "strokeStyle", "lineWidth", "lineCap", "lineJoin", "globalCompositeOperation", "transform", "clips"]) state[key] = this[key];
    this.stack.push(state);
  }
  restore() { assert.ok(this.stack.length); Object.assign(this, this.stack.pop()); }
}

function geometryOnly(frame) {
  return frame.map(({ color, ...operation }) => ({
    ...operation,
    // Gradient positions and alpha encode material/time, not tone.
    pigmentGeometry: typeof color === "string" ? { alpha: paint(color).alpha } : {
      args: color.args,
      stops: color.stops.map(([position, value]) => [position, paint(value).alpha]),
    },
  }));
}

function harness(path, controls) {
  const context = new Context();
  const renderer = new MeteorRenderer({ style: {}, getContext: () => context });
  renderer.resize(1000, 600, 2);
  const store = { controlPointsOf: () => controls, transformOf: () => path.transform };
  const original = structuredClone(path);
  return {
    renderer,
    draw(progress, retainTrace, time = 0) {
      renderer.draw(time, [path], [], store, null, null, { scale: 1, translateX: 0, translateY: 0 }, new Map([[path.id, progress]]), { retainTrace, trailRetention: 0.2 });
      assert.deepEqual(path, original, "rendering must leave archived attributes and coordinates unchanged");
      return structuredClone(context.frame);
    },
  };
}

test("all five materials keep identical point/short/long drawing commands, alpha, width and hit areas in animated and retained modes", () => {
  const cases = [
    { label: "point", count: 1, controls: [{ x: 0.5, y: 0.5 }] },
    { label: "short", count: 4, controls: [{ x: 0.49, y: 0.5 }, { x: 0.51, y: 0.505 }] },
    { label: "long", count: 16, controls: [{ x: 0.1, y: 0.3 }, { x: 0.35, y: 0.42 }, { x: 0.6, y: 0.37 }, { x: 0.88, y: 0.65 }] },
  ];
  for (const material of MATERIALS) for (const item of cases) {
    const original = artwork(material, item.count, "curved", "bright");
    const toned = { ...structuredClone(original), color_treatment: "muted" };
    const bright = harness(original, item.controls), muted = harness(toned, item.controls);
    for (const retainTrace of [false, true]) for (const progress of [0.12, 0.65, 1]) {
      const a = bright.draw(progress, retainTrace), b = muted.draw(progress, retainTrace);
      assert.ok(a.length > 0, `${material.style}/${item.label} produces a visible frame`);
      assert.deepEqual(geometryOnly(a), geometryOnly(b), `${material.style}/${item.label}/${retainTrace}/${progress}: only pigment may change`);
      assert.notDeepEqual(a.map(op => op.color), b.map(op => op.color));
      for (const [x, y] of [[500, 300], [100, 180], [880, 390], [350, 252]]) {
        assert.equal(bright.renderer.hitTest(x, y, 2), muted.renderer.hitTest(x, y, 2));
      }
      assert.deepEqual(muted.draw(progress, retainTrace, 999999), b, "replay and wall-clock changes cannot reroll tone");
    }
    // Every muted layer must come from the native pigment recipe, not a filter
    // applied to the bright material's HSL values (including invisible layers).
    const a = bright.renderer.cache.get(original.id), b = muted.renderer.cache.get(original.id);
    assert.ok(a && b);
    assert.equal(a.samples.length, b.samples.length);
    const profile = createNaturalPigment(toned.id, b.signature.color_count);
    for (let i = 0; i < a.samples.length; i++) {
      const source = a.samples[i], target = b.samples[i];
      // Retained source corners make sample spacing nonuniform. Pigment still
      // follows travelled distance, never the number of inserted samples.
      const expected = sampleNaturalPigment(profile, target.progress, target.texture, material.style);
      for (const key of PIGMENTS) {
        const one = paint(source[key]), two = paint(target[key]);
        assert.equal(one.format, "hsl", "bright pigments keep the old recipe");
        assert.equal(two.format, "rgb", "muted pigments are authored RGB materials, not desaturated original hues");
        assert.equal(target[key], expected[key], `${key} uses the natural pigment family`);
        assert.equal(two.alpha, one.alpha);
      }
      const strip = sample => Object.fromEntries(Object.entries(sample).filter(([key]) => !PIGMENTS.includes(key)));
      assert.deepEqual(strip(source), strip(target), "normals, pressure and texture sampling stay byte-exact");
    }
    assert.deepEqual(bright.draw(0, false), []);
    assert.deepEqual(muted.draw(0, false), []);
  }
});
