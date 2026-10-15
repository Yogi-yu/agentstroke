const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

const load = createTypeScriptLoader();
const {
  createWidthProfile, createVisualSignature, buildVisualPath,
  motionStabilityFromDurations, sampleWidthProfile, sampleProfile,
  WIDTH_STABILITY_CONSTANT_THRESHOLD, WIDTH_STABILITY_FREQUENT_THRESHOLD,
  WIDTH_PRESSURE_MIN, WIDTH_PRESSURE_MAX,
} = load("engine/visualSignature.ts");

// Real local pacing tuples that previously included an almost uniform
// watercolor gesture. No models or application APIs are called by this test.
const PACING_REGRESSIONS = [
  [
    314,
    466,
    356,
    281,
    164,
    189,
    203,
    190,
    84
  ],
  [
    132,
    92,
    100,
    75,
    87,
    66,
    89,
    73,
    66,
    66,
    66,
    66,
    66
  ],
  [
    350,
    471,
    471,
    321,
    223,
    192,
    242,
    192,
    151,
    84
  ],
  [
    535,
    415,
    373,
    225,
    108,
    117,
    472,
    164,
    402,
    134,
    111,
    51,
    119
  ],
  [
    573,
    132,
    163,
    49,
    163,
    41
  ],
  [
    261,
    425,
    437,
    264,
    187,
    100,
    104,
    140,
    131,
    173,
    157,
    118
  ],
  [
    373,
    478,
    455,
    391,
    209,
    165,
    192,
    205,
    204,
    229,
    97
  ],
  [
    136,
    143,
    135,
    98,
    97,
    89,
    66
  ]
];

function makeSignature(durations, seed = 37, geometryMode = "curved") {
  const points = durations.map((duration_ms, index) => ({
    step: index, anchor: String(index), x: 0.2 + index / Math.max(1, durations.length - 1) * 0.6,
    y: 0.5 + Math.sin(index * 0.5) * 0.1, duration_ms,
    entropy: 0.55, confidence: 0.7, intensity: 0.78, branch: 0, stroke_width: 1.5,
  }));
  return { points, signature: createVisualSignature({
    points, seed, baseHue: 210, geometryMode, motionModel: "continuous",
    mood: { timestamp: 1, entropy_shift: 0, drift_bias: 0.3, curvature_bias: 0.4, motion_variation: 0.75, color_variation: 0 },
  }) };
}

test("motion stability keeps its original pacing-uniformity interpretation", () => {
  assert.equal(motionStabilityFromDurations([100, 100, 100]), 1);
  assert.equal(motionStabilityFromDurations([]), 1);
  assert.equal(motionStabilityFromDurations([0, 0]), 1);
  assert.equal(motionStabilityFromDurations([1, 1, 1, 10000]), 0);
  for (const durations of PACING_REGRESSIONS) {
    const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length;
    const deviation = Math.sqrt(durations.reduce((sum, value) => sum + (value - mean) ** 2, 0) / durations.length);
    assert.equal(motionStabilityFromDurations(durations), Math.max(0, Math.min(1, 1 - deviation / mean)));
  }
});

test("only extremely low stability is constant; the precise thresholds select 1–3 or 5–8 changes", () => {
  assert.equal(WIDTH_STABILITY_CONSTANT_THRESHOLD, 0.02);
  assert.equal(WIDTH_STABILITY_FREQUENT_THRESHOLD, 0.45);
  const mediumCounts = new Set(), frequentCounts = new Set();
  for (let seed = 1; seed <= 100; seed++) {
    for (const stability of [0, 0.01, 0.019999]) {
      assert.deepEqual(createWidthProfile(stability, seed), { width_change_count: 0, width_profile: [1, 1] });
    }
    for (const stability of [0.02, 0.039, 0.18, 0.449999]) {
      const count = createWidthProfile(stability, seed).width_change_count;
      assert.ok(count >= 1 && count <= 3);
      mediumCounts.add(count);
    }
    for (const stability of [0.45, 0.68, 1]) {
      const count = createWidthProfile(stability, seed).width_change_count;
      assert.ok(count >= 5 && count <= 8);
      frequentCounts.add(count);
    }
  }
  assert.deepEqual([...mediumCounts].sort(), [1, 2, 3]);
  assert.deepEqual([...frequentCounts].sort(), [5, 6, 7, 8]);
});

