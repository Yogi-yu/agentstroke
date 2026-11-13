const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const {
  normalizeBrushHead, placeBrushHead, buildBrushHeadSweep, appendBrushHeadSweep, clipBrushHeadBand,
  simplifyBrushHeadPoses,
} = createTypeScriptLoader()("engine/brushHeadSweep.ts");

const close = (actual, expected, label = "value") => assert.ok(Math.abs(actual - expected) < 1e-8, `${label}: ${actual} != ${expected}`);
const radial = (radii = [1, 0.16, 0.8, 0.32, 0.7, 0, 0.5, 0.21]) => radii.map((radius, index) => ({
  x: Math.cos((index * 45 - 90) * Math.PI / 180) * radius,
  y: Math.sin((index * 45 - 90) * Math.PI / 180) * radius,
}));
const profile = vertices => ({ version: 1, previewOnly: false, hasData: true, axes: [], vertices });
const pose = (overrides = {}) => ({ x: 0, y: 0, nx: 1, ny: 0, width: 2, ...overrides });
const area = polygon => polygon.reduce((sum, point, index) => {
  const next = polygon[(index + 1) % polygon.length];
  return sum + point.x * next.y - point.y * next.x;
}, 0) / 2;
function onSegment(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (!length2) return Math.hypot(point.x - a.x, point.y - a.y) < 1e-8;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2));
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy) < 1e-8;
}
function inside(point, polygon) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if (onSegment(point, a, b)) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}
const covered = (point, polygons) => polygons.some(polygon => inside(point, polygon));
function deepFreeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

test("normalization preserves every relative radius, concavity and zero spoke with one size factor", () => {
  const source = deepFreeze(profile(radial([0.4, 0.07, 0.2, 0.1, 0.3, 0, 0.15, 0.04])));
  const before = structuredClone(source);
  const normalized = normalizeBrushHead(source);
  assert.equal(normalized.length, 8);
  close(Math.max(...normalized.map(point => Math.hypot(point.x, point.y))), 1);
  normalized.forEach((point, index) => {
    close(point.x, source.vertices[index].x / 0.4);
    close(point.y, source.vertices[index].y / 0.4);
  });
  close(Math.hypot(normalized[5].x, normalized[5].y), 0);
  assert.deepEqual(source, before);
});

test("nib placement uniformly preserves shape while matching the original full cross-stroke width", () => {
  const vertices = deepFreeze(normalizeBrushHead(profile(radial())));
  const sourcePose = deepFreeze(pose({ x: 240, y: 130, nx: 0, ny: 5, width: 12 }));
  const placed = placeBrushHead(vertices, sourcePose, 2);
  const low = Math.min(...vertices.map(point => point.x)), high = Math.max(...vertices.map(point => point.x));
  const factor = 12 / (2 * (high - low)), middle = (low + high) / 2;
  placed.forEach((point, index) => {
    close(point.x, sourcePose.x - vertices[index].y * factor);
    close(point.y, sourcePose.y + (vertices[index].x - middle) * factor);
    const next = (index + 1) % vertices.length;
    close(Math.hypot(point.x - placed[next].x, point.y - placed[next].y),
      Math.hypot(vertices[index].x - vertices[next].x, vertices[index].y - vertices[next].y) * factor, "all edge lengths use one scale");
  });
  close(Math.min(...placed.map(point => point.y)), 127);
  close(Math.max(...placed.map(point => point.y)), 133);
  close(placed[5].x, 240);
  close(placed[5].y, 130 - middle * factor, "the fan origin receives the identical placement transform");
  assert.deepEqual(sourcePose, pose({ x: 240, y: 130, nx: 0, ny: 5, width: 12 }), "the authored trajectory itself is not moved");
  const source = placeBrushHead(vertices, pose({ width: 12 }));
  const half = placeBrushHead(vertices, pose({ width: 6 }));
  source.forEach((point, index) => { close(half[index].x, point.x / 2); close(half[index].y, point.y / 2); });
});

