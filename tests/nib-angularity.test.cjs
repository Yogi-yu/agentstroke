const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const { rendererHarness } = require("./benchmark-meteor.cjs");
const load = createTypeScriptLoader();
const { sampleMeteorCenterline } = load("engine/meteorCenterline.ts");
const { countPathCrossings } = load("engine/motionPattern.ts");
const close = (actual, expected, label = "value", epsilon = 1e-7) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: ${actual} != ${expected}`);
const cumulative = points => {
  const result = [0];
  for (let i = 1; i < points.length; i++) result.push(result[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  return result;
};
const onSegment = (point, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-10) return Math.hypot(point.x - a.x, point.y - a.y) < 1e-8;
  const along = ((point.x - a.x) * dx + (point.y - a.y) * dy) / length;
  const across = Math.abs((point.x - a.x) * dy - (point.y - a.y) * dx) / length;
  return across < 1e-7 && along >= -1e-7 && along <= length + 1e-7;
};

function assertSourceOrder(source, sampled) {
  let cursor = 0;
  for (const vertex of source) {
    while (cursor < sampled.length && (sampled[cursor].x !== vertex.x || sampled[cursor].y !== vertex.y)) cursor++;
    assert.ok(cursor < sampled.length, `authored vertex ${vertex.x},${vertex.y} is exact and in order`);
    cursor++;
  }
}

test("every L-shaped corner is retained exactly, including the formerly rounded high-sharpness route", () => {
  const controls = [{ x: 0, y: 0 }, { x: .9, y: 0 }, { x: .9, y: .1 }];
  const source = controls.map(point => ({ x: point.x * 1000, y: point.y * 1000 }));
  const reference = sampleMeteorCenterline(controls, 1000, 1000, 0);
  for (const sharpness of [0, .25, .5, .75, 1]) {
    const result = sampleMeteorCenterline(controls, 1000, 1000, sharpness);
    assert.deepEqual(result, reference, "renderer sharpness cannot rewrite the authored centerline");
    close(result.length, 1000);
    close(cumulative(result.points).at(-1), 1000);
    assertSourceOrder(source, result.points);
    assert.ok(result.points.every(point => onSegment(point, source[0], source[1]) || onSegment(point, source[1], source[2])));
  }
});

test("added detail samples remain on original legs and never form a shortcut across sharp or reversing corners", () => {
  const fixtures = [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: .2, y: 0 }, { x: .2, y: .3 }],
    [{ x: .1, y: .1 }, { x: .9, y: .2 }, { x: .3, y: .8 }, { x: .8, y: .3 }],
    [{ x: 0, y: 0 }, { x: .0002, y: .7 }, { x: .0001, y: .1 }, { x: .9, y: .12 }],
  ];
  for (const controls of fixtures) {
    const source = controls.map(point => ({ x: point.x * 600, y: point.y * 400 }));
    const result = sampleMeteorCenterline(controls, 600, 400);
    assertSourceOrder(source, result.points);
    close(result.length, cumulative(source).at(-1));
    close(cumulative(result.points).at(-1), result.length);
    assert.ok(result.points.every(point => source.slice(1).some((end, i) => onSegment(point, source[i], end))));
  }
});

test("arc-uniform material samples survive alongside nonuniform authored corners without changing endpoints", () => {
  const controls = [
    { x: .1, y: .1 }, { x: .115, y: .1 }, { x: .115, y: .15 },
    { x: .9, y: .15 }, { x: .9, y: .9 },
  ];
  const result = sampleMeteorCenterline(controls, 1000, 600);
  const distances = cumulative(result.points);
  const segments = Math.max(32, Math.min(256, Math.ceil(result.length / 2.5)));
  for (let i = 0; i <= segments; i++) {
    const distance = i / segments * result.length;
    assert.ok(distances.some(value => Math.abs(value - distance) < 1e-7), `arc sample ${i}/${segments} remains present`);
  }
  assert.deepEqual(result.points[0], { x: 100, y: 60 });
  assert.deepEqual(result.points.at(-1), { x: 900, y: 540 });
  assert.ok(distances.every((value, i) => i === 0 || value > distances[i - 1]), "no zero-length grid/vertex duplicate");
});

test("self-crossings, closed routes and retraced legs retain the original one-stroke topology", () => {
  const fixtures = [
    [{ x: .1, y: .1 }, { x: .9, y: .9 }, { x: .1, y: .9 }, { x: .9, y: .1 }],
    [{ x: .1, y: .1 }, { x: .9, y: .1 }, { x: .9, y: .9 }, { x: .1, y: .1 }],
    [{ x: .1, y: .1 }, { x: .9, y: .1 }, { x: .1, y: .1 }, { x: .2, y: .7 }],
  ];
  for (const controls of fixtures) {
    const source = controls.map(point => ({ x: point.x * 500, y: point.y * 500 }));
    const result = sampleMeteorCenterline(controls, 500, 500);
    assertSourceOrder(source, result.points);
    close(cumulative(result.points).at(-1), cumulative(source).at(-1));
    assert.equal(countPathCrossings(result.points), countPathCrossings(source));
  }
});

test("dense authored corners are never discarded to enforce a detail budget; at most 256 extra samples are added", () => {
  const controls = Array.from({ length: 2000 }, (_, i) => ({ x: i % 2, y: i / 1999 }));
  const source = controls.map(point => ({ x: point.x * 100000, y: point.y * 100000 }));
  const result = sampleMeteorCenterline(controls, 100000, 100000);
  assert.ok(result.points.length >= controls.length && result.points.length <= controls.length + 256);
  assertSourceOrder(source, result.points);
  close(result.length, cumulative(source).at(-1));
  close(cumulative(result.points).at(-1), result.length, "polyline length", 1e-5);
});

test("grid-aligned vertices are emitted once and malformed/point inputs remain deterministic without mutation", () => {
  const controls = Object.freeze([
    Object.freeze({ x: 0, y: 0 }), Object.freeze({ x: .5, y: 0 }),
    Object.freeze({ x: .5, y: 0 }), Object.freeze({ x: NaN, y: .3 }),
    Object.freeze({ x: .5, y: .5 }),
  ]);
  const result = sampleMeteorCenterline(controls, 1000, 1000);
  assert.deepEqual(sampleMeteorCenterline(controls, 1000, 1000), result);
  assert.equal(result.points.filter(point => point.x === 500 && point.y === 0).length, 1);
  assert.ok(result.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.deepEqual(sampleMeteorCenterline([], 1000, 1000), { points: [], length: 0 });
  assert.deepEqual(sampleMeteorCenterline([{ x: .2, y: .3 }, { x: .2, y: .3 }], 1000, 500), { points: [{ x: 200, y: 150 }], length: 0 });
});

test("dense first-leg controls cannot bias arc timing, corner arrival, visible prefixes or hit testing", () => {
  const controls = [
    ...Array.from({ length: 80 }, (_, i) => ({ x: .1 + i / 79 * .008, y: .1 })),
    { x: .9, y: .1 }, { x: .9, y: .6 },
  ];
  const before = JSON.stringify(controls);
  for (const raster of [true, false]) {
    const harness = rendererHarness(1, { width: 1000, height: 600 });
    try {
      const renderer = harness.renderer;
      renderer.rasterEnabled = raster;
      const source = { controlPointsOf: () => controls, transformOf: () => ({ scale: 1 }) };
      const path = harness.paths[0];
      const contacts = [], mainPaints = [];
      const originalContact = renderer.drawContact;
      const originalPaint = renderer.paintMaterials;
      renderer.drawContact = function (node, ...args) {
        contacts.push(node);
        return originalContact.call(this, node, ...args);
      };
      renderer.paintMaterials = function (nodes, ...args) {
        if (this.context === harness.surface.canvases[0].context) mainPaints.push(nodes);
        return originalPaint.call(this, nodes, ...args);
      };
      const draw = progress => {
        mainPaints.length = 0;
        renderer.draw(0, harness.paths, harness.agents, source, null, null, harness.view,
          new Map([[path.id, progress]]), { showNib: true, retainTrace: true });
        return contacts.at(-1);
      };
      let head = draw(.5);
      close(head.x, 650, "halfway follows pixels, not sample count"); close(head.y, 60);
      assert.equal(renderer.hitTest(640, 60, 2), path.id);
      assert.equal(renderer.hitTest(670, 60, 2), null, "future route is not clickable");
      assert.ok(mainPaints.every(nodes => nodes.every(node => node.progress <= .5 + 1e-10)));

      const geometry = renderer.geometry(path, source);
      close(geometry.length, 1100);
      const corner = geometry.samples.find(sample => sample.x === 900 && sample.y === 60);
      assert.ok(corner);
      close(corner.progress, 800 / 1100, "corner carries physical arc progress");
      const arc = cumulative(geometry.samples);
      geometry.samples.forEach((sample, i) => close(sample.progress, arc[i] / geometry.length));

      head = draw(800 / 1100);
      close(head.x, 900); close(head.y, 60);
      assert.equal(renderer.hitTest(900, 60, 2), path.id);
      assert.equal(renderer.hitTest(900, 80, 2), null);
      head = draw(.8);
      close(head.x, 900); close(head.y, 140);
      assert.equal(renderer.hitTest(900, 130, 2), path.id);
      assert.equal(renderer.hitTest(900, 160, 2), null);
      assert.equal(renderer.hitTest(880, 80, 2), null, "the missing quadratic shortcut remains unpainted and unpickable");
      assert.ok(mainPaints.every(nodes => nodes.every(node => node.progress <= .8 + 1e-10)));
      if (!raster) assert.ok(mainPaints.flat().some(node => node.x === 900 && node.y === 60), "live prefix preserves its traversed turn");
      else {
        const work = renderer.rasterWork(geometry, 1, 1, true);
        assert.ok(work.nodes.some(node => node.x === 900 && node.y === 60), "cached sweep preserves its traversed turn");
        const live = renderer.nodeAt(work.nodes, .8);
        close(live.x, head.x); close(live.y, head.y);
      }
      // A polygon may change pressure but must not spin automatically just
      // because this route turned through a right angle.
      for (const contact of contacts) {
        const pose = renderer.nibPose(contact);
        close(pose.nx, 0, "fixed physical bearing x"); close(pose.ny, 1, "fixed physical bearing y");
      }
      const replay = draw(.5);
      close(replay.x, 650); close(replay.y, 60);
      assert.equal(renderer.hitTest(900, 130, 2), null, "seeking backward removes future hits");
      assert.equal(JSON.stringify(controls), before, "authored graph coordinates are untouched");
    } finally { harness.dispose(); }
  }
});
