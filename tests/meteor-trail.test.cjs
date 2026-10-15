const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const {
  ANIMATED_TRAIL_RETENTION,
  MIN_ANIMATED_TRAIL_RETENTION,
  MAX_ANIMATED_TRAIL_RETENTION,
  clampTrailRetention,
  animatedTrailStart,
  animatedTrailOpacity,
} = createTypeScriptLoader()("engine/meteorTrail.ts");

function near(actual, expected, message = "values should match", tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
}

test("runtime retention clamps finite values to 20–80 percent and invalid values use the default", () => {
  assert.equal(ANIMATED_TRAIL_RETENTION, 0.2);
  assert.equal(MIN_ANIMATED_TRAIL_RETENTION, 0.2);
  assert.equal(MAX_ANIMATED_TRAIL_RETENTION, 0.8);
  for (const [input, expected] of [
    [-100, 0.2], [0, 0.2], [0.199, 0.2], [0.2, 0.2],
    [0.35, 0.35], [0.5, 0.5], [0.8, 0.8], [0.801, 0.8], [100, 0.8],
    [NaN, 0.2], [-Infinity, 0.2], [Infinity, 0.2],
  ]) {
    assert.equal(clampTrailRetention(input), expected);
    for (const progress of [0.1, 0.4, 0.8, 1]) {
      near(animatedTrailStart(progress, input), animatedTrailStart(progress, expected));
      for (const position of [0, 0.1, 0.3, 0.6, 1]) {
        near(animatedTrailOpacity(progress, position, input), animatedTrailOpacity(progress, position, expected));
      }
    }
  }
  for (const progress of [0, 0.2, 0.5, 0.8, 0.9, 1]) {
    near(animatedTrailStart(progress), animatedTrailStart(progress, 0.2));
    near(animatedTrailOpacity(progress, 0.1), animatedTrailOpacity(progress, 0.1, 0.2));
  }
});

test("20, 50 and 80 percent retention each preserve the full trail until their own threshold", () => {
  for (const retention of [0.2, 0.5, 0.8]) {
    for (const progress of [0, retention * 0.25, retention * 0.75, retention - 1e-6, retention]) {
      near(animatedTrailStart(progress, retention), 0);
      for (let sample = 0; sample <= 20; sample++) {
        near(animatedTrailOpacity(progress, progress * sample / 20, retention), 1,
          `${retention} retention must not erode before its threshold`);
      }
    }
    const justAfter = animatedTrailOpacity(retention + 1e-6, 0, retention);
    assert.ok(justAfter < 1 && justAfter > 0.999999, "Changing the retention threshold must not create a fade discontinuity");
    near(animatedTrailOpacity(retention + 0.01, 0, retention), 25 / 27);
    near(animatedTrailOpacity(retention + 0.03, 0, retention), 0.5);
    near(animatedTrailOpacity(retention + 0.06, 0, retention), 0);
    near(animatedTrailStart(retention + 0.06, retention), 0);
    near(animatedTrailStart(retention + 0.1, retention), 0.04);
    near(animatedTrailStart(1, retention), 1 - retention - 0.06);
    near(animatedTrailOpacity(1, 1 - retention - 0.03, retention), 0.5);
    near(animatedTrailOpacity(1, 1 - retention, retention), 1);
  }
});

test("live retention changes immediately restore erased pigment at unchanged progress without history", () => {
  const progress = 0.7;
  const profile = (retention) => [animatedTrailStart(progress, retention),
    ...[0, 0.1, 0.3, 0.4, 0.6, 0.7].map((position) => animatedTrailOpacity(progress, position, retention))];
  const shortTrail = profile(0.2);
  const longTrail = profile(0.8);
  near(shortTrail[0], 0.44);
  near(shortTrail[1], 0, "The short setting has erased the origin");
  near(longTrail[0], 0);
  assert.ok(longTrail.slice(1).every((alpha) => alpha === 1), "Increasing retention restores the complete drawn trail immediately");
  for (const retention of [0.2, 0.8, 0.5, 0.2, 0.5, 0.8, 0.2, 0.8]) {
    const snapshot = profile(retention);
    for (const otherProgress of [1, 0.03, 0.9, 0.2]) {
      animatedTrailStart(otherProgress, 0.2);
      animatedTrailOpacity(otherProgress, 0, 0.8);
    }
    assert.deepEqual(profile(retention), snapshot, "Neither a seek nor a previous setting may leave stale erasure");
  }
  assert.deepEqual(profile(0.2), shortTrail);
  assert.deepEqual(profile(0.8), longTrail);
});

test("the default full drawn trail remains opaque through exactly 20 percent of the stroke", () => {
  assert.equal(ANIMATED_TRAIL_RETENTION, 0.2);
  for (const progress of [0, 0.001, 0.05, 0.1, 0.19, 0.199999, 0.2]) {
    assert.equal(animatedTrailStart(progress), 0);
    for (let sample = 0; sample <= 100; sample++) {
      const position = progress * sample / 100;
      assert.equal(animatedTrailOpacity(progress, position), 1, `No erosion at progress ${progress}, position ${position}`);
    }
  }
});

test("the oldest pigment starts fading continuously only after the default 20 percent threshold", () => {
  near(animatedTrailOpacity(0.2, 0), 1);
  const justAfter = animatedTrailOpacity(0.2 + 1e-6, 0);
  assert.ok(justAfter < 1 && justAfter > 0.999999, "Crossing the threshold must not pop the rear away");
  near(animatedTrailOpacity(0.21, 0), 25 / 27);
  near(animatedTrailOpacity(0.23, 0), 0.5);
  near(animatedTrailOpacity(0.245, 0), 0.15625);
  near(animatedTrailOpacity(0.26, 0), 0);
  near(animatedTrailOpacity(0.261, 0), 0);
});

