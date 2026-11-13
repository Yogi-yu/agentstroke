const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

const load = createTypeScriptLoader();
const { resolveBrushHeadProfile } = load("engine/brushHeadProfile.ts");
const { resolveVisualSignature, buildVisualPath } = load("engine/visualSignature.ts");
const { getStrokePlayback } = load("engine/strokePlayback.ts");
const { normalizeBrushHead, placeBrushHead } = load("engine/brushHeadSweep.ts");
const KEYS = ["intensity", "confidence", "entropy", "motion_variation", "stability", "curvature", "branching", "duration"];
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-10, `${message}: ${actual} != ${expected}`);

function fixture() {
  return {
    id: "radial-nib-1", agent_id: "agent-001", from: "ink", to: "flight",
    created_at: 123, timestamp: 123, motion_type: "curved", geometry_mode: "curved",
    generation_mode: "autonomous", motion_model: "wave", base_seed: 101, variation_seed: 202,
    color_treatment: "muted", brush_treatment: "calligraphy",
    mood: { timestamp: 123, entropy_shift: 0, drift_bias: 0.2, curvature_bias: 0.3, motion_variation: 0.75, color_variation: 0.2 },
    points: [
      { step: 0, anchor: "ink", x: 0, y: 0, intensity: 0.2, confidence: 0.6, entropy: 0.3, branch: 0, duration_ms: 500, stroke_width: 1 },
      { step: 1, anchor: "wing", x: 1, y: 0, intensity: 0.4, confidence: 0.7, entropy: 0.6, branch: 1, duration_ms: 1000, stroke_width: 1 },
      { step: 2, anchor: "flight", x: 1, y: 1, intensity: 0.6, confidence: 0.8, entropy: 0.9, branch: 0, duration_ms: 1500, stroke_width: 1 },
    ],
  };
}
const axis = (profile, key) => profile.axes.find(entry => entry.key === key);
function freezeDeep(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}

test("eight source signals map to the exact contrasted, uniformly fitted clockwise contour", () => {
  const result = resolveBrushHeadProfile(fixture());
  assert.equal(result.version, 2);
  assert.equal(result.previewOnly, false);
  assert.equal(result.hasData, true);
  assert.deepEqual(result.axes.map(entry => entry.key), KEYS);
  assert.equal(result.vertices.length, 8);
  const expected = [0.56, 0.88, 0.57, 0.75, 1 - Math.sqrt(1 / 6) - 0.65 * 2 / 3, 0.5, 0.425, Math.log(4) / (Math.log(4) + 2)];
  for (const [index, entry] of result.axes.entries()) {
    close(entry.signalValue, expected[index], entry.key);
    assert.equal(entry.angleDegrees, index * 45);
    assert.equal(entry.available, true);
    assert.ok(entry.source.length > 30, `${entry.key} explains its source and scale`);
    assert.ok(entry.label.length > 0);
    const angle = (entry.angleDegrees - 90) * Math.PI / 180;
    close(result.vertices[index].x, Math.cos(angle) * entry.value, `${entry.key} x`);
    close(result.vertices[index].y, Math.sin(angle) * entry.value, `${entry.key} y`);
    close(Math.hypot(result.vertices[index].x, result.vertices[index].y), entry.value, `${entry.key} radius`);
    assert.ok(entry.value >= 0.16 && entry.value <= 1, "every axis belongs to one connected core");
  }
  close(Math.max(...result.axes.map(entry => entry.value)), 1, "uniform contour fit");
  for (const [index, point] of normalizeBrushHead(result).entries()) {
    close(point.x, result.vertices[index].x, "preview and renderer x");
    close(point.y, result.vertices[index].y, "preview and renderer y");
  }
  assert.equal(axis(result, "duration").rawValue, 3000);
  close(axis(result, "branching").rawValue, 1 / 3, "raw branch density");
});

