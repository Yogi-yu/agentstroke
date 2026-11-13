const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const { NibRasterCache, splitNibTiles } = createTypeScriptLoader()("render/nibRasterCache.ts");

const canvas = (width, height) => ({ width, height });
const node = (x, y = 0, nx = 0, ny = 1, progress = x / 100) => ({ x, y, nx, ny, width: 6, progress });
function frozenNodes(points) { return Object.freeze(points.map(point => Object.freeze(point))); }

test("raster cache uses an exact pixel byte budget and recently read tiles survive eviction", () => {
  const cache = new NibRasterCache(canvas, 800);
  const a = cache.make(10, 10), b = cache.make(10, 10), c = cache.make(10, 10);
  cache.put("a", a); cache.put("b", b);
  assert.deepEqual(cache.stats, { bytes: 800, tiles: 2, evictions: 0 });
  assert.equal(cache.get("a"), a);
  cache.put("c", c);
  assert.equal(cache.get("b"), null);
  assert.deepEqual(b, { width: 0, height: 0 });
  assert.equal(cache.get("a"), a);
  assert.equal(cache.get("c"), c);
  assert.deepEqual(cache.stats, { bytes: 800, tiles: 2, evictions: 1 });
  const snapshot = cache.stats; snapshot.bytes = -10;
  assert.equal(cache.stats.bytes, 800, "stats are a read-only snapshot of cache accounting");
});

test("allocation checks reject malformed or oversized tiles without scaling the geometry", () => {
  const allocations = [];
  const cache = new NibRasterCache((w, h) => { allocations.push([w, h]); return canvas(w, h); });
  for (const [w, h] of [[0, 4], [-1, 4], [Infinity, 4], [NaN, 4], [4, NaN], [4097, 1], [1, 4097]]) assert.equal(cache.make(w, h), null);
  assert.deepEqual(allocations, []);
  assert.deepEqual(cache.make(12.1, 5.4), { width: 13, height: 6 });
  assert.deepEqual(allocations, [[13, 6]]);
  const small = new NibRasterCache(canvas, 399);
  assert.equal(small.make(10, 10), null);
  const huge = canvas(4096, 4096);
  small.put("oversize", huge);
  assert.deepEqual(huge, { width: 0, height: 0 });
  assert.deepEqual(small.stats, { bytes: 0, tiles: 0, evictions: 0 });
  assert.equal(new NibRasterCache(() => null).make(1, 1), null);
  assert.equal(new NibRasterCache(() => { throw new Error("allocation failed"); }).make(1, 1), null);
});

test("replacement, aliases, prefix deletion and clear release pixels without leaking or double counting", () => {
  const cache = new NibRasterCache(canvas, 2000);
  const a = canvas(10, 10), b = canvas(10, 10), c = canvas(5, 5);
  cache.put("stroke-a:0", a); cache.put("stroke-b:0", b);
  cache.put("stroke-a:1", a);
  assert.equal(cache.get("stroke-a:0"), null);
  assert.equal(a.width, 10, "renaming the same canvas must not erase its pixels");
  assert.equal(cache.stats.bytes, 800);
  cache.put("stroke-a:1", c);
  assert.equal(a.width, 0);
  assert.equal(cache.stats.bytes, 500);
  cache.deletePrefix("stroke-a:");
  assert.deepEqual(c, { width: 0, height: 0 });
  assert.equal(cache.get("stroke-b:0"), b);
  assert.equal(cache.stats.bytes, 400);
  cache.clear(); cache.clear();
  assert.deepEqual(b, { width: 0, height: 0 });
  assert.deepEqual(cache.stats, { bytes: 0, tiles: 0, evictions: 0 });
});

test("straight arc tiles cover every original interval exactly once with shared endpoints and bounded work", () => {
  const nodes = frozenNodes(Array.from({ length: 101 }, (_, i) => node(i * 8, 40, 0, 1, i / 100)));
  const before = structuredClone(nodes);
  const tiles = splitNibTiles(nodes);
  assert.equal(tiles[0].start, 0);
  assert.equal(tiles.at(-1).end, nodes.length - 1);
  let intervals = 0;
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    assert.ok(tile.end > tile.start && tile.end - tile.start + 1 <= 12);
    assert.ok(nodes[tile.end].x - nodes[tile.start].x <= 96);
    if (i) assert.equal(tile.start, tiles[i - 1].end);
    intervals += tile.end - tile.start;
  }
  assert.equal(intervals, nodes.length - 1);
  assert.deepEqual(nodes, before);
  const magnified = splitNibTiles(nodes, 4);
  assert.ok(magnified.length > tiles.length);
  assert.ok(magnified.every(tile => (nodes[tile.end].x - nodes[tile.start].x) * 4 <= 96));
});

test("reversals and tiny loops cannot share a reveal tile with their future path", () => {
  const reversal = frozenNodes([node(0), node(20), node(40), node(20, 0, 0, -1), node(0, 0, 0, -1), node(20)]);
  const tiles = splitNibTiles(reversal);
  for (const { start, end } of tiles) {
    if (end <= start + 1) continue;
    const a = reversal[start], b = reversal[end];
    const dx = b.x - a.x, dy = b.y - a.y;
    let projection = -Infinity;
    for (let i = start; i <= end; i++) {
      const next = (reversal[i].x - a.x) * dx + (reversal[i].y - a.y) * dy;
      assert.ok(next >= projection - 1e-8);
      projection = next;
    }
  }
  // A small backward step amid a long forward run has an excellent chord/arc
  // ratio but would still expose a future pixel if one tile crossed it.
  const smallLoop = [node(0), node(50), node(49.9), node(80)];
  assert.deepEqual(splitNibTiles(smallLoop), [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }]);
});

test("empty, stationary and incomplete paths remain finite without manufacturing cross-gap intervals", () => {
  assert.deepEqual(splitNibTiles([]), []);
  assert.deepEqual(splitNibTiles([node(0)]), [{ start: 0, end: 0 }]);
  assert.deepEqual(splitNibTiles([node(0), node(1000)]), [{ start: 0, end: 1 }], "one original long segment cannot be subdivided by index planning");
  const stationary = [node(5, 5), node(5, 5, 1, 0), node(5, 5, 0, -1)];
  assert.deepEqual(splitNibTiles(stationary), [{ start: 0, end: 1 }, { start: 1, end: 2 }]);
  const gaps = [node(0), node(10), node(NaN), node(30), node(40)];
  assert.deepEqual(splitNibTiles(gaps), [{ start: 0, end: 1 }, { start: 3, end: 4 }]);
  assert.deepEqual(splitNibTiles([node(0), node(10)], NaN), splitNibTiles([node(0), node(10)]));
});
