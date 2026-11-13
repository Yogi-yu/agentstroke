const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const { rendererHarness } = require("./benchmark-meteor.cjs");
const { interpolateBrushHeadPose, placeBrushHead, buildBrushHeadSweep } =
  createTypeScriptLoader()("engine/brushHeadSweep.ts");

const close = (actual, expected, label = "value") =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
const pose = (angle = 0, extra = {}) => ({
  x: 15, y: 30, nx: Math.cos(angle), ny: Math.sin(angle), width: 8, ...extra,
});
const vertices = [1, .12, .8, .35, .65, .07, .9, .2].map((radius, i) => ({
  x: Math.cos(i * Math.PI / 4) * radius, y: Math.sin(i * Math.PI / 4) * radius,
}));
const texture = value => ({
  leftEdge: value, rightEdge: value, depositOffset: value / 10,
  depositWidth: value / 4, grooveOffset: value / 8, grooveWidth: value / 3,
  grooveBreakup: value / 5, pigmentLoad: value, dryness: 1 - value, grain: value / 2,
});
const node = (angle, extra = {}) => ({
  ...pose(angle), progress: 0, texture: texture(1), sample: { color: "hsl(150 40% 30%)" },
  energy: 1, bias: 0, cutback: 0, ...extra,
});

test("live contact interpolation follows the exact shortest-arc rotation used by the swept nib", () => {
  const start = pose(0, { x: -30, y: 10, width: 2, low: -.8, high: .2 });
  const end = pose(Math.PI / 2, { x: 90, y: 50, width: 10, low: -.4, high: .8 });
  const before = JSON.stringify([start, end]);
  for (const t of [.01, .1, .25, .5, .9, .99]) {
    const actual = interpolateBrushHeadPose(start, end, t);
    close(Math.atan2(actual.ny, actual.nx), Math.PI / 2 * t, "rotation");
    close(Math.hypot(actual.nx, actual.ny), 1, "unit normal");
    close(actual.x, -30 + 120 * t); close(actual.y, 10 + 40 * t);
    close(actual.width, 2 + 8 * t);
    close(actual.low, -.8 + .4 * t); close(actual.high, .2 + .6 * t);
  }
  assert.equal(JSON.stringify([start, end]), before, "interpolation never rewrites authored poses");
  assert.equal(interpolateBrushHeadPose(start, end, 0), start);
  assert.equal(interpolateBrushHeadPose(start, end, 1), end);
  assert.equal(interpolateBrushHeadPose(start, end, -5), start);
  assert.equal(interpolateBrushHeadPose(start, end, 8), end);
  assert.equal(interpolateBrushHeadPose(start, end, NaN), start);
});

