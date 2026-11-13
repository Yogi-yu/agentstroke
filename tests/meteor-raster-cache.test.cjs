const test = require("node:test");
const assert = require("node:assert/strict");
const { rendererHarness } = require("./benchmark-meteor.cjs");

const progressFor = (harness, amount) => new Map(harness.paths.map(path => [path.id, amount]));
function warmFlight(harness, options = {}) {
  for (let frame = 1; frame <= 24; frame++) harness.drawDistances(progressFor(harness, frame / 24), options, frame);
}

test("twenty moving nibs reuse cached bodies and only sweep short live contact prefixes", () => {
  const harness = rendererHarness(20);
  try {
    warmFlight(harness);
    const warmed = harness.renderer.getRenderStats();
    assert.ok(warmed.tiles > 0 && warmed.tileBakes > 0);
    assert.ok(warmed.bytes > 0 && warmed.bytes < 64 * 1024 * 1024, "tight tiles respect the 64MiB cache budget");
    const allocated = harness.surface.snapshot().canvases;
    for (let frame = 30; frame < 42; frame++) {
      const commands = harness.draw(frame);
      const stats = harness.renderer.getRenderStats();
      assert.equal(stats.frameTileBakes, 0, "advancing within a warmed flight never rebuilds a material sweep");
      assert.equal(stats.tileBakes, warmed.tileBakes);
      assert.ok(stats.frameSpriteDraws > 0 && commands.drawImage > 0, "the production raster path is actually exercised");
      assert.ok((commands.lineTo ?? 0) < 40000, "only short contact prefixes are vector-painted (baseline exceeded197k lines/frame)");
      assert.ok((commands.fill ?? 0) < 200 && (commands.stroke ?? 0) < 700, "cached bodies never rebuild their material geometry each frame");
      assert.equal(commands.canvases, allocated, "moving playback does not allocate new bitmaps");
    }
  } finally { harness.dispose(); }
});

test("seek, retention, opacity, guides and camera translation reuse the same raster recipe", () => {
  const harness = rendererHarness(4);
  try {
    warmFlight(harness);
    const bakes = harness.renderer.getRenderStats().tileBakes;
    const cases = [
      [0.8, { trailRetention: 0.8 }],
      [0.2, { trailRetention: 0.2 }],
      [0.61, { trailRetention: 0.5, showNib: false }],
      [0.4, { opacityById: new Map(harness.paths.map(path => [path.id, 0.4])) }],
      [0.55, { inspectNib: true }],
    ];
    for (const [amount, options] of cases) {
      harness.drawDistances(progressFor(harness, amount), options);
      assert.equal(harness.renderer.getRenderStats().tileBakes, bakes);
    }
    harness.view.translateX = 0.1; harness.view.translateY = -0.03;
    harness.drawDistances(progressFor(harness, 0.45));
    assert.equal(harness.renderer.getRenderStats().tileBakes, bakes, "panning repositions cached artwork, not its pigment");
  } finally { harness.dispose(); }
});