test("every counted transition alternates a visibly fine valley with a strong peak", () => {
  for (let seed = 1; seed <= 100; seed++) {
    for (const stability of [0.02, 0.3, 0.45, 0.9]) {
      const { width_change_count: count, width_profile: profile } = createWidthProfile(stability, seed);
      assert.equal(profile.length, count + 1);
      assert.ok(Math.min(...profile) <= 0.3 && Math.max(...profile) >= 1.85);
      assert.ok(Math.max(...profile) / Math.min(...profile) >= 1.85 / 0.3);
      profile.forEach((pressure, index) => {
        assert.ok(Number.isFinite(pressure) && pressure >= WIDTH_PRESSURE_MIN && pressure <= WIDTH_PRESSURE_MAX);
        assert.ok(pressure <= 0.3 || pressure >= 1.85, "extrema must not be normalized back toward a uniform width");
        if (index > 0) {
          assert.ok((pressure > 1) !== (profile[index - 1] > 1), "press/lift extrema must alternate");
          assert.ok(Math.abs(pressure - profile[index - 1]) >= 1.55 - 1e-10);
        }
      });
      assert.deepEqual(createWidthProfile(stability, seed).width_profile, profile);
    }
  }
  assert.notDeepEqual(createWidthProfile(0.8, 17), createWidthProfile(0.8, 18), "seed changes the pressure realization");
});

test("smooth pressure interpolation has no jumps, overshoot or corners at extrema", () => {
  const profile = createWidthProfile(0.8, 37).width_profile;
  assert.equal(sampleWidthProfile([], 0.4), 1);
  assert.equal(sampleWidthProfile([0.7], 0.9), 0.7);
  assert.equal(sampleWidthProfile(profile, -1), profile[0]);
  assert.equal(sampleWidthProfile(profile, 2), profile.at(-1));
  const phases = profile.length - 1;
  for (let phase = 0; phase < phases; phase++) {
    let previous = profile[phase];
    for (let step = 0; step <= 100; step++) {
      const value = sampleWidthProfile(profile, (phase + step / 100) / phases);
      assert.ok(value >= Math.min(profile[phase], profile[phase + 1]) - 1e-9);
      assert.ok(value <= Math.max(profile[phase], profile[phase + 1]) + 1e-9);
      assert.ok((value - previous) * (profile[phase + 1] - profile[phase]) >= -1e-9);
      previous = value;
    }
  }
  for (let phase = 1; phase < phases; phase++) {
    const t = phase / phases, epsilon = 1e-7;
    const center = sampleWidthProfile(profile, t);
    assert.ok(Math.abs(center - profile[phase]) < 1e-9);
    assert.ok(Math.abs((center - sampleWidthProfile(profile, t - epsilon)) / epsilon) < 0.002);
    assert.ok(Math.abs((sampleWidthProfile(profile, t + epsilon) - center) / epsilon) < 0.002);
  }
  assert.equal(sampleProfile([0, 2], 0.25), 0.5, "the existing generic/speed interpolation is not changed");
  assert.equal(sampleWidthProfile([0, 2], 0.25), 0.3125);
});

test("current pacing regressions now all vary, with most entering the frequent-change band", () => {
  let frequent = 0;
  for (const [index, durations] of PACING_REGRESSIONS.entries()) {
    const { signature } = makeSignature(durations, index + 1);
    assert.ok(signature.width_change_count > 0, "ordinary existing pacing must not remain constant");
    if (signature.width_change_count >= 5) frequent++;
  }
  assert.ok(frequent / PACING_REGRESSIONS.length >= 0.75);
  const formerConstant = motionStabilityFromDurations([573, 132, 163, 49, 163, 41]);
  assert.ok(formerConstant < 0.18 && formerConstant >= 0.02);
  assert.ok(createWidthProfile(formerConstant, 1517327264).width_change_count > 0);
});

test("pressure variation changes neither the one-stroke centerline nor its topology", () => {
  for (const mode of ["linear", "curved", "oscillatory", "recursive", "spiral", "fragmented"]) {
    const { points, signature } = makeSignature(PACING_REGRESSIONS[0], 37, mode);
    const constant = { ...signature, width_change_count: 0, width_profile: [1, 1] };
    assert.deepEqual(buildVisualPath(points, signature, 37), buildVisualPath(points, constant, 37));
    assert.equal(signature.crossings, constant.crossings);
    assert.equal(signature.motion_pattern, constant.motion_pattern);
    assert.deepEqual(signature.speed_profile, constant.speed_profile);
  }
});