test("a stationary nib retains real concave notches instead of becoming a convex cap", () => {
  const vertices = radial([1, 0.1, 1, 0.1, 1, 0.1, 1, 0.1]);
  const polygons = buildBrushHeadSweep([pose()], vertices);
  assert.equal(polygons.length, 1);
  close(area(polygons[0]), area(vertices));
  assert.ok(covered({ x: 0.8, y: 0 }, polygons));
  assert.ok(!covered({ x: 0.35, y: 0.35 }, polygons), "diagonal notch must remain unpainted");
  assert.ok(polygons.every(polygon => area(polygon) > 0), "all pieces share nonzero-union winding");
});

test("translation sweeps the full nib continuously without subpixel stamp spacing or disconnected dots", () => {
  const vertices = radial();
  const start = pose({ x: 0, y: 0, width: 6 });
  const end = pose({ x: 240, y: 170, width: 9 });
  const polygons = buildBrushHeadSweep([start, end], vertices);
  assert.ok(polygons.length <= 10, "one cap at each end plus at most eight exact fan bridges");
  for (let step = 0; step <= 100; step++) {
    const t = step / 100;
    const at = pose({ x: 240 * t, y: 170 * t, width: 6 + t * 3 });
    assert.ok(covered({ x: at.x, y: at.y }, polygons), "the whole authored centerline remains connected");
    for (const point of placeBrushHead(vertices, at)) assert.ok(covered(point, polygons), `nib contact at ${t} is included`);
  }
  assert.ok(polygons.every(polygon => area(polygon) > 0));
});

test("turns and exact reversals use deterministic bounded subdivisions and a connected footprint", () => {
  const vertices = normalizeBrushHead(profile(radial()));
  const poses = deepFreeze([
    pose({ x: 0, y: 0, nx: 0, ny: 1, width: 8 }),
    pose({ x: 60, y: 20, nx: 0, ny: -1, width: 12 }),
    pose({ x: 10, y: 60, nx: -1, ny: 0, width: 3 }),
  ]);
  const before = structuredClone(poses);
  const first = buildBrushHeadSweep(poses, vertices);
  assert.deepEqual(first, buildBrushHeadSweep(poses, vertices));
  assert.ok(first.length <= 3 + 2 * Math.ceil(Math.PI / 0.15) * vertices.length);
  for (let index = 1; index < poses.length; index++) for (let step = 0; step <= 50; step++) {
    const t = step / 50, a = poses[index - 1], b = poses[index];
    assert.ok(covered({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, first));
  }
  assert.ok(first.every(polygon => area(polygon) > 0 && polygon.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))));
  assert.deepEqual(poses, before);
});

test("material bands clip literal nib regions and preserve separated concave lobes", () => {
  const vertices = radial([1, 1, 0, 1, 1, 1, 1, 1]);
  const clipped = clipBrushHeadBand(vertices, 0.3, 0.6);
  assert.ok(clipped.length > 0 && clipped.every(point => point.x >= 0.3 - 1e-8 && point.x <= 0.6 + 1e-8));
  const polygons = buildBrushHeadSweep([pose({ low: 0.3, high: 0.6 })], vertices);
  assert.ok(polygons.every(polygon => polygon.every(point => point.x >= 0.3 - 1e-8 && point.x <= 0.6 + 1e-8)));
  assert.ok(covered({ x: 0.4, y: -0.6 }, polygons));
  assert.ok(covered({ x: 0.4, y: 0.6 }, polygons));
  assert.ok(!covered({ x: 0.4, y: 0 }, polygons), "band must not fill between the upper and lower lobes");
  assert.deepEqual(clipBrushHeadBand(vertices, 0.8, 0.2), []);
});

test("changing material bands meet vertex contacts without skipping their emerging sweep", () => {
  const vertices = radial(Array(8).fill(1));
  const polygons = buildBrushHeadSweep([
    pose({ x: 0, y: 0, low: 1.2, high: 1 }),
    pose({ x: 0, y: 100, low: -0.8, high: 1 }),
  ], vertices);
  assert.ok(polygons.length > 0);
  assert.ok(covered({ x: 0.8, y: 50 }, polygons));
  assert.ok(!covered({ x: -0.8, y: 1 }, polygons), "nothing appears before that part of the band opens");
  assert.ok(polygons.every(polygon => area(polygon) > 0));
});