test("zoom, transform edits, authored changes, hue and resize invalidate affected cached pixels", () => {
  const harness = rendererHarness(2);
  const original = harness.paths[0];
  try {
    warmFlight(harness);
    let bakes = harness.renderer.getRenderStats().tileBakes;
    harness.view.scale = 1.4;
    harness.drawDistances(progressFor(harness, 0.5));
    assert.ok(harness.renderer.getRenderStats().tileBakes > bakes, "screen-scale pressure changes require a fresh raster");
    bakes = harness.renderer.getRenderStats().tileBakes;
    const transform = harness.store.transformOf(original.id);
    harness.store.updateTransform(original.id, { ...transform, scale: transform.scale * 1.3 });
    harness.drawDistances(progressFor(harness, 0.5));
    assert.ok(harness.renderer.getRenderStats().tileBakes > bakes, "transform edits invalidate geometry and pressure");
    bakes = harness.renderer.getRenderStats().tileBakes;
    harness.paths[0] = { ...structuredClone(original), color_treatment: original.color_treatment === "muted" ? "bright" : "muted" };
    harness.store.setData(harness.paths, harness.agents);
    harness.drawDistances(progressFor(harness, 0.5));
    assert.ok(harness.renderer.getRenderStats().tileBakes > bakes, "a new artwork snapshot cannot retain stale pigment");
    bakes = harness.renderer.getRenderStats().tileBakes;
    const agents = [{ id: original.agent_id, style: { hue: 35, speedFactor: 0.7 } }];
    harness.surface.reset();
    harness.renderer.draw(0, harness.paths, agents, harness.store, null, null, harness.view,
      progressFor(harness, 0.5), { trailRetention: 0.2, showNib: true });
    assert.ok(harness.renderer.getRenderStats().tileBakes > bakes, "agent hue changes cannot retain stale colors");
    harness.renderer.resize(900, 600, 2);
    assert.equal(harness.renderer.getRenderStats().bytes, 0, "DPR/resize releases previous resolution's bitmaps");
    harness.drawDistances(progressFor(harness, 0.5));
    assert.ok(harness.renderer.getRenderStats().bytes > 0);
  } finally {
    harness.paths[0] = original;
    harness.dispose();
  }
});

test("the first frame shows an actual-size material contact and outline with no introductory animation", () => {
  const harness = rendererHarness(1);
  try {
    const frame = harness.drawDistances(progressFor(harness, 0), {
      showNib: true, inspectNib: true,
    });
    const stats = harness.renderer.getRenderStats();
    assert.equal(stats.frameTileBakes, 0, "the first contact must not prepare invisible future pixels");
    assert.equal(stats.frameSpriteDraws, 0);
    assert.ok((frame.fill ?? 0) >= 1 && (frame.stroke ?? 0) >= 1, "the material impression and exact outline are present immediately");
    assert.ok((frame.lineTo ?? 0) >= 7 && (frame.lineTo ?? 0) < 3000, "the material uses the true eight-axis polygon, not a circle/dot");
    assert.ok(frame.fillText > 0, "magnified contact identifies itself as an inspection guide");
    const empty = harness.drawDistances(progressFor(harness, 0), { showNib: false });
    assert.equal(empty.drawImage ?? 0, 0);
    assert.equal(empty.fill ?? 0, 0);
  } finally { harness.dispose(); }
});

test("refused raster allocation falls back to painted ink instead of dropping the stroke", () => {
  const harness = rendererHarness(1);
  try {
    harness.surface.document.createElement = () => null;
    const frame = harness.drawDistances(progressFor(harness, 0.55), { showNib: false });
    assert.equal(harness.renderer.getRenderStats().frameTileBakes, 0);
    assert.equal(harness.renderer.getRenderStats().frameSpriteDraws, 0);
    assert.ok((frame.fill ?? 0) > 1, "visible material survives when no bitmap can be allocated");
    assert.ok((frame.clip ?? 0) > 0, "fallback still honors the reveal and tile ownership planes");
  } finally { harness.dispose(); }
});

test("removing artworks and disposing a renderer release its raster memory", () => {
  const harness = rendererHarness(4);
  try {
    warmFlight(harness);
    const before = harness.renderer.getRenderStats();
    const fewer = harness.paths.slice(0, 2);
    harness.renderer.draw(0, fewer, harness.agents, harness.store, null, null, harness.view,
      new Map(fewer.map(path => [path.id, 0.5])), { trailRetention: 0.2 });
    const reduced = harness.renderer.getRenderStats();
    assert.ok(reduced.bytes < before.bytes && reduced.tiles < before.tiles);
    harness.renderer.draw(0, [], harness.agents, harness.store, null, null, harness.view, new Map());
    assert.equal(harness.renderer.getRenderStats().bytes, 0);
    assert.equal(harness.renderer.getRenderStats().tiles, 0);
    harness.renderer.dispose();
    assert.equal(harness.renderer.getRenderStats().bytes, 0);
    assert.ok(harness.surface.canvases.slice(1).every(canvas => canvas.width === 0 && canvas.height === 0),
      "cache and scratch backing stores are explicitly released, not retained by a stale renderer");
  } finally { harness.dispose(); }
});
