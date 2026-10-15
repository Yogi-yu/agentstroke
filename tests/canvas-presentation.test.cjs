const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const { canvasPresentation } = createTypeScriptLoader()("engine/canvasPresentation.ts");
const defaults = { displayMode: "animated", controlled: false, editing: false, reducedMotion: false, arranged: false };

test("static always selects the final full-trace frame, not a paused or fading flight", () => {
  for (const controlled of [true, false]) for (const arranged of [true, false]) {
    assert.equal(canvasPresentation({ ...defaults, displayMode: "static", controlled, arranged }), "static");
  }
});

test("returning to animated mode preserves player, sky, edit and reduced-motion behavior", () => {
  assert.equal(canvasPresentation(defaults), "animated");
  assert.equal(canvasPresentation({ ...defaults, arranged: true }), "sky");
  assert.equal(canvasPresentation({ ...defaults, controlled: true }), "playback");
  assert.equal(canvasPresentation({ ...defaults, controlled: true, reducedMotion: true }), "playback");
  assert.equal(canvasPresentation({ ...defaults, editing: true }), "complete");
  assert.equal(canvasPresentation({ ...defaults, reducedMotion: true }), "complete");
});
