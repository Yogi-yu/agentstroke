const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const { StrokeStore } = createTypeScriptLoader()("state/strokeStore.ts");
const published = require("../data/published-canvas.json");

const identity = { translation: { x: 0, y: 0 }, rotation: 0, scale: 1 };
const transform = (x, rotation = 0, scale = 1) => ({ translation: { x, y: -x }, rotation, scale });
const stroke = (id, savedTransform) => ({ ...structuredClone(published.strokes[0]), id, transform: savedTransform });

test("two render stores converge on shared transforms, geometry and hitmaps without a remount", () => {
  const first = new StrokeStore(), second = new StrokeStore();
  const initial = stroke("shared-transform", transform(0.1));
  first.setData([initial], []);
  second.setData([initial], []);
  const before = second.controlPointsOf(initial.id);
  const committed = transform(0.5, 0.4, 1.7);
  first.updateTransform(initial.id, committed);

  const serverSnapshot = [{ ...initial, transform: committed }];
  first.setData(serverSnapshot, []);
  second.setData(serverSnapshot, []);
  assert.deepEqual(second.transformOf(initial.id), committed);
  assert.deepEqual(second.controlPointsOf(initial.id), first.controlPointsOf(initial.id));
  assert.deepEqual(second.data, first.data);
  assert.notDeepEqual(second.controlPointsOf(initial.id), before);
  const point = second.controlPointsOf(initial.id)[0];
  assert.equal(second.hitTest(point.x, point.y, 0.001), initial.id);

  // Missing persisted transform is an authoritative reset, not permission to
  // retain a transform cached by an older render.
  second.setData([{ ...initial, transform: undefined }], []);
  assert.deepEqual(second.transformOf(initial.id), identity);
});

test("only the active local edit survives a shared poll and exit immediately reconciles it", () => {
  const store = new StrokeStore();
  const initial = [stroke("editing", transform(0)), stroke("other", transform(0.1))];
  store.setData(initial, []);
  const preview = transform(0.2, 0.7, 1.4);
  store.updateTransform("editing", preview);
  const remote = [stroke("editing", transform(0.8)), stroke("other", transform(0.4))];
  const before = structuredClone(remote);

  store.setData(remote, [], { localEditId: "editing" });
  assert.deepEqual(store.transformOf("editing"), preview);
  assert.deepEqual(store.transformOf("other"), remote[1].transform);
  assert.deepEqual(remote, before, "Local preview cannot mutate the authoritative snapshot");

  store.setData(remote, [], { localEditId: null });
  assert.deepEqual(store.transformOf("editing"), remote[0].transform);
  const authoritative = new StrokeStore();
  authoritative.setData(remote, []);
  assert.deepEqual(store.data, authoritative.data);
  assert.deepEqual(store.controlPointsOf("editing"), authoritative.controlPointsOf("editing"));
});

test("remote removal and clear discard even a locally edited stroke and its cached transform", () => {
  const store = new StrokeStore();
  const work = stroke("removed-edit", transform(0));
  store.setData([work], []);
  store.updateTransform(work.id, transform(0.6));
  store.setData([], [], { localEditId: work.id });
  assert.equal(store.count, 0);
  assert.equal(store.transforms.has(work.id), false);
  assert.deepEqual(store.controlPointsOf(work.id), []);
  store.setData([work], [], { localEditId: work.id });
  assert.deepEqual(store.transformOf(work.id), work.transform, "Restore cannot resurrect the removed local preview");
});

test("planar reconciles when editing ends; inspect-only sphere always uses authoritative transforms", () => {
  const source = name => fs.readFileSync(path.resolve(__dirname, "..", name), "utf8");
  const planar = source("components/CanvasView.tsx");
  assert.match(planar, /store\.setData\(paths, agents, \{ localEditId: editMode \? selectedStrokeId : null \}\)/);
  assert.match(planar, /\}, \[paths, agents, editMode, selectedStrokeId\]\)/);
  assert.match(source("components/SphereCanvasView.tsx"), /storeRef\.current\.setData\(paths, agents\)/);
});