test("reversals never collapse the nib normal and angle wrap follows the same deterministic side", () => {
  const reverse = interpolateBrushHeadPose(pose(Math.PI / 2), pose(-Math.PI / 2), .5);
  close(reverse.nx, -1); close(reverse.ny, 0);
  const wrap = interpolateBrushHeadPose(pose(170 * Math.PI / 180), pose(-170 * Math.PI / 180), .5);
  close(wrap.nx, -1); close(wrap.ny, 0);
  for (let step = 0; step <= 100; step++) {
    const actual = interpolateBrushHeadPose(pose(0), pose(Math.PI), step / 100);
    close(Math.hypot(actual.nx, actual.ny), 1);
    assert.ok(placeBrushHead(vertices, actual).every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  }
});

test("the same interpolated concave footprint is the final cap of its deposited prefix at every scale", () => {
  const start = pose(-.7, { width: 3 });
  const end = pose(2.1, { x: 145, y: -24, width: 11 });
  for (const zoom of [.3, 1, 3]) for (const t of [0, .13, .38, .77, 1]) {
    const contact = interpolateBrushHeadPose(start, end, t);
    const placed = placeBrushHead(vertices, contact, zoom);
    const swept = buildBrushHeadSweep([start, contact], vertices, zoom);
    const cap = swept[swept.length - 1];
    assert.equal(cap.length, vertices.length);
    for (const point of placed) assert.ok(cap.some(value => Math.hypot(value.x - point.x, value.y - point.y) < 1e-9));
    const projections = placed.map(point => (point.x - contact.x) * contact.nx + (point.y - contact.y) * contact.ny);
    close((Math.max(...projections) - Math.min(...projections)) * zoom, contact.width, "unchanged physical width budget");
  }
});

test("renderer live contact uses the baked effective width instead of stale edge coverage", () => {
  const harness = rendererHarness(1);
  try {
    const a = node(0, { width: 10, texture: texture(1) });
    const b = node(Math.PI / 2, { x: 75, y: 60, width: 20, progress: 1, texture: texture(.5) });
    const before = JSON.stringify([a, b]);
    for (const t of [.1, .25, .5, .75, .9]) {
      const live = harness.renderer.nodeAt([a, b], t);
      const actual = harness.renderer.nibPose(live);
      const expected = interpolateBrushHeadPose(harness.renderer.nibPose(a), harness.renderer.nibPose(b), t);
      for (const key of ["x", "y", "nx", "ny", "width"]) close(actual[key], expected[key], `live ${key} at ${t}`);
      close(actual.width, 10, "equal baked endpoint widths remain equal during motion");
      for (const key of Object.keys(a.texture)) close(live.texture[key], a.texture[key] + (b.texture[key] - a.texture[key]) * t, key);
    }
    assert.equal(JSON.stringify([a, b]), before);
  } finally { harness.dispose(); }
});

test("renderer contact and its final swept cap remain aligned through an exact direction reversal", () => {
  const harness = rendererHarness(1);
  try {
    const a = node(Math.PI / 2, { x: 10, y: 10 });
    const b = node(-Math.PI / 2, { x: 20, y: 10, progress: 1 });
    for (const t of [.25, .5, .75]) {
      const live = harness.renderer.nodeAt([a, b], t);
      const actual = harness.renderer.contactPath(live, vertices, 1.8);
      const expectedPose = interpolateBrushHeadPose(harness.renderer.nibPose(a), harness.renderer.nibPose(b), t);
      const expected = placeBrushHead(vertices, expectedPose, 1.8);
      actual.forEach((point, i) => { close(point.x, expected[i].x); close(point.y, expected[i].y); });
    }
  } finally { harness.dispose(); }
});

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

test("advancing raster tile deposits only its reached prefix, never a future wider footprint behind the reveal plane", () => {
  const harness = rendererHarness(1);
  try {
    const renderer = harness.renderer;
    const geometry = renderer.geometry(harness.paths[0], harness.store);
    const diamond = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];
    const a = node(Math.PI / 2, { x: 0, y: 0, width: 2, sample: geometry.samples[0] });
    const b = node(Math.PI / 2, { x: 4, y: 0, width: 12, progress: 1, sample: geometry.samples[1] });
    const work = {
      geometry: { ...geometry, length: 4, nib: diamond }, nodes: [a, b],
      tiles: [{ start: 0, end: 1, key: "must-not-bake", x: -10, y: -10, width: 30, height: 20 }],
      zoom: 1, retainTrace: false, key: "prefix-test",
    };
    const materialCalls = [];
    const original = renderer.paintMaterials;
    renderer.paintMaterials = function (nodes, ...args) {
      materialCalls.push(nodes);
      return original.call(this, nodes, ...args);
    };
    renderer.activeNib = diamond;
    renderer.drawRasterWork(work, .25, 1, .2);
    assert.equal(renderer.getRenderStats().tileBakes, 0, "the unfinished tile is not a full future bitmap");
    assert.equal(materialCalls.length, 1);
    const reached = materialCalls[0];
    assert.ok(reached.every(value => value.progress <= .25), "no future sample reaches material deposition");
    close(reached.at(-1).progress, .25);
    const live = renderer.nodeAt([a, b], .25);
    assert.deepEqual(renderer.nibPose(reached.at(-1)), renderer.nibPose(live), "deposit ends at the exact outlined contact");
    const deposited = buildBrushHeadSweep(reached.map(value => renderer.nibPose(value)), diamond);
    const future = buildBrushHeadSweep([renderer.nibPose(a), renderer.nibPose(b)], diamond);
    const probe = { x: 0, y: 1.8 };
    assert.ok(probe.x < live.x && future.some(polygon => pointInPolygon(probe, polygon)), "probe reproduces the old half-plane leak");
    assert.ok(!deposited.some(polygon => pointInPolygon(probe, polygon)), "unreached wider paint cannot appear behind the moving head");
  } finally { harness.dispose(); }
});

