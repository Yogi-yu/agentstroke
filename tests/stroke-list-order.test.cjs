const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const { orderStrokesForList } = createTypeScriptLoader()("lib/strokeListOrder.ts");
const strokes = Object.freeze([
  Object.freeze({ id: "old", created_at: 10 }),
  Object.freeze({ id: "new", created_at: 30 }),
  Object.freeze({ id: "middle", created_at: 20 }),
]);
const ids = (items) => items.map((item) => item.id);

test("canvas selection puts its stroke first and keeps other strokes newest-first", () => {
  assert.deepEqual(ids(orderStrokesForList(strokes, "old")), ["old", "new", "middle"]);
  assert.deepEqual(ids(orderStrokesForList(strokes, "middle")), ["middle", "new", "old"]);
  assert.deepEqual(ids(orderStrokesForList(strokes, "new")), ["new", "middle", "old"]);
  assert.deepEqual(ids(strokes), ["old", "new", "middle"], "Selection must not reorder the canvas or persisted array");
  assert.equal(orderStrokesForList(strokes, "old")[0], strokes[0], "Retain the original stroke and all its attributes");
});

test("clearing selection or deleting the selected stroke restores normal order", () => {
  assert.deepEqual(ids(orderStrokesForList(strokes, null)), ["new", "middle", "old"]);
  assert.deepEqual(ids(orderStrokesForList(strokes, "deleted")), ["new", "middle", "old"]);
  assert.deepEqual(orderStrokesForList([], "old"), []);
});

test("new arrivals cannot displace selection and equal timestamps stay stable", () => {
  const next = [...strokes, { id: "newest", created_at: 40 }, { id: "same-time", created_at: 30 }];
  assert.deepEqual(ids(orderStrokesForList(next, "old")), ["old", "newest", "new", "same-time", "middle"]);
  assert.deepEqual(ids(orderStrokesForList(next, null)), ["newest", "new", "same-time", "middle", "old"]);
});