test("geometry retains the whole six-percent feather until pigment is fully erased", () => {
  for (const progress of [0.2, 0.21, 0.23, 0.259, 0.26]) near(animatedTrailStart(progress), 0);
  near(animatedTrailStart(0.3), 0.04);
  near(animatedTrailStart(0.35), 0.09);
  near(animatedTrailStart(1), 0.74);
  for (let step = 261; step <= 1000; step++) {
    const progress = step / 1000;
    const start = animatedTrailStart(progress);
    const front = progress - ANIMATED_TRAIL_RETENTION;
    near(front - start, 0.06);
    near(animatedTrailOpacity(progress, start), 0, "The geometry cutoff must have zero opacity");
    near(animatedTrailOpacity(progress, front), 1, "The erasing front joins the retained opaque trail");
    assert.ok(animatedTrailOpacity(progress, start + 0.001) > 0, "Visible feather must not be clipped");
  }
});

test("the final trail has a smooth rear feather and an opaque retained front", () => {
  near(animatedTrailOpacity(1, 0), 0);
  near(animatedTrailOpacity(1, 0.74), 0);
  near(animatedTrailOpacity(1, 0.755), 0.15625);
  near(animatedTrailOpacity(1, 0.77), 0.5);
  near(animatedTrailOpacity(1, 0.785), 0.84375);
  for (const position of [0.8, 0.85, 0.9, 1]) near(animatedTrailOpacity(1, position), 1);

  const epsilon = 1e-6;
  assert.ok(animatedTrailOpacity(1, 0.74 + epsilon) < 1e-8, "Fade-in begins with a smooth, flat edge");
  assert.ok(1 - animatedTrailOpacity(1, 0.8 - epsilon) < 1e-8, "Fade-in ends with a smooth, flat edge");
});

test("geometry start moves monotonically and a fixed point never regains opacity as progress advances", () => {
  let previousStart = 0;
  const positions = [0, 0.01, 0.05, 0.1, 0.14, 0.17, 0.2, 0.5, 0.8, 1];
  const previousAlpha = positions.map(() => 1);
  for (let step = 0; step <= 1000; step++) {
    const progress = step / 1000;
    const start = animatedTrailStart(progress);
    assert.ok(Number.isFinite(start) && start >= previousStart && start <= progress);
    previousStart = start;
    positions.forEach((position, index) => {
      const alpha = animatedTrailOpacity(progress, position);
      assert.ok(Number.isFinite(alpha) && alpha >= 0 && alpha <= previousAlpha[index]);
      previousAlpha[index] = alpha;
    });
  }
});

test("opacity is spatially monotonic from the faded rear toward the drawing head", () => {
  for (const progress of [0, 0.5, 0.8, 0.801, 0.83, 0.9, 0.99, 1]) {
    let previous = 0;
    for (let step = 0; step <= 1000; step++) {
      const alpha = animatedTrailOpacity(progress, step / 1000);
      assert.ok(alpha >= previous && alpha <= 1);
      previous = alpha;
    }
    assert.equal(animatedTrailOpacity(progress, progress), 1, "The head remains fully opaque");
  }
});

test("out-of-range and non-finite inputs remain bounded with deterministic clamping", () => {
  for (const progress of [-Infinity, -100, -1, 0, 0.8, 1, 2, 100, Infinity, NaN]) {
    const normalized = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
    near(animatedTrailStart(progress), animatedTrailStart(normalized));
    for (const position of [-Infinity, -100, -1, 0, 0.1, 0.5, 1, 2, Infinity, NaN]) {
      const normalizedPosition = Number.isFinite(position) ? Math.max(0, Math.min(1, position)) : 0;
      const alpha = animatedTrailOpacity(progress, position);
      assert.ok(Number.isFinite(alpha) && alpha >= 0 && alpha <= 1);
      near(alpha, animatedTrailOpacity(normalized, normalizedPosition));
    }
  }
});

test("retention depends on normalized travelled distance, not pixels, duration, frame count or prior seeks", () => {
  for (const retention of [0.2, 0.5, 0.8]) {
    const checkpoints = [0, retention / 2, retention, retention + 0.01, retention + 0.03, 0.9, 1];
    const profile = (progress) => [animatedTrailStart(progress, retention),
      ...[0, 0.05, 0.17, 0.2, 0.5, 1].map((position) => animatedTrailOpacity(progress, position, retention))];
    const reference = checkpoints.map(profile);
    for (const length of [0.01, 1, 10, 500, 10000]) {
      for (const frameCount of [1, 30, 120, 1000]) {
        for (let frame = 0; frame <= frameCount; frame++) profile(frame / frameCount);
        for (const speed of [0.1, 1, 1000]) {
          checkpoints.forEach((fraction, index) => {
            // Different speeds reach this distance at different times. The helper
            // deliberately receives distance/length, never elapsed milliseconds.
            const elapsed = length * fraction / speed;
            const travelledDistance = speed * elapsed;
            profile(travelledDistance / length).forEach((value, field) => near(value, reference[index][field]));
          });
        }
      }
    }
    for (const index of [6, 2, 4, 0, 5, 1, 3, 6]) {
      assert.deepEqual(profile(checkpoints[index]), reference[index], "Seeking and replay must not accumulate trail state");
    }
  }
});
