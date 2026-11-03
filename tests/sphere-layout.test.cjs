const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const load = createTypeScriptLoader();
const { sphereStrokeControls, SPHERE_ATLAS_WIDTH, SPHERE_ATLAS_HEIGHT } = load("engine/sphereLayout.ts");
const { spherePointFromUV } = load("engine/sphereProjection.ts");
const source = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be near ${expected}`);

function angularLength(points) {
  const surface = points.map(point => spherePointFromUV(point.x, point.y));
  return surface.slice(1).reduce((length, point, index) => {
    const prior = surface[index];
    const dot = point.x * prior.x + point.y * prior.y + point.z * prior.z;
    return length + Math.acos(Math.max(-1, Math.min(1, dot)));
  }, 0);
}

test("sphere atlas is deterministic, independent of input order, and never mutates artwork", () => {
  const original = Object.freeze([
    Object.freeze({ x: 0.1, y: 0.2 }),
    Object.freeze({ x: 0.6, y: 0.5 }),
    Object.freeze({ x: 0.35, y: 0.7 }),
    Object.freeze({ x: 0.8, y: 0.3 }),
  ]);
  const first = sphereStrokeControls("artwork-a", original);
  const unrelated = sphereStrokeControls("artwork-b", original);
  assert.notDeepEqual(first, unrelated, "Different stroke identities should occupy different stable surface locations");
  assert.deepEqual(sphereStrokeControls("artwork-a", original), first);
  sphereStrokeControls("newly-arrived-artwork", [{ x: -20, y: 300 }, { x: 40, y: 200 }]);
  assert.deepEqual(sphereStrokeControls("artwork-a", original), first, "Adding or removing other artwork cannot shuffle existing strokes");
  assert.notEqual(first, original);
  assert.ok(first.every((point, index) => point !== original[index]));
  assert.equal(SPHERE_ATLAS_WIDTH / SPHERE_ATLAS_HEIGHT, 2);
});

test("mapped paths retain padded charts with finite coordinates, away from seam and poles", () => {
  for (let index = 0; index < 400; index++) {
    const extent = 10 ** ((index % 8) - 4);
    const points = [
      { x: -extent, y: 0 }, { x: extent * 0.4, y: extent * 1.2 },
      { x: extent, y: -extent * 0.7 }, { x: -extent * 0.2, y: extent * 0.4 },
    ];
    const mapped = sphereStrokeControls(`stroke-${index}`, points);
    assert.equal(mapped.length, points.length);
    for (const point of mapped) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      assert.ok(point.x >= 0.025 - 1e-12 && point.x <= 0.975 + 1e-12, "No line reaches the longitude seam");
      assert.ok(point.y >= 0.08 - 1e-12 && point.y <= 0.92 + 1e-12, "No brush reaches a polar singularity");
      const surface = spherePointFromUV(point.x, point.y);
      near(Math.hypot(surface.x, surface.y, surface.z), 1);
    }
  }
});

test("point gestures remain points and invalid input cannot poison the surface atlas", () => {
  assert.deepEqual(sphereStrokeControls("empty", []), []);
  assert.deepEqual(sphereStrokeControls("invalid", [{ x: NaN, y: 0 }, { x: 0, y: Infinity }]), []);
  const point = sphereStrokeControls("point", [{ x: 0.5, y: 0.5 }]);
  assert.equal(point.length, 1);
  assert.equal(angularLength(point), 0);
  const repeated = sphereStrokeControls("point", Array.from({ length: 4 }, () => ({ x: 0.5, y: 0.5 })));
  for (const value of repeated) assert.deepEqual(value, point[0]);
  const mixed = sphereStrokeControls("mixed", [{ x: NaN, y: 1 }, { x: 0.2, y: 0.4 }, { x: 0.7, y: 0.6 }]);
  assert.equal(mixed.length, 2);
  assert.ok(mixed.every(value => Number.isFinite(value.x) && Number.isFinite(value.y)));
});

test("one authored path stays one ordered path, preserving turns and intersection topology", () => {
  const points = [
    { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 }, { x: 0.3, y: 0.6 },
  ];
  const mapped = sphereStrokeControls("continuous-stroke", points);
  assert.equal(mapped.length, points.length, "No branches, extra paths, disconnected stamps or added control points");
  const scaleX = mapped[1].x - mapped[0].x;
  const scaleY = mapped[1].y - mapped[0].y;
  assert.ok(scaleX > 0 && scaleY > 0);
  for (let index = 0; index < points.length; index++) {
    near(mapped[index].x, mapped[0].x + points[index].x * scaleX);
    near(mapped[index].y, mapped[0].y + points[index].y * scaleY);
  }
  // The crossing halfway along the two diagonal segments remains the same
  // chart point, and maps to the same sphere surface point rather than a chord.
  near((mapped[0].x + mapped[1].x) / 2, (mapped[2].x + mapped[3].x) / 2);
  near((mapped[0].y + mapped[1].y) / 2, (mapped[2].y + mapped[3].y) / 2);
});

test("short, medium and long gestures retain visibly different angular lengths", () => {
  const pathFor = (length) => Array.from({ length: 25 }, (_, index) => ({
    x: 0.2 + length * index / 24,
    y: 0.5 + Math.sin(index / 24 * Math.PI) * length * 0.15,
  }));
  for (const id of ["length-a", "length-b", "length-c", "length-d"]) {
    const short = angularLength(sphereStrokeControls(id, pathFor(0.025)));
    const medium = angularLength(sphereStrokeControls(id, pathFor(0.25)));
    const long = angularLength(sphereStrokeControls(id, pathFor(0.8)));
    assert.ok(short > 0 && short < medium / 3, "Readability floor must not expand a short mark into a full-length stroke");
    assert.ok(medium < long / 2, "Long and medium strokes must not normalize to identical display lengths");
  }
});

test("Sphere reuses authored strokes and never generates or persists display transformations", () => {
  const component = source("components/SphereCanvasView.tsx");
  const layout = source("engine/sphereLayout.ts");
  assert.match(component, /new MeteorRenderer\(atlas\)/);
  assert.match(component, /getStrokePlayback\(path\)/);
  assert.match(component, /strokeDistanceAtTime\(/);
  assert.match(component, /brush\.draw\(now, data\.paths, data\.agents, surfaceStore, null, data\.filterAgentId/,
    "Selection cannot isolate a single stroke on the shared sphere");
  assert.doesNotMatch(component + layout, /\bfetch\s*\(|\/api\/(?:generateStroke|strokes|skyBatch)|localStorage\.|persistTransform\s*\(|onTransformCommit\s*\(/);
  assert.match(component, /flights\.delete\(id\)/, "Removed canvas works leave the sphere animation cache");
});

test("newly arriving work starts at the beginning; only old initial works are staggered", () => {
  const component = source("components/SphereCanvasView.tsx");
  assert.match(component, /const existing = firstFrame && data\.staggerExisting && Date\.now\(\) - path\.created_at > 30000;/);
  assert.match(component, /elapsed: existing \?[^;]*: 0 \}/);
  assert.match(component, /const newFlight = !flight;/);
  assert.match(component, /if \(playingRef\.current && !newFlight\) flight\.elapsed \+= motionDelta;/,
    "New artwork must render progress zero before consuming a frame delta");
  assert.match(component, /if \(data\.paths\.length\) firstFrame = false;/);
  assert.match(component, /trailRetention: clampTrailRetention\(data\.trailRetention\)/);
});
