const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

const load = createTypeScriptLoader();
const { createVisualSignature, buildVisualPath, pathLength } = load("engine/visualSignature.ts");
const { buildMotionPath, countPathCrossings, MOTION_PATTERN_BY_GEOMETRY } = load("engine/motionPattern.ts");
const MODES = ["linear", "curved", "oscillatory", "recursive", "spiral", "fragmented"];

function fixture(mode = "linear", seed = 37) {
  const points = Array.from({ length: 6 }, (_, step) => ({
    step, anchor: String(step), x: 0.2 + step * 0.12, y: 0.5 + Math.sin(step * 0.7) * 0.1,
    entropy: 0.85, confidence: 0.62, intensity: 0.78, stroke_width: 1.5, branch: 0, duration_ms: 1000,
  }));
  const signature = createVisualSignature({
    points, seed, baseHue: 210, geometryMode: mode, motionModel: "continuous",
    mood: { timestamp: 1, entropy_shift: 0.2, drift_bias: 0, curvature_bias: 0.65, motion_variation: 0.95, color_variation: 0 },
  });
  return { points, signature };
}

function finiteBounded(points) {
  assert.ok(points.length >= 2 && points.length <= 162, "bounded single path sample count");
  for (const point of points) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.ok(point.x >= 0.015 - 1e-9 && point.x <= 0.985 + 1e-9, "x remains inside canvas");
    assert.ok(point.y >= 0.015 - 1e-9 && point.y <= 0.985 + 1e-9, "y remains inside canvas");
  }
  for (let index = 1; index < points.length; index++) {
    assert.ok(Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y) <= 1.12 / 96 + 1e-8,
      "a single continuous flight must not teleport between detached motifs");
  }
}

test("six geometry modes preserve six visibly different continuous motion families", () => {
  const fingerprints = [];
  const metrics = {};
  for (const mode of MODES) {
    const { points, signature } = fixture(mode);
    assert.equal(signature.motion_pattern, MOTION_PATTERN_BY_GEOMETRY[mode]);
    const motion = buildMotionPath(points, signature, 37);
    assert.equal(motion.pattern, MOTION_PATTERN_BY_GEOMETRY[mode]);
    assert.deepEqual(buildVisualPath(points, signature, 37), motion.points);
    finiteBounded(motion.points);
    fingerprints.push(JSON.stringify(motion.points));
    metrics[mode] = pathLength(motion.points) / Math.max(1e-9, Math.hypot(
      motion.points.at(-1).x - motion.points[0].x, motion.points.at(-1).y - motion.points[0].y,
    ));
  }
  assert.equal(new Set(fingerprints).size, 6, "crossings must not replace all geometry modes with one weave");
  assert.ok(metrics.linear < 1.01, "glide remains a direct flight");
  assert.ok(metrics.curved > 1.1, "arc has a broad sweep");
  assert.ok(metrics.oscillatory > 1.3, "wave has pronounced lateral lobes");
  assert.ok(metrics.spiral > 2, "orbit travels around a center rather than down a repeated wave template");
});

test("same semantic attributes and seed reproduce the entire motion exactly", () => {
  for (const mode of MODES) {
    const { points, signature } = fixture(mode, 98765);
    const a = buildMotionPath(points, signature, 1);
    const b = buildMotionPath(points, signature, 999);
    assert.deepEqual(a, b, "persisted motion_seed takes precedence over a caller's legacy base seed");
    assert.deepEqual(a, buildMotionPath(points, signature, 1));
  }
  const { points, signature } = fixture("fragmented");
  const legacy = { ...signature, motion_seed: undefined };
  assert.notDeepEqual(buildMotionPath(points, legacy, 1).points, buildMotionPath(points, legacy, 2).points);
});

