const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const { skyDisplayView } = createTypeScriptLoader()("engine/skyLayout.ts");
const box = { centerX: 0.7, centerY: 0.3, width: 0.18, height: 0.24 };
const screen = (point, view) => ({ x: point.x * view.scale + view.translateX, y: point.y * view.scale + view.translateY });

test("sky display shares a common scale so short strokes stay one tenth of long ones", () => {
  const long = [{ x: 0.1, y: 0.4 }, { x: 0.9, y: 0.6 }];
  const short = [{ x: 0.46, y: 0.49 }, { x: 0.54, y: 0.51 }];
  const before = JSON.stringify({ long, short });
  const a = skyDisplayView(long, box), b = skyDisplayView(short, box);
  assert.equal(a.scale, b.scale);
  assert.ok(Math.abs((short[1].x - short[0].x) * b.scale / ((long[1].x - long[0].x) * a.scale) - 0.1) < 1e-12);
  assert.equal(JSON.stringify({ long, short }), before);
  for (const [points, view] of [[long, a], [short, b]]) {
    const projected = points.map((point) => screen(point, view));
    assert.ok(Math.abs((projected[0].x + projected[1].x) / 2 - box.centerX) < 1e-12);
    assert.ok(Math.abs((projected[0].y + projected[1].y) / 2 - box.centerY) < 1e-12);
  }
});

test("sky placement contains oversized edits and handles point or empty gestures", () => {
  for (const points of [[], [{ x: 0.5, y: 0.5 }], [{ x: -3, y: -2 }, { x: 3, y: 2 }]]) {
    const view = skyDisplayView(points, box);
    assert.ok(Object.values(view).every(Number.isFinite));
    for (const point of points) {
      const result = screen(point, view);
      assert.ok(Math.abs(result.x - box.centerX) <= box.width / 2 + 1e-12);
      assert.ok(Math.abs(result.y - box.centerY) <= box.height / 2 + 1e-12);
    }
  }
});
