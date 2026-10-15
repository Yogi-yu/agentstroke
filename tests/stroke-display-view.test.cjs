const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const load = createTypeScriptLoader();
const { strokeDisplayView } = load("engine/strokeDisplayView.ts");
const { StrokeStore } = load("state/strokeStore.ts");
const { StrokeEditor } = load("canvas/StrokeEditor.ts");
const { centroidOf, applyTransform } = load("engine/strokeMutation.ts");
const { worldToScreen, screenToWorld } = load("store/canvasTransform.ts");
const { sampleMeteorCenterline, sampleBrushMaterial } = load("render/meteorRenderer.ts");

const identity = { translation: { x: 0, y: 0 }, rotation: 0, scale: 1 };
const camera = { scale: 1, translateX: 0, translateY: 0 };
const desktop = { width: 1440, height: 900 };
const near = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} ≈ ${expected}`);
const nearPoint = (actual, expected, epsilon) => { near(actual.x, expected.x, epsilon); near(actual.y, expected.y, epsilon); };
const copy = (value) => JSON.parse(JSON.stringify(value));

// Read-only reproduction of the reported stroke's actual source coordinates,
// seed and visual signature. It is never sent to an API or saved to the app.
const reported = {
  id: "stroke-1791988101499-agent-004", agent_id: "agent-004",
  created_at: 1791988101499, timestamp: 1791988101499,
  from: "chaos", to: "order", motion_type: "fractal", model: "meta-llama/llama-3.1-70b-instruct",
  base_seed: 2569074039, variation_seed: 1271584350,
  geometry_mode: "recursive", branching_model: "tree", motion_model: "jitter", semantic_depth: 9,
  points: [
    [0.3198, 0.3922195813152939],
    [0.4409796643815031, 0.39714947564805547],
    [0.514393580403596, 0.30287054975511674],
    [0.512370017236877, 0.1950017660824464],
    [0.5653530753198733, 0.09944983732933639],
    [0.6864353220784176, 0.05890864012186677],
    [0.7570190358401782, 0.16548041015841125],
    [0.8536392128481922, 0.21778685807279063],
    [0.8845687757883379, 0.32213863313074],
  ].map(([x, y], step) => ({
    x, y, step,
    anchor: ["chaos", "randomness", "disorganization", "confusion", "transition", "reorganization", "structure", "pattern", "order"][step],
    entropy: [.3868703810843656, .284690891856272, .24664495863790514, .02476612913517695, .06375330773772042, .11362762239700235, 0, 0, 0][step],
    confidence: [.2, .313125, .42625, .5393749999999999, .6525, .765625, .87875, .9918750000000001, 1][step],
    intensity: [.5032824047289086, .585389777035932, .6514637603405238, .7634959677162058, .8103116730655698, .8544055944007494, .9393750000000001, .9959375, 1][step],
    stroke_width: [2.7990791694387367, 3.0110468924705085, 3.047384027953418, 3.8001800922371216, 4.923836481748322, 4.630586696076878, 6, 5.104004917626641, 4.703931089495466][step],
    branch: [0, 0, 0, 1, 2, 0, 2, 0, 0][step],
    duration_ms: [252, 121, 138, 135, 54, 77, 44, 88, 53][step],
  })),
  mood: {
    timestamp: 1791988101499, entropy_shift: -.6176583182799867,
    drift_bias: .11870540080628458, curvature_bias: .2726047625767085,
    motion_variation: .31316641803361217, color_variation: .3021017217234356,
  },
  visual_signature: {
    version: 1, length: 2.302, length_class: "short", width_ratio: .00196,
    crossings: 0, motion_pattern: "fold", motion_amplitude: .201, motion_curvature: .273,
    motion_seed: 1271584350, brush_heads: ["ring", "diamond"], brush_style: "watercolor",
    color_temperature: 1, color_mode: "monochrome", color_count: 1, color_hues: [301.4],
    hue_start: 301.4, hue_end: 301.4, speed_profile: [.424, .825, 1.131, 1.767, 1.516],
    turn_angle_deg: 54.4, turn_count: 3, turn_sharpness: .449, direction_angle_deg: 42.7,
    reversal_count: 0, width_change_count: 1, width_profile: [2.075, .267],
  },
};

function setup() {
  const path = copy(reported);
  const store = new StrokeStore();
  store.setData([path], []);
  return { store, path, points: store.controlPointsOf(path.id) };
}

function bounds(points, viewport = { width: 1, height: 1 }, view = camera) {
  const screen = points.map((point) => worldToScreen(point, view));
  const width = (Math.max(...screen.map((point) => point.x)) - Math.min(...screen.map((point) => point.x))) * viewport.width;
  const height = (Math.max(...screen.map((point) => point.y)) - Math.min(...screen.map((point) => point.y))) * viewport.height;
  return { width, height, extent: Math.max(width, height) };
}

test("reported folded short stroke gains a readable footprint rather than using its misleading arc length", () => {
  const { store, path, points } = setup();
  const before = JSON.stringify(path);
  const natural = bounds(points, desktop);
  assert.ok(natural.width > 17 && natural.width < 19);
  assert.ok(natural.height > 10 && natural.height < 12);
  const rounded = sampleMeteorCenterline(points, desktop.width, desktop.height, path.visual_signature.turn_sharpness);
  assert.ok(rounded.length > 60 && rounded.length < 65, "The old 62px arc hid an approximately 18px footprint");
  const view = strokeDisplayView(points, store.transformOf(path.id), desktop, camera);
  const readable = bounds(points, desktop, view);
  assert.ok(view.scale > 4 && view.scale <= 5);
  assert.ok(readable.width >= 72 && readable.width <= 84);
  assert.ok(readable.height >= 42 && readable.height <= 55);
  nearPoint(worldToScreen(centroidOf(points), view), centroidOf(points));
  assert.equal(JSON.stringify(path), before, "Readability does not rewrite signature, semantic data or transform");

  const mobile = { width: 390, height: 720 };
  const mobileView = strokeDisplayView(points, identity, mobile, camera);
  near(mobileView.scale, 5);
  assert.ok(bounds(points, mobile, mobileView).extent > 40);
  assert.ok(bounds(points, mobile, mobileView).extent < 48);
});

test("readability gain is bounded at five and apparent size remains strictly monotonic", () => {
  const viewport = { width: 1000, height: 800 };
  let lastExtent = -1;
  for (const extent of [0, .005, .01, .02, .1, 1, 5, 10, 15, 16, 20, 30, 60, 90, 119.9, 120, 120.1, 180, 500]) {
    const points = [{ x: .25, y: .3 }, { x: .25 + extent / viewport.width, y: .3 }];
    const view = strokeDisplayView(points, identity, viewport, camera);
    assert.ok(view.scale >= 1 - 1e-12 && view.scale <= 5);
    const displayed = bounds(points, viewport, view).extent;
    assert.ok(displayed > lastExtent, `A ${extent}px mark must remain larger than every smaller mark`);
    lastExtent = displayed;
  }
  const aroundCap = [15.6521738, 15.6521740].map((e) => {
    const points = [{ x: 0, y: 0 }, { x: e / 1000, y: 0 }];
    return bounds(points, viewport, strokeDisplayView(points, identity, viewport, camera)).extent;
  });
  assert.ok(aroundCap[1] - aroundCap[0] < .00001, "The max-gain boundary must not cause a size jump");
});

test("true points, empty input, invalid viewports and already readable routes retain their camera", () => {
  const movingCamera = { scale: 1.7, translateX: -.21, translateY: .12 };
  for (const points of [[], [{ x: .3, y: .4 }], [{ x: .3, y: .4 }, { x: .3, y: .4 }]]) {
    assert.equal(strokeDisplayView(points, identity, desktop, movingCamera), movingCamera);
  }
  const small = [{ x: .5, y: .5 }, { x: .51, y: .5 }];
  assert.equal(strokeDisplayView(small, identity, { width: 0, height: 900 }, movingCamera), movingCamera);
  assert.equal(strokeDisplayView(small, identity, { width: 1440, height: 0 }, movingCamera), movingCamera);
  const large = [{ x: .1, y: .2 }, { x: .5, y: .7 }, { x: .8, y: .3 }];
  assert.equal(strokeDisplayView(large, identity, desktop, movingCamera), movingCamera);
});

test("per-stroke view composes with the common camera while preserving the visual centroid", () => {
  const { points } = setup();
  const common = { scale: 2.2, translateX: -.31, translateY: .08 };
  const local = strokeDisplayView(points, identity, desktop, camera);
  const combined = strokeDisplayView(points, identity, desktop, common);
  const center = centroidOf(points);
  near(combined.scale, common.scale * local.scale);
  nearPoint(worldToScreen(center, combined), worldToScreen(center, common));
  for (const point of points) nearPoint(
    worldToScreen(point, combined),
    worldToScreen(worldToScreen(point, local), common),
  );
});

test("manual scaling and rotation cannot be cancelled by recomputing the readability gain", () => {
  const { store, path, points } = setup();
  const original = copy(points);
  const center = centroidOf(original);
  const common = { scale: 1.6, translateX: -.15, translateY: .1 };
  const baseGain = strokeDisplayView(original, identity, desktop, common).scale / common.scale;
  for (const scale of [.25, 1, 2.5, 8]) {
    for (const rotation of [0, .4, Math.PI / 2, 2.7]) {
      const transform = { scale, rotation, translation: { x: .11, y: -.08 } };
      store.updateTransform(path.id, transform);
      const edited = store.controlPointsOf(path.id);
      const view = strokeDisplayView(edited, transform, desktop, common);
      near(view.scale / common.scale, baseGain, 1e-10);
      const movedCenter = { x: center.x + transform.translation.x, y: center.y + transform.translation.y };
      nearPoint(store.pivotOf(path.id), movedCenter);
      nearPoint(worldToScreen(centroidOf(edited), view), worldToScreen(movedCenter, common));
      for (let i = 0; i < edited.length; i += 17) {
        const transformed = applyTransform(original[i], transform, center);
        const enlarged = {
          x: movedCenter.x + (transformed.x - movedCenter.x) * baseGain,
          y: movedCenter.y + (transformed.y - movedCenter.y) * baseGain,
        };
        nearPoint(worldToScreen(edited[i], view), worldToScreen(enlarged, common));
      }
    }
  }
});

test("dragging an enlarged stroke moves every displayed point one CSS pixel per pointer pixel", () => {
  const { store, path } = setup();
  const base = { translation: { x: .04, y: -.02 }, rotation: .37, scale: 1.8 };
  store.updateTransform(path.id, base);
  const common = { scale: 1.7, translateX: -.1, translateY: .07 };
  const beforePoints = copy(store.controlPointsOf(path.id));
  const beforeView = strokeDisplayView(beforePoints, base, desktop, common);
  const startPointer = worldToScreen(beforePoints[31], beforeView);
  const pixelDelta = { x: 84, y: -39 };
  const endPointer = { x: startPointer.x + pixelDelta.x / desktop.width, y: startPointer.y + pixelDelta.y / desktop.height };
  const editor = new StrokeEditor(store);
  // CanvasView correctly inverses the common camera, not the local bonus:
  // the bonus is recentered on the moving centroid and must not slow dragging.
  editor.beginDrag(path.id, screenToWorld(startPointer, common));
  editor.move(screenToWorld(endPointer, common));
  const result = editor.end();
  near(result.transform.translation.x - base.translation.x, pixelDelta.x / desktop.width / common.scale);
  near(result.transform.translation.y - base.translation.y, pixelDelta.y / desktop.height / common.scale);
  near(result.transform.scale, base.scale);
  near(result.transform.rotation, base.rotation);
  const afterPoints = store.controlPointsOf(path.id);
  const afterView = strokeDisplayView(afterPoints, result.transform, desktop, common);
  near(afterView.scale, beforeView.scale);
  for (let i = 0; i < afterPoints.length; i += 13) {
    const before = worldToScreen(beforePoints[i], beforeView);
    const after = worldToScreen(afterPoints[i], afterView);
    near((after.x - before.x) * desktop.width, pixelDelta.x, 1e-7);
    near((after.y - before.y) * desktop.height, pixelDelta.y, 1e-7);
  }
});

test("editor rotation uses the transformed visual pivot rather than semantic-source centroid", () => {
  const { store, path, points } = setup();
  const visualCenter = centroidOf(points);
  const semanticCenter = centroidOf(path.points);
  assert.ok(Math.hypot(visualCenter.x - semanticCenter.x, visualCenter.y - semanticCenter.y) > 1e-6);
  nearPoint(store.pivotOf(path.id), visualCenter);
  const common = { scale: 1.8, translateX: -.2, translateY: .12 };
  const initialView = strokeDisplayView(points, identity, desktop, common);
  const displayCenter = worldToScreen(visualCenter, initialView);
  const start = { x: displayCenter.x + .1, y: displayCenter.y };
  const delta = .6;
  const end = { x: displayCenter.x + Math.cos(delta) * .1, y: displayCenter.y + Math.sin(delta) * .1 };
  const editor = new StrokeEditor(store);
  editor.beginRotate(path.id, screenToWorld(start, common));
  editor.move(screenToWorld(end, common));
  const result = editor.end();
  near(result.transform.rotation, delta);
  nearPoint(store.pivotOf(path.id), visualCenter);
  const rotated = store.controlPointsOf(path.id);
  const nextView = strokeDisplayView(rotated, result.transform, desktop, common);
  near(nextView.scale, initialView.scale);
  nearPoint(worldToScreen(centroidOf(rotated), nextView), displayCenter);
});

test("readability keeps physical material-width caps instead of multiplying them by five", () => {
  for (const style of ["hard", "soft", "watercolor", "texture"]) {
    for (const pressure of [.15, .3, 1, 2.2]) {
      for (const gain of [1, 2, 5]) {
        const rendererScale = Math.max(.8, Math.min(1.16, Math.sqrt(gain))) * 1.12;
        const material = sampleBrushMaterial(style, pressure, .5, .4, .00196, rendererScale);
        assert.ok(material.width > 0 && material.width <= 12);
      }
    }
  }
});

test("display fitting is deterministic and never mutates points, transform, viewport or camera", () => {
  const points = Object.freeze([{ x: .3, y: .4 }, { x: .31, y: .405 }, { x: .305, y: .41 }].map(Object.freeze));
  const transform = Object.freeze({ translation: Object.freeze({ x: .1, y: -.1 }), scale: 2, rotation: .7 });
  const viewport = Object.freeze({ width: 1280, height: 720 });
  const common = Object.freeze({ scale: 1.2, translateX: -.1, translateY: .05 });
  const before = JSON.stringify({ points, transform, viewport, common });
  const expected = strokeDisplayView(points, transform, viewport, common);
  for (let i = 0; i < 20; i++) assert.deepEqual(strokeDisplayView(points, transform, viewport, common), expected);
  assert.equal(JSON.stringify({ points, transform, viewport, common }), before);
});