test("empty, point-sized, malformed and zero-normal data stay finite and do not invent cross-gap bridges", () => {
  assert.deepEqual(buildBrushHeadSweep([], radial()), []);
  assert.deepEqual(buildBrushHeadSweep([pose()], []), []);
  assert.deepEqual(buildBrushHeadSweep([pose({ width: 0 })], radial()), []);
  const fallback = normalizeBrushHead(profile([{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 0, y: Infinity }]));
  assert.ok(fallback.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.ok(Math.max(...fallback.map(point => Math.hypot(point.x, point.y))) <= 0.05);
  const placed = placeBrushHead(fallback, pose({ x: NaN, y: Infinity, nx: 0, ny: 0, width: NaN }), -1);
  assert.ok(placed.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  const separated = buildBrushHeadSweep([pose(), pose({ x: NaN }), pose({ x: 100 })], radial());
  assert.ok(!covered({ x: 50, y: 0 }, separated));
});

test("append only emits compound geometry, leaving pigment, opacity and fill ownership to the renderer", () => {
  const polygons = buildBrushHeadSweep([pose(), pose({ x: 10, y: 20 })], radial());
  const calls = [];
  const context = {
    moveTo: (x, y) => calls.push(["M", x, y]),
    lineTo: (x, y) => calls.push(["L", x, y]),
    closePath: () => calls.push(["Z"]),
  };
  appendBrushHeadSweep(context, polygons);
  assert.equal(calls.filter(call => call[0] === "M").length, polygons.length);
  assert.equal(calls.filter(call => call[0] === "Z").length, polygons.length);
  assert.ok(calls.every(call => ["M", "L", "Z"].includes(call[0])));
});

test("per-pose ranges reuse exactly the once-built sweep in palette chunks", () => {
  const vertices = radial();
  const poses = [pose(), pose({ x: 30, y: 20 }), pose({ x: 70, y: 45, nx: 0, ny: 1 }), pose({ x: 90, y: 80 })];
  const ranges = [{ start: 900, end: 999 }];
  const polygons = buildBrushHeadSweep(poses, vertices, 1, ranges);
  assert.equal(ranges.length, poses.length, "one entry for each original pose, not each rotation subdivision");
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges[0].end, 1, "the initial range owns only its concave nib cap");
  assert.equal(ranges.at(-1).end, polygons.length);
  for (let index = 1; index < ranges.length; index++) assert.equal(ranges[index].start, ranges[index - 1].end);
  const concatenated = ranges.flatMap(range => polygons.slice(range.start, range.end));
  assert.deepEqual(concatenated, polygons, "chunked material filling does not rebuild or omit any coverage");
  assert.deepEqual(buildBrushHeadSweep(poses, vertices), polygons, "range collection does not alter geometry");
  const invalidRanges = [];
  buildBrushHeadSweep([pose(), pose({ x: NaN }), pose({ x: 100 })], vertices, 1, invalidRanges);
  assert.equal(invalidRanges[1].start, invalidRanges[1].end);
  assert.equal(invalidRanges.length, 3);
  buildBrushHeadSweep(poses, [], 1, invalidRanges);
  assert.deepEqual(invalidRanges, poses.map(() => ({ start: 0, end: 0 })));
});

test("pose simplification removes redundant straight contacts but retains endpoint indices and original objects", () => {
  const vertices = normalizeBrushHead(profile(radial()));
  const poses = deepFreeze(Array.from({ length: 256 }, (_, index) => pose({
    x: index * 3, y: index * 2, width: 3 + index / 100, low: -0.8 + index / 2000, high: 0.7 - index / 3000,
  })));
  const before = structuredClone(poses);
  const result = simplifyBrushHeadPoses(poses, vertices);
  assert.deepEqual(result.indices, [0, 255]);
  assert.equal(result.poses[0], poses[0]);
  assert.equal(result.poses[1], poses[255]);
  assert.deepEqual(poses, before, "saved pose/attribute input is not rewritten");
});

test("simplified contacts stay within 0.08 CSS pixels and band cuts within 0.04 at every original sample", () => {
  const vertices = normalizeBrushHead(profile(radial()));
  const poses = deepFreeze(Array.from({ length: 256 }, (_, index) => {
    const t = index / 255;
    const dx = 800, dy = 50 * 5 * Math.cos(t * 5), length = Math.hypot(dx, dy);
    return pose({
      x: t * 800, y: 50 * Math.sin(t * 5), nx: -dy / length, ny: dx / length,
      width: 6 + 4 * Math.sin(t * 14) ** 2, low: -0.8 + 0.12 * Math.sin(t * 19), high: 0.9 - 0.08 * Math.cos(t * 13),
    });
  }));
  for (const zoom of [0.5, 1, 2.3]) {
    const result = simplifyBrushHeadPoses(poses, vertices, zoom);
    assert.ok(result.poses.length < poses.length, "subpixel-redundant geometry should actually be reduced");
    assert.equal(result.indices[0], 0);
    assert.equal(result.indices.at(-1), poses.length - 1);
    const distances = [0];
    for (let index = 1; index < poses.length; index++) distances.push(distances.at(-1) + Math.hypot(poses[index].x - poses[index - 1].x, poses[index].y - poses[index - 1].y));
    for (let span = 1; span < result.indices.length; span++) {
      const first = result.indices[span - 1], last = result.indices[span];
      assert.ok(last > first);
      const a = poses[first], b = poses[last];
      const angle = Math.atan2(a.ny, a.nx), ending = Math.atan2(b.ny, b.nx);
      const turn = Math.atan2(Math.sin(ending - angle), Math.cos(ending - angle));
      for (let index = first + 1; index < last; index++) {
        const t = (distances[index] - distances[first]) / (distances[last] - distances[first]);
        const interpolated = pose({
          x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
          nx: Math.cos(angle + turn * t), ny: Math.sin(angle + turn * t),
          width: a.width + (b.width - a.width) * t,
          low: a.low + (b.low - a.low) * t, high: a.high + (b.high - a.high) * t,
        });
        const expected = placeBrushHead(vertices, interpolated, zoom), actual = placeBrushHead(vertices, poses[index], zoom);
        for (let vertex = 0; vertex < vertices.length; vertex++) {
          assert.ok(Math.hypot(actual[vertex].x - expected[vertex].x, actual[vertex].y - expected[vertex].y) * zoom <= 0.08000001);
        }
        for (const side of ["low", "high"]) {
          assert.ok(Math.abs(poses[index][side] - interpolated[side]) * Math.max(poses[index].width, interpolated.width) / 2 <= 0.04000001);
        }
      }
    }
  }
});

test("simplification cannot erase pressure changes, sharp turns, material cuts or stationary rotation", () => {
  const vertices = normalizeBrushHead(profile(radial()));
  const changingWidth = [pose(), pose({ x: 10, width: 9 }), pose({ x: 20 })];
  assert.deepEqual(simplifyBrushHeadPoses(changingWidth, vertices).indices, [0, 1, 2]);
  const changingBand = [pose({ low: -0.9 }), pose({ x: 10, low: -0.1 }), pose({ x: 20, low: -0.9 })];
  assert.deepEqual(simplifyBrushHeadPoses(changingBand, vertices).indices, [0, 1, 2]);
  const turn = [pose(), pose({ x: 10, y: 0 }), pose({ x: 10, y: 10 })];
  assert.deepEqual(simplifyBrushHeadPoses(turn, vertices).indices, [0, 1, 2]);
  const stationary = [pose(), pose({ nx: 0, ny: 1 }), pose({ nx: -1, ny: 0 })];
  assert.deepEqual(simplifyBrushHeadPoses(stationary, vertices).indices, [0, 1, 2]);
  const invalid = [pose(), pose({ x: NaN }), pose({ x: 20 })];
  assert.deepEqual(simplifyBrushHeadPoses(invalid, vertices).indices, [0, 1, 2]);
  assert.deepEqual(simplifyBrushHeadPoses([], vertices), { poses: [], indices: [] });
});