test("nib profile is stable and independent of identity, seed, pigment, camera and time", () => {
  const original = freezeDeep(fixture());
  const before = structuredClone(original);
  const expected = resolveBrushHeadProfile(original);
  const different = {
    ...before, id: "another-artwork", agent_id: "another-agent", from: "river", to: "shore",
    created_at: 999999, timestamp: 999999, base_seed: 900, variation_seed: 444,
    color_treatment: "bright", brush_treatment: "original", model: "different-model",
    transform: { rotation: 2.4, scale: 5, translation: { x: 100, y: -40 } },
    visual_signature: { stale: true },
    mood: { ...before.mood, timestamp: 999999, drift_bias: -0.9, curvature_bias: -0.8, color_variation: -1, entropy_shift: 1 },
  };
  assert.deepEqual(resolveBrushHeadProfile(different), expected);
  assert.deepEqual(resolveBrushHeadProfile(JSON.parse(JSON.stringify(original))), expected);
  assert.deepEqual(original, before, "derivation leaves the original artwork untouched");
});

test("each independent source changes only its own signal before uniform contour fitting", () => {
  const original = fixture();
  const before = resolveBrushHeadProfile(original);
  const cases = [
    ["intensity", stroke => { stroke.points.forEach(point => { point.intensity = 0.85; }); }],
    ["confidence", stroke => { stroke.points.forEach(point => { point.confidence = 0.2; }); }],
    ["entropy", stroke => { stroke.points.forEach(point => { point.entropy = 0.1; }); }],
    ["motion_variation", stroke => { stroke.mood.motion_variation = 0.2; }],
    ["stability", stroke => { stroke.points.forEach(point => { point.duration_ms = 1000; }); }],
    ["curvature", stroke => { stroke.points[2].x = 2; stroke.points[2].y = 0; }],
    ["branching", stroke => { stroke.points.forEach(point => { point.branch = 0; }); }],
    ["duration", stroke => { stroke.points.forEach(point => { point.duration_ms *= 2; }); }],
  ];
  for (const [target, change] of cases) {
    const stroke = structuredClone(original); change(stroke);
    const after = resolveBrushHeadProfile(stroke);
    assert.notEqual(axis(after, target).signalValue, axis(before, target).signalValue, `${target} must affect its signal`);
    for (let index = 0; index < KEYS.length; index++) {
      if (KEYS[index] === target) continue;
      close(after.axes[index].signalValue, before.axes[index].signalValue, `${target} does not change ${KEYS[index]} source`);
    }
  }
});

test("curvature distinguishes straight, right-angle and reversal travel without invented repeated-point corners", () => {
  for (const [coordinates, expected] of [
    [[[0, 0], [1, 0], [2, 0]], 0],
    [[[0, 0], [1, 0], [1, 1]], 0.5],
    [[[0, 0], [1, 0], [0, 0]], 1],
    [[[0, 0], [0, 0], [1, 0]], 0],
    [[[0, 0], [1, 0], [1, -1]], 0.5],
  ]) {
    const stroke = fixture();
    stroke.points.forEach((point, index) => { [point.x, point.y] = coordinates[index]; });
    close(axis(resolveBrushHeadProfile(stroke), "curvature").rawValue, expected, "source angle / pi");
  }
});

test("dwell and branch normalization preserve differences above their old saturation limits", () => {
  const stroke = fixture();
  stroke.points.forEach(point => { point.duration_ms = 5000; point.branch = 4; });
  const result = resolveBrushHeadProfile(stroke);
  assert.equal(axis(result, "duration").rawValue, 15000);
  assert.ok(axis(result, "duration").signalValue < 1);
  assert.equal(axis(result, "branching").rawValue, 4);
  close(axis(result, "branching").signalValue, 0.8, "branch count remains distinguishable above 1");
  stroke.points.forEach(point => { point.duration_ms *= 2; point.branch *= 2; });
  const larger = resolveBrushHeadProfile(stroke);
  assert.ok(axis(larger, "duration").signalValue > axis(result, "duration").signalValue);
  assert.ok(axis(larger, "branching").signalValue > axis(result, "branching").signalValue);
  stroke.points.forEach(point => { point.duration_ms = 0; point.branch = 0; });
  const zero = resolveBrushHeadProfile(stroke);
  assert.equal(axis(zero, "duration").signalValue, 0);
  assert.equal(axis(zero, "branching").signalValue, 0);
  assert.equal(axis(zero, "stability").value, 1);
  for (const key of ["duration", "branching"]) {
    const index = KEYS.indexOf(key);
    close(Math.hypot(zero.vertices[index].x, zero.vertices[index].y), 0.16, "a true zero preserves the documented connected core");
  }
});

