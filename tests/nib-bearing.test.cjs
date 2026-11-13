const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const { rendererHarness } = require("./benchmark-meteor.cjs");

const load = createTypeScriptLoader();
const { interpolateBrushHeadPose, placeBrushHead, buildBrushHeadSweep } = load("engine/brushHeadSweep.ts");
const { resolveVisualSignature } = load("engine/visualSignature.ts");
const { getStrokePlayback } = load("engine/strokePlayback.ts");

const close = (actual, expected, label = "value") =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${label}: ${actual} != ${expected}`);
const texture = edge => ({
  leftEdge: edge, rightEdge: edge, depositOffset: .1, depositWidth: .3,
  grooveOffset: .2, grooveWidth: .1, grooveBreakup: .8,
  pigmentLoad: .7, dryness: .2, grain: .4,
});
const node = (x, y, angle, progress, extra = {}) => ({
  x, y, nx: Math.cos(angle), ny: Math.sin(angle), nibNx: 0, nibNy: 1,
  progress, width: 4, texture: texture(1), energy: 1, bias: 0, cutback: 0,
  sample: { color: "hsl(150 40% 30%)", core: "hsl(150 40% 40%)", rim: "hsl(150 40% 20%)" },
  ...extra,
});
const square = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];

function inside(point, polygon) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

test("an actual L path keeps one physical nib bearing while its travel normal turns", () => {
  const harness = rendererHarness(1);
  try {
    const controls = [{ x: .1, y: .2 }, { x: .7, y: .2 }, { x: .7, y: .8 }];
    const store = { controlPointsOf: () => controls, transformOf: () => ({ scale: 1, rotation: 0, translateX: 0, translateY: 0 }) };
    const path = harness.paths[0];
    const before = JSON.stringify(path);
    const signature = resolveVisualSignature(path), timing = getStrokePlayback(path);
    const geometry = harness.renderer.geometry(path, store);
    const capture = { nodes: [], retainTrace: true };
    harness.renderer.drawMeteor(geometry, 1, 1, 1, true, 1, .2, capture);
    assert.ok(capture.nodes.length > 2);
    for (const point of capture.nodes) {
      const pose = harness.renderer.nibPose(point);
      close(pose.nx, 0, "initial horizontal stroke sets fixed cross-bearing x");
      close(pose.ny, 1, "initial horizontal stroke sets fixed cross-bearing y");
      close(pose.width, point.width * (point.texture.leftEdge + point.texture.rightEdge) / 2,
        "bearing does not modify the authored pressure/coverage width");
    }
    assert.ok(capture.nodes.some(point => point.ny > .95), "horizontal travel normal remains available");
    assert.ok(capture.nodes.some(point => point.nx < -.95), "vertical travel normal remains available");
    assert.equal(JSON.stringify(path), before);
    assert.deepEqual(resolveVisualSignature(path), signature, "size, pigment and material signature stay untouched");
    assert.deepEqual(getStrokePlayback(path), timing, "timing stays untouched");
  } finally { harness.dispose(); }
});

test("fixed polygon bearing leaves an L-shaped deposit with actual facets, not a rotational fan", () => {
  const harness = rendererHarness(1);
  try {
    const nodes = [node(0, 0, Math.PI / 2, 0), node(12, 0, Math.PI / 2, .5), node(12, 12, Math.PI, 1)];
    const before = JSON.stringify(nodes);
    const poses = nodes.map(point => harness.renderer.nibPose(point));
    const deposit = buildBrushHeadSweep(poses, square);
    assert.ok(deposit.length > 0);
    for (const point of deposit.flat()) {
      assert.ok(point.x >= -2 - 1e-8 && point.x <= 14 + 1e-8, "no rotating vertex protrudes beyond the real fixed face");
      assert.ok(point.y >= -2 - 1e-8 && point.y <= 14 + 1e-8);
    }
    for (const point of [{ x: 6, y: 1.5 }, { x: 13.5, y: 6 }, { x: 13.5, y: -1.5 }])
      assert.ok(deposit.some(polygon => inside(point, polygon)), "the two legs and sharp external corner remain continuously painted");
    for (const point of [{ x: 14.4, y: 3 }, { x: 8, y: 4 }])
      assert.ok(!deposit.some(polygon => inside(point, polygon)), "no orbital fan or invented diagonal bridge");
    const finalCap = deposit.at(-1);
    const exact = placeBrushHead(square, poses.at(-1));
    assert.equal(finalCap.length, exact.length);
    for (const point of exact) assert.ok(finalCap.some(other => Math.hypot(other.x - point.x, other.y - point.y) < 1e-8));
    assert.equal(JSON.stringify(nodes), before);
  } finally { harness.dispose(); }
});

test("live interpolation separates travel direction from the fixed physical bearing and unchanged width", () => {
  const harness = rendererHarness(1);
  try {
    const nibAngle = .31;
    const fixed = { nibNx: Math.cos(nibAngle), nibNy: Math.sin(nibAngle) };
    const a = node(20, 30, Math.PI / 2, 0, { ...fixed, width: 10, texture: texture(1) });
    const b = node(80, 110, Math.PI, 1, { ...fixed, width: 20, texture: texture(.5) });
    for (const t of [.05, .2, .5, .8, .95]) {
      const live = harness.renderer.nodeAt([a, b], t);
      const contact = harness.renderer.nibPose(live);
      const travel = interpolateBrushHeadPose(a, b, t);
      close(live.nx, travel.nx, "travel clipping normal x");
      close(live.ny, travel.ny, "travel clipping normal y");
      close(contact.nx, fixed.nibNx, "physical bearing x");
      close(contact.ny, fixed.nibNy, "physical bearing y");
      close(contact.width, 10, "interpolated effective contact width remains unchanged");
      close(contact.x, 20 + 60 * t); close(contact.y, 30 + 80 * t);
      for (const zoom of [.4, 1, 2.5]) {
        const cap = harness.renderer.contactPath(live, square, zoom);
        const projected = cap.map(point => (point.x - contact.x) * contact.nx + (point.y - contact.y) * contact.ny);
        close((Math.max(...projected) - Math.min(...projected)) * zoom, 10,
          "bearing retains the existing physical cross-span at every zoom");
        const deposited = buildBrushHeadSweep([harness.renderer.nibPose(a), contact], square, zoom);
        for (const point of cap) assert.ok(deposited.at(-1).some(other => Math.hypot(other.x - point.x, other.y - point.y) < 1e-8),
          "the visible cap is exactly the newest deposited footprint");
      }
    }
  } finally { harness.dispose(); }
});

test("tile/reveal ownership planes use travel normals even when the nib bearing is different", () => {
  const harness = rendererHarness(1);
  try {
    const context = harness.surface.canvases[0].context;
    let recorded = [];
    context.beginPath = () => { recorded = []; };
    context.moveTo = (x, y) => recorded.push({ x, y });
    context.lineTo = (x, y) => recorded.push({ x, y });
    for (const angle of [0, .4, Math.PI / 2, Math.PI]) for (const forward of [true, false]) {
      const point = node(30, 50, angle, .5, { nibNx: Math.cos(2.3), nibNy: Math.sin(2.3) });
      harness.renderer.clipNibSpan(point, forward);
      assert.equal(recorded.length, 4);
      const [a, b, c] = recorded;
      close((a.x + b.x) / 2, point.x); close((a.y + b.y) / 2, point.y);
      const edgeX = b.x - a.x, edgeY = b.y - a.y;
      const edgeLength = Math.hypot(edgeX, edgeY);
      close((edgeX * point.ny - edgeY * point.nx) / edgeLength, 0, "clip boundary follows travel normal, not nib bearing");
      const sign = forward ? 1 : -1;
      assert.ok(((c.x - b.x) * point.ny - (c.y - b.y) * point.nx) * sign > 0,
        "forward/rear ownership stays on the correct travel half-plane");
    }
  } finally { harness.dispose(); }
});
