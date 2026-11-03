const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const { canvasPresentation, readCanvasDisplayMode } = createTypeScriptLoader()("engine/canvasPresentation.ts");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("stored display preference accepts all three modes and rejects stale or invalid values", () => {
  for (const mode of ["animated", "static", "sphere"]) assert.equal(readCanvasDisplayMode(mode), mode);
  for (const value of [null, undefined, "3d", "Sphere", {}, 1, false]) {
    assert.equal(readCanvasDisplayMode(value), "animated");
  }
});

test("sphere remains an animated presentation, respecting motion and editing safeguards", () => {
  const options = { displayMode: "sphere", controlled: false, editing: false, reducedMotion: false, arranged: false };
  assert.equal(canvasPresentation(options), "animated");
  assert.equal(canvasPresentation({ ...options, reducedMotion: true }), "complete");
  assert.equal(canvasPresentation({ ...options, editing: true }), "complete");
  assert.equal(canvasPresentation({ ...options, displayMode: "static" }), "static");
});

test("both existing canvas surfaces expose a Sphere presentation without changing generation", () => {
  for (const file of ["app/studio/page.tsx", "app/sky/page.tsx"]) {
    const source = read(file);
    assert.match(source, /aria-pressed=\{displayMode === "sphere"\}/);
    assert.match(source, />Sphere<\/button>/);
    assert.match(source, /displayMode=\{displayMode\}/);
    assert.match(source, /paths=\{(?:strokes|paths)\}/);
  }
  const sky = read("app/sky/page.tsx");
  assert.ok(sky.indexOf("sky-display-controls") > sky.indexOf("presentation.showCanvas ?"), "Do not show an empty sphere before a sky exists");
  assert.match(sky, /useState\(ANIMATED_TRAIL_RETENTION\)/);
  assert.match(sky, /trailRetention=\{trailRetention\}/);
});

test("editing stays planar and mode switching cannot discard an active edit", () => {
  const source = read("app/studio/page.tsx");
  assert.match(source, /const changeDisplayMode = useCallback\(\(mode: CanvasDisplayMode\) => \{\s*if \(edit\.active\) return;/);
  assert.match(source, /if \(displayMode === "sphere"\) changeDisplayMode\("animated"\);/);
  assert.match(source, /disabled=\{edit\.active\} aria-pressed=\{displayMode === "sphere"\}/);
  assert.match(source, /readCanvasDisplayMode\(localStorage.getItem\("noema.snapshot.display-mode"\)\)/);
});

test("trail slider stays enabled in Sphere and still disables Static or active editing", () => {
  const source = read("components/TrailRetentionControl.tsx");
  assert.match(source, /const disabled = editMode \|\| displayMode === "static";/);
  assert.match(source, /displayMode: CanvasDisplayMode;/);
  assert.match(source, /Available in Animated and Sphere modes/);
});