test("empty and legacy records remain safe and missing values are explicit", () => {
  const empty = resolveBrushHeadProfile({ ...fixture(), points: [], mood: undefined });
  assert.equal(empty.hasData, false);
  assert.ok(empty.axes.every(entry => entry.rawValue === null && !entry.available && entry.value === 0));
  assert.ok(empty.vertices.every(point => point.x === 0 && point.y === 0));
  assert.deepEqual(resolveBrushHeadProfile({ ...fixture(), points: undefined, mood: undefined }), empty);
  const legacy = fixture(); delete legacy.mood;
  const missingMotion = axis(resolveBrushHeadProfile(legacy), "motion_variation");
  assert.equal(missingMotion.rawValue, null);
  assert.equal(missingMotion.available, false);
  assert.equal(missingMotion.signalValue, 0);
  assert.ok(missingMotion.value >= 0.16, "missing sources retain a documented connected core");
  const single = resolveBrushHeadProfile({ ...fixture(), points: [fixture().points[0]] });
  assert.equal(axis(single, "curvature").rawValue, 0);
});

test("nonfinite and out-of-range legacy signals cannot escape the chart", () => {
  const stroke = fixture();
  stroke.mood.motion_variation = Infinity;
  stroke.points[0] = { ...stroke.points[0], intensity: NaN, confidence: -2, entropy: Infinity, duration_ms: -40, branch: -3, x: NaN };
  stroke.points[1] = { ...stroke.points[1], intensity: 7, confidence: 8, entropy: -1, duration_ms: Infinity, branch: NaN };
  stroke.points[2] = { ...stroke.points[2], intensity: undefined, confidence: undefined, entropy: undefined, duration_ms: NaN, branch: Infinity };
  const result = resolveBrushHeadProfile(stroke);
  assert.equal(axis(result, "intensity").rawValue, 1);
  assert.equal(axis(result, "confidence").rawValue, 0.5);
  assert.equal(axis(result, "entropy").rawValue, 0);
  assert.equal(axis(result, "motion_variation").available, false);
  for (const entry of result.axes) {
    assert.ok(Number.isFinite(entry.value) && entry.value >= 0 && entry.value <= 1);
    assert.ok(entry.rawValue === null || Number.isFinite(entry.rawValue));
  }
  assert.ok(result.vertices.every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1));
});

const silhouette = stroke => placeBrushHead(normalizeBrushHead(resolveBrushHeadProfile(stroke)), { x: 0, y: 0, nx: 1, ny: 0, width: 1 });
const silhouetteDistance = (a, b) => Math.sqrt(a.reduce((sum, point, index) => sum + (point.x - b[index].x) ** 2 + (point.y - b[index].y) ** 2, 0) / a.length);

test("equal averages with different source evolution produce visibly different actual silhouettes", () => {
  const rising = fixture();
  rising.points = Array.from({ length: 9 }, (_, index) => ({ ...rising.points[0], x: index, y: 0, branch: 0,
    intensity: 0.1 + index * 0.1, confidence: 0.9 - index * 0.1, entropy: index % 2 ? 0.8 : 0.2, duration_ms: 2000 }));
  const falling = structuredClone(rising);
  falling.points.forEach((point, index) => { point.intensity = rising.points[8 - index].intensity; point.confidence = rising.points[8 - index].confidence; });
  const a = resolveBrushHeadProfile(rising), b = resolveBrushHeadProfile(falling);
  for (const key of ["intensity", "confidence", "entropy", "curvature", "branching", "duration"]) close(axis(a, key).rawValue, axis(b, key).rawValue, `${key} source mean unchanged`);
  assert.ok(silhouetteDistance(silhouette(rising), silhouette(falling)) > 0.25,
    "the difference must survive identical width fitting, not merely change global nib size");
  assert.notEqual(axis(a, "intensity").signalValue, axis(b, "intensity").signalValue);
  assert.notEqual(axis(a, "confidence").signalValue, axis(b, "confidence").signalValue);
});