test("completed raster tiles never bake not-yet-reached neighbor footprints across their ownership boundary", () => {
  const harness = rendererHarness(1);
  try {
    const renderer = harness.renderer;
    const geometry = renderer.geometry(harness.paths[0], harness.store);
    const diamond = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];
    const a = node(Math.PI / 2, { x: -4, y: 0, width: 2, sample: geometry.samples[0] });
    const b = node(Math.PI / 2, { x: 0, y: 0, width: 2, progress: .4, sample: geometry.samples[1] });
    const c = node(Math.PI / 2, { x: 4, y: 0, width: 12, progress: 1, sample: geometry.samples[2] });
    const work = {
      geometry: { ...geometry, length: 8, nib: diamond }, nodes: [a, b, c], zoom: 1,
      retainTrace: true, key: "completed-prefix-test",
      tiles: [
        { start: 0, end: 1, key: "completed-prefix-0", x: -10, y: -10, width: 30, height: 20 },
        { start: 1, end: 2, key: "completed-prefix-1", x: -10, y: -10, width: 30, height: 20 },
      ],
    };
    const materialCalls = [];
    const original = renderer.paintMaterials;
    renderer.paintMaterials = function (nodes, ...args) {
      materialCalls.push(nodes);
      return original.call(this, nodes, ...args);
    };
    renderer.activeNib = diamond;
    renderer.drawRasterWork(work, .45, 1, .2);
    assert.equal(renderer.getRenderStats().tileBakes, 1, "only the completed tile is baked");
    assert.equal(materialCalls.length, 2, "one cached completed tile and one exact live prefix");
    assert.ok(materialCalls[0].every(value => value.progress <= .4), "completed tile owns no future neighboring sample");
    assert.ok(materialCalls[1].every(value => value.progress <= .45));
    const oldFuture = buildBrushHeadSweep([a, b, c].map(value => renderer.nibPose(value)), diamond);
    const actual = buildBrushHeadSweep(materialCalls[0].map(value => renderer.nibPose(value)), diamond);
    const probe = { x: -.5, y: 1.2 };
    assert.ok(probe.x < b.x && oldFuture.some(polygon => pointInPolygon(probe, polygon)), "old future neighbor survives the completed tile's end plane");
    assert.ok(!actual.some(polygon => pointInPolygon(probe, polygon)), "cached completed pixels contain no future pressure widening");
  } finally { harness.dispose(); }
});

function recordPaths(context) {
  const results = { fills: [], strokes: [] };
  let current = [], active = null;
  for (const name of ["beginPath", "moveTo", "lineTo", "closePath", "fill", "stroke"]) {
    const original = context[name];
    context[name] = (...args) => {
      if (name === "beginPath") { current = []; active = null; }
      if (name === "moveTo") { active = [{ x: args[0], y: args[1] }]; current.push(active); }
      if (name === "lineTo") active?.push({ x: args[0], y: args[1] });
      if (name === "fill" || name === "stroke") results[name === "fill" ? "fills" : "strokes"].push(structuredClone(current));
      return original.apply(context, args);
    };
  }
  return results;
}

test("the actual footprint is outlined at the first frame and stays visible through the completed frame without landing scale", () => {
  const harness = rendererHarness(1);
  try {
    const renderer = harness.renderer;
    const paths = recordPaths(harness.surface.canvases[0].context);
    const contacts = [];
    const original = renderer.drawContact;
    renderer.drawContact = function (node, nib, zoom, ...rest) {
      contacts.push({ node, nib, zoom });
      return original.call(this, node, nib, zoom, ...rest);
    };
    for (const progress of [0, .01, .5, 1]) {
      const before = contacts.length;
      harness.drawDistances(new Map([[harness.paths[0].id, progress]]), { showNib: true, inspectNib: false });
      assert.equal(contacts.length, before + 1, `contour remains present at ${progress}`);
      const { node: contact, nib, zoom } = contacts.at(-1);
      const expected = placeBrushHead(nib, renderer.nibPose(contact), zoom);
      const actual = paths.strokes.at(-1)[0];
      assert.equal(actual.length, expected.length);
      actual.forEach((point, i) => { close(point.x, expected[i].x); close(point.y, expected[i].y); });
      close(contact.progress, progress);
    }
  } finally { harness.dispose(); }
});

test("point gestures paint and outline exactly the same 1.4-pixel physical nib, including textured edge coverage", () => {
  const harness = rendererHarness(1);
  try {
    const path = harness.paths[0];
    const controls = [{ x: 30, y: 45 }];
    const source = { controlPointsOf: () => controls, transformOf: () => ({ scale: 1, rotation: 0, translateX: 0, translateY: 0 }) };
    const recorded = recordPaths(harness.surface.canvases[0].context);
    harness.renderer.draw(0, harness.paths, harness.agents, source, null, null, harness.view,
      new Map([[path.id, .5]]), { showNib: true, inspectNib: false });
    const body = recorded.fills[0][0], outline = recorded.strokes.at(-1)[0];
    assert.equal(body.length, outline.length);
    for (const point of body) assert.ok(outline.some(value => Math.hypot(point.x - value.x, point.y - value.y) < 1e-9), "point pigment and contour share every vertex");
    close(Math.max(...outline.map(point => point.y)) - Math.min(...outline.map(point => point.y)), 1.4);
  } finally { harness.dispose(); }
});
