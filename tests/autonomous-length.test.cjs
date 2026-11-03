const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

const load = createTypeScriptLoader();
const { AGENT_LENGTH_KNOTS, agentAuthoredDistance, agentAuthoredLength, createVisualSignature, resolveVisualSignature, buildVisualPath, pathLength } = load("engine/visualSignature.ts");
const { skyDisplayView } = load("engine/skyLayout.ts");
const mood = { timestamp: 1000, entropy_shift: .2, drift_bias: .12, curvature_bias: .7, motion_variation: .9, color_variation: .3 };
function source(count, extra = {}) {
  return {
    points: Array.from({ length: count }, (_, step) => ({
      step, anchor: step === 0 ? "origin" : step === count - 1 ? "arrival" : "echo", x: .3 + .4 * step / Math.max(1, count - 1), y: .5,
      entropy: .6, confidence: .7, intensity: .77, stroke_width: 2, branch: 0, duration_ms: 300,
    })),
    mood, baseHue: 210, seed: 37, geometryMode: "spiral", motionModel: "continuous", generationMode: "autonomous",
    ...extra,
  };
}

function decodedTarget(length) {
  const scale = length < 5 ? length / 50 : length <= 6 ? .1 + (length - 5) * .4 : .5 + (length - 6) / 30;
  return scale * 1.12;
}

test("every additional authored transition increases length, including beyond the former 12-anchor saturation", () => {
  let previous = -1;
  for (let count = 2; count <= 64; count++) {
    const length = agentAuthoredLength(count);
    assert.ok(length > previous, `${count} anchors must exceed ${count - 1}`);
    assert.ok(Math.abs(decodedTarget(length) - agentAuthoredDistance(count)) < 1e-12);
    const signature = createVisualSignature(source(count));
    assert.equal(signature.length, Number(length.toFixed(3)));
    assert.equal(signature.length_class, count <= 6 ? "short" : count <= 11 ? "medium" : "long");
    if (count > 2) assert.ok(signature.length > Number(agentAuthoredLength(count - 1).toFixed(3)), "Persisted rounded lengths must also remain distinct");
    previous = length;
  }
  assert.equal(agentAuthoredLength(1), 0);
  assert.equal(agentAuthoredLength(64), 21);
});

test("the authored contrast curve is continuous at every knot and emphasizes typical path lengths", () => {
  for (const [count, distance] of AGENT_LENGTH_KNOTS) {
    assert.ok(Math.abs(agentAuthoredDistance(count) - distance) < 1e-12);
    if (count > 1 && count < 64) {
      const below = agentAuthoredDistance(count - 1e-6);
      const above = agentAuthoredDistance(count + 1e-6);
      assert.ok(below < distance && above > distance);
      assert.ok(above - below < 1e-6, "No categorical jump at a knot");
    }
  }
  assert.deepEqual([5, 8, 12, 16].map(n => Number(agentAuthoredDistance(n).toFixed(3))), [.05, .18, .62, .9]);
  assert.ok(agentAuthoredDistance(16) / agentAuthoredDistance(5) >= 18 - 1e-12);
  assert.equal(agentAuthoredDistance(NaN), 0);
  assert.equal(agentAuthoredDistance(0), 0);
  assert.equal(agentAuthoredDistance(100), 1.12);
});

test("Sky's shared camera preserves strong visible length contrast instead of equalizing each mark", () => {
  const box = { centerX: .5, centerY: .5, width: .28, height: .28 };
  const results = [5, 8, 12, 16].map(count => {
    const input = source(count, { geometryMode: "linear" });
    const signature = { ...createVisualSignature(input), direction_angle_deg: 0 };
    const points = buildVisualPath(input.points, signature, 37);
    const view = skyDisplayView(points, box);
    const projected = points.map(p => ({ x: p.x * view.scale + view.translateX, y: p.y * view.scale + view.translateY }));
    return { count, view, length: pathLength(projected), extent: Math.max(...projected.map(p => p.x)) - Math.min(...projected.map(p => p.x)) };
  });
  for (const result of results) assert.equal(result.view.scale, results[0].view.scale);
  for (let index = 1; index < results.length; index++) {
    assert.ok(results[index].length > results[index - 1].length);
    assert.ok(results[index].extent > results[index - 1].extent);
  }
  assert.ok(results[3].length / results[0].length > 17.9);
  assert.ok(results[3].extent / results[0].extent > 17.9);
});

test("new source length is owned by the agent's step count, not dwell, intensity, entropy, seed or mood", () => {
  for (const mode of ["autonomous", "example"]) {
    for (const count of [2, 7, 8, 20, 32, 33, 64]) {
      const original = source(count, { generationMode: mode });
      const expected = createVisualSignature(original);
      for (const value of [0, .01, .5, 1]) {
        const candidate = createVisualSignature({
          ...original,
          seed: Math.floor(value * 10000) + 100,
          points: original.points.map((point, i) => ({
            ...point, intensity: value, entropy: value, confidence: value,
            duration_ms: value * (i + 1) * 20000,
          })),
          mood: { timestamp: value * 10000, entropy_shift: value, drift_bias: value, curvature_bias: -value, motion_variation: value, color_variation: value },
        });
        assert.equal(candidate.length, expected.length);
        assert.equal(candidate.length_class, expected.length_class);
      }
    }
  }
});

test("display resolver retains authored length mode and ignores stale stored visual signatures", () => {
  const input = source(23);
  const expected = createVisualSignature(input);
  const path = {
    id: "authored-path", timestamp: 1000, points: input.points, mood, variation_seed: 37,
    geometry_mode: "spiral", motion_model: "continuous", generation_mode: "autonomous",
    visual_signature: { length: 1, length_class: "short" },
  };
  assert.deepEqual(resolveVisualSignature(path, 210), expected);
  assert.equal(resolveVisualSignature({ ...path, generation_mode: "example" }, 210).length, expected.length);
  assert.notEqual(resolveVisualSignature({ ...path, generation_mode: undefined }, 210).length, expected.length);
});

test("historical paths retain the prior duration/depth/intensity formula when no authored mode exists", () => {
  for (const count of [2, 4, 9, 13, 32]) {
    for (const duration of [0, 120, 500, 12000]) {
      for (const intensity of [0, .01, .4, .9]) {
        const input = source(count, { generationMode: undefined });
        input.points = input.points.map((point) => ({ ...point, duration_ms: duration, intensity }));
        const actual = createVisualSignature(input);
        const depth = Math.max(0, Math.min(1, (count - 2) / 10));
        const dwell = Math.max(0, Math.min(1, count * duration / 6000));
        const energy = Math.max(0, Math.min(1, dwell * .62 + depth * .28 + intensity * .1));
        const expected = intensity < .015 ? 0 : 21 * Math.pow(energy, 2.25);
        assert.equal(actual.length, Number(expected.toFixed(3)));
        assert.equal(actual.length_class, expected < 5 ? "short" : expected <= 6 ? "medium" : "long");
      }
    }
  }
});

test("rendered authored paths follow the continuous target instead of a fixed category template", () => {
  let previous = 0;
  for (let count = 2; count <= 64; count++) {
    const input = source(count);
    // A compact orbit needs no boundary fitting, isolating the length mapping
    // from the existing camera-safe fit that can shorten wide straight paths.
    const signature = { ...createVisualSignature(input), reversal_count: 3, direction_angle_deg: 0 };
    const points = buildVisualPath(input.points, signature, 37);
    const travelled = pathLength(points);
    assert.ok(travelled > previous);
    assert.ok(Math.abs(travelled - decodedTarget(signature.length)) < 1e-8);
    previous = travelled;
  }
});