test("archived agent attributes produce varied silhouettes rather than the same rescaled wedge", () => {
  const strokes = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/archive/published-canvas-2026-10-15.json"), "utf8")).strokes;
  const shapes = strokes.map(silhouette);
  const differences = shapes.flatMap((shape, index) => shapes.slice(index + 1).map(other => silhouetteDistance(shape, other))).sort((a, b) => a - b);
  assert.ok(differences[Math.floor(differences.length / 2)] > 0.15, "typical contour difference exceeds 15% of the unchanged width");
  assert.ok(differences.filter(value => value > 0.1).length / differences.length >= 0.75, "most pairs are clearly different after width fitting");
});

test("all-zero, extreme and missing sources stay one simple star-shaped contact with an intact center", () => {
  const variants = [fixture(), { ...fixture(), points: [{}] }];
  for (let mode = 0; mode < 16; mode++) {
    const stroke = fixture();
    stroke.mood.motion_variation = (mode & 1) ? 1 : 0;
    stroke.points.forEach((point, index) => {
      point.intensity = (mode & 2) ? index / 2 : 0;
      point.confidence = (mode & 4) ? 1 - index / 2 : 0;
      point.entropy = (mode & 8) ? index % 2 : 0;
      point.duration_ms = mode % 3 === 0 ? 0 : 10000 * (index + 1);
      point.branch = mode % 2 === 0 ? 0 : index * 5;
    });
    variants.push(stroke);
  }
  for (const stroke of variants) {
    const profile = resolveBrushHeadProfile(stroke);
    const points = profile.vertices;
    assert.equal(points.length, 8);
    for (let index = 0; index < points.length; index++) {
      const a = points[index], b = points[(index + 1) % points.length];
      assert.ok(Math.hypot(a.x, a.y) >= 0.16 - 1e-10);
      assert.ok(a.x * b.y - a.y * b.x > 0, "every adjacent radial triangle has positive area: no collapsed islands or crossing edges");
    }
    const contact = silhouette(stroke);
    close(Math.max(...contact.map(point => point.x)) - Math.min(...contact.map(point => point.x)), 1, "existing width is exact for every shape");
  }
});

test("preview uses the renderer contour and explicitly separates source signals from fitted radii", () => {
  const preview = fs.readFileSync(path.join(__dirname, "../components/BrushHeadPreview.tsx"), "utf8");
  assert.match(preview, /normalizeBrushHead\(profile\)/);
  assert.match(preview, /Exact contact shape/);
  assert.match(preview, /Signal:/);
  assert.match(preview, /Raw:/);
  assert.match(preview, /Radius /);
  assert.match(preview, /16% core/);
});

test("applied nib derivation does not change the visual signature, generated centerline or playback", () => {
  const stroke = fixture();
  const signature = resolveVisualSignature(stroke);
  const geometry = buildVisualPath(stroke.points, signature, stroke.variation_seed);
  const playback = getStrokePlayback(stroke);
  resolveBrushHeadProfile(stroke);
  assert.deepEqual(resolveVisualSignature(stroke), signature);
  assert.deepEqual(buildVisualPath(stroke.points, resolveVisualSignature(stroke), stroke.variation_seed), geometry);
  assert.deepEqual(getStrokePlayback(stroke), playback);
  const root = path.resolve(__dirname, "..");
  // The renderer now consumes the nib footprint. Trajectory, pressure/pigment
  // signature and the playback clock must remain independent of it.
  for (const file of ["engine/visualSignature.ts", "engine/motionPattern.ts", "engine/strokePlayback.ts"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"), /(?:brushHeadProfile|resolveBrushHeadProfile)/,
      `nib shape must not change authored motion or existing attributes: ${file}`);
  }
});
