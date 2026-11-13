const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const load = createTypeScriptLoader();
const { getStrokePlayback, strokeDistanceAtTime, strokeLandingAtTime, NIB_LANDING_DURATION_MS } = load("engine/strokePlayback.ts");
const { resolveVisualSignature } = load("engine/visualSignature.ts");
const near = (actual, expected, label = "value", epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: ${actual} != ${expected}`);

function artwork(count = 12, intensity = 0.74, dwell = 260) {
  return {
    id: "nib-landing", agent_id: "agent-test", from: "ink", to: "sky", motion_type: "curved",
    created_at: 1, timestamp: 1, variation_seed: 1212,
    mood: { timestamp: 1, entropy_shift: 0, drift_bias: 0.2, curvature_bias: 0.3, motion_variation: 0.6, color_variation: 0 },
    points: Array.from({ length: count }, (_, index) => ({
      step: index, anchor: `word${index}`, x: index / Math.max(1, count - 1), y: Math.sin(index * 0.4) * 0.12 + 0.5,
      confidence: 0.6, intensity, entropy: 0.4, duration_ms: dwell + index * 35, branch: 0, stroke_width: 1,
    })),
  };
}

function legacyTiming(stroke) {
  const signature = resolveVisualSignature(stroke);
  const dwell = stroke.points.reduce((sum, point) => sum + Math.max(0, point.duration_ms), 0);
  const intensity = stroke.points.length ? stroke.points.reduce((sum, point) => sum + point.intensity, 0) / stroke.points.length : 0.5;
  const durationMs = Math.round(Math.max(2200, Math.min(14000, (1600 + dwell * 1.25) / (0.65 + intensity * 0.7))));
  const phaseSpeeds = signature.speed_profile.map(speed => Math.max(0.12, Math.min(2, speed)));
  if (!phaseSpeeds.length) phaseSpeeds.push(1);
  const times = phaseSpeeds.map(speed => 1 / speed);
  const total = times.reduce((sum, value) => sum + value, 0);
  return { durationMs, phaseSpeeds, phaseDurations: times.map(time => time / total) };
}

test("playback starts immediately with the exact authored duration and speed phases", () => {
  assert.equal(NIB_LANDING_DURATION_MS, 0);
  for (const count of [0, 1, 4, 12, 30]) for (const intensity of [0.1, 0.5, 1]) {
    const stroke = artwork(count, intensity);
    const original = structuredClone(stroke);
    const expected = legacyTiming(stroke);
    const timing = getStrokePlayback(stroke);
    assert.equal(timing.drawingDurationMs, expected.durationMs);
    assert.equal(timing.landingDurationMs, 0);
    assert.equal(timing.durationMs, expected.durationMs);
    assert.deepEqual(timing.phaseSpeeds, expected.phaseSpeeds);
    assert.deepEqual(timing.phaseDurations, expected.phaseDurations);
    assert.deepEqual(stroke, original, "presentation timing never rewrites the artwork");
  }
});

test("the first positive elapsed time moves the nib without a contact hold", () => {
  const timing = getStrokePlayback(artwork());
  assert.equal(strokeDistanceAtTime(0, timing), 0);
  let previous = 0;
  for (const milliseconds of [1, 16, 50, 180, 325, 500, 650]) {
    const progress = milliseconds / timing.durationMs;
    const distance = strokeDistanceAtTime(progress, timing);
    assert.ok(distance > previous, `nib moves immediately at ${milliseconds}ms`);
    assert.equal(strokeLandingAtTime(progress, timing), null);
    previous = distance;
  }
  assert.equal(strokeLandingAtTime(0, timing), null);
  assert.equal(strokeLandingAtTime(1, timing), null);
  assert.equal(strokeDistanceAtTime(1, timing), 1);
  assert.equal(strokeDistanceAtTime(-10, timing), 0);
  assert.equal(strokeDistanceAtTime(10, timing), 1);
  assert.equal(strokeDistanceAtTime(NaN, timing), 0);
  assert.equal(strokeLandingAtTime(NaN, timing), null);
});

test("every original time phase keeps its original physical speed from the first frame", () => {
  const stroke = artwork();
  const legacy = legacyTiming(stroke);
  const timing = getStrokePlayback(stroke);
  let previous = 0;
  for (let index = 0; index <= 1000; index++) {
    const drawTime = index / 1000;
    const actual = strokeDistanceAtTime(drawTime, timing);
    near(actual, strokeDistanceAtTime(drawTime, legacy), "unchanged distance at drawing elapsed time");
    assert.ok(actual + 1e-12 >= previous);
    previous = actual;
  }
  let phaseTime = 0;
  timing.phaseDurations.forEach((fraction, index) => {
    phaseTime += fraction;
    near(strokeDistanceAtTime(phaseTime, timing),
      (index + 1) / timing.phaseDurations.length, "phase endpoint");
  });
});

test("replay and seeking regenerate the same immediate drawing and preserve legacy external timings", () => {
  const timing = getStrokePlayback(artwork());
  const samples = [0, 0.03, 0.08, 0.2, 0.7, 1];
  const frame = value => [strokeDistanceAtTime(value, timing), strokeLandingAtTime(value, timing)];
  const expected = samples.map(frame);
  [...samples].reverse().forEach(frame);
  assert.deepEqual(samples.map(frame), expected);
  const external = { durationMs: 1000, phaseSpeeds: [1], phaseDurations: [1] };
  near(strokeDistanceAtTime(0.4, external), 0.4);
  assert.equal(strokeLandingAtTime(0.4, external), null);
  const obsoleteIntro = { ...external, drawingDurationMs: 350, landingDurationMs: 650 };
  near(strokeDistanceAtTime(0.4, obsoleteIntro), 0.4, "obsolete intro fields cannot reintroduce a pause");
  assert.equal(strokeLandingAtTime(0.4, obsoleteIntro), null);
});

test("flat, controlled and sphere players keep the nib visible without forwarding landing state", () => {
  const root = path.resolve(__dirname, "..");
  const planar = fs.readFileSync(path.join(root, "components/CanvasView.tsx"), "utf8");
  const sphere = fs.readFileSync(path.join(root, "components/SphereCanvasView.tsx"), "utf8");
  const player = fs.readFileSync(path.join(root, "components/StrokePlayerPanel.tsx"), "utf8");
  assert.match(planar, /showNib: presentation !== "static" && presentation !== "complete"/);
  assert.match(sphere, /showNib: !\(reducedMotion\.matches && !playingRef\.current\)/);
  for (const source of [planar, sphere, player]) assert.doesNotMatch(source, /landingById|strokeLandingAtTime|landingDurationMs|"Landing"/);
  assert.match(player, /progress >= 1 \? "Complete" : "Drawing"/);
  assert.match(player, /Follow the nib as it draws/);
  assert.match(player, /fmtTime\(timing\.durationMs\)/);
});

test("timeline commits are throttled while its independent animation clock and exact seek/pause/end survive", () => {
  const planar = fs.readFileSync(path.join(__dirname, "../components/CanvasView.tsx"), "utf8");
  assert.match(planar, /delta \* controls\.speed \/ flight\.timing\.durationMs/);
  assert.match(planar, /now - lastProgressReportAt >= 1000 \/ 15/);
  assert.match(planar, /reset \|\| pausedNow \|\| timeProgress >= 1/);
  assert.match(planar, /\? reset \? controls\.progress : clock\.progress/,
    "pausing retains the actual canvas clock instead of jumping back to the last throttled React update");
  assert.match(planar, /controlledClock\.key !== controls\.replayKey/);
  assert.match(planar, /timeProgress !== lastReportedProgress/);
});