test("crossings are an enforced ceiling, with dense crossings restricted to long strokes", () => {
  let highCrossingExample = false;
  for (const mode of MODES) {
    for (const lengthClass of ["short", "medium", "long"]) {
      for (const seed of [1, 7, 37, 1337]) {
        for (const budget of [0, 2, 4, 8]) {
          const { points, signature } = fixture(mode, seed);
          const sig = { ...signature, length_class: lengthClass, length: lengthClass === "short" ? 4.7 : lengthClass === "medium" ? 5.8 : 18, crossings: budget };
          const motion = buildMotionPath(points, sig, seed);
          finiteBounded(motion.points);
          assert.equal(motion.crossingsUsed, countPathCrossings(motion.points));
          assert.ok(motion.crossingsUsed <= motion.crossingBudget, `${mode} exceeded its crossing budget`);
          assert.ok(motion.crossingBudget <= (lengthClass === "long" ? 8 : 4));
          assert.ok(motion.turnBudget <= 4 && motion.reversalBudget <= 4);
          if (motion.crossingsUsed > 4) {
            assert.equal(lengthClass, "long");
            highCrossingExample = true;
          }
        }
      }
    }
  }
  assert.ok(highCrossingExample, "long folded paths must retain the ability to use more than four crossings");
});

test("length categories vary continuously down to a point instead of selecting three fixed templates", () => {
  for (const mode of MODES) {
    const { points, signature } = fixture(mode);
    let previous = 0;
    for (const [length, lengthClass] of [[0, "short"], [0.01, "short"], [1, "short"], [4.99, "short"], [5, "medium"], [5.5, "medium"], [6, "medium"], [6.01, "long"], [15, "long"], [21, "long"]]) {
      const sig = { ...signature, length, length_class: lengthClass, crossings: 0, reversal_count: 0 };
      const motion = buildMotionPath(points, sig, 37);
      const travelled = pathLength(motion.points);
      assert.ok(travelled + 1e-8 >= previous, `${mode} must not shrink at a category boundary`);
      assert.ok(travelled <= (lengthClass === "short" ? 0.112 : lengthClass === "medium" ? 0.56 : 1.12) + 1e-8);
      if (length === 0) {
        assert.equal(travelled, 0);
        assert.deepEqual(motion.points[0], motion.points[1]);
      }
      previous = travelled;
    }
  }
});

test("direction rotates the whole grammar and boundary fitting never clamps individual points", () => {
  for (const mode of MODES) {
    const { points, signature } = fixture(mode);
    const source = points.map((point) => ({ ...point, x: 0.5, y: 0.5 }));
    const sig = { ...signature, length: 5.3, length_class: "medium", crossings: 0, direction_angle_deg: 0 };
    const original = buildMotionPath(source, sig, 37).points;
    const rotated = buildMotionPath(source, { ...sig, direction_angle_deg: 90 }, 37).points;
    assert.equal(original.length, rotated.length);
    original.forEach((point, index) => {
      assert.ok(Math.abs(rotated[index].x - (1 - point.y)) < 1e-8);
      assert.ok(Math.abs(rotated[index].y - point.x) < 1e-8);
    });
    const edgeSource = points.map((point) => ({ ...point, x: 0.99, y: 0.01 }));
    const edge = buildMotionPath(edgeSource, { ...signature, length: 21 }, 37);
    finiteBounded(edge.points);
    assert.ok(edge.points.some((point) => point.x < 0.95), "fitting keeps an actual gesture, not a pile on the right edge");
  }
});

test("empty, single-anchor, invalid-coordinate and point paths remain finite", () => {
  const { points, signature } = fixture();
  for (const source of [[], [points[0]], [{ ...points[0], x: NaN, y: Infinity }]]) {
    const motion = buildMotionPath(source, signature, 0);
    assert.equal(pathLength(motion.points), 0);
    finiteBounded(motion.points);
  }
  const legacy = { ...signature, motion_pattern: undefined, motion_amplitude: undefined, motion_curvature: undefined, motion_seed: undefined };
  finiteBounded(buildMotionPath(points, legacy, 7).points);
});

test("crossing counter distinguishes a continuous crossed path, a simple bend and a closed loop", () => {
  assert.equal(countPathCrossings([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 }]), 1);
  assert.equal(countPathCrossings([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]), 0);
  assert.equal(countPathCrossings([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0 }]), 0);
});
