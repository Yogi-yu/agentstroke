const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

const load = createTypeScriptLoader();
const { createNaturalPigment, sampleNaturalPigment } = load("engine/colorTreatment.ts");
const STYLES = ["hard", "soft", "watercolor", "texture", "calligraphy"];
const LAYERS = ["color", "core", "rim", "groove"];
const TEXTURE = { pigmentLoad: 0.65, grain: 0.5 };

function rgb(value) {
  const match = /^rgb\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/.exec(value);
  assert.ok(match, `native pigments must be opaque RGB, not HSL/opacity filters: ${value}`);
  const channels = match.slice(1).map(Number);
  assert.ok(channels.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 255));
  return channels;
}
const light = color => color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
const distance = (a, b) => Math.max(...a.map((channel, index) => Math.abs(channel - b[index])));

test("native pigment families and load profiles are stable per artwork, independent of read order", () => {
  const ids = Array.from({ length: 128 }, (_, index) => `native-ink-${index}`);
  const expected = new Map(ids.map(id => [id, createNaturalPigment(id, 3)]));
  for (const list of [ids, [...ids].reverse(), ids.filter((_, index) => index % 3 === 0)]) {
    for (const id of list) assert.deepEqual(createNaturalPigment(id, 3), expected.get(id));
  }
  assert.ok(new Set([...expected.values()].map(profile => profile.families[0].name)).size >= 6,
    "the muted half must offer several actual pigment families, not one neutral tint");
  assert.ok(new Set([...expected.values()].map(profile => profile.density.toFixed(3))).size >= 60,
    "the degree of darkness must vary between artworks");
  for (const profile of expected.values()) {
    assert.equal(profile.families.length, 3);
    assert.ok(profile.flow.length >= 3, "ink load varies smoothly along a stroke");
    for (const family of profile.families) for (const role of ["dense", "body", "dry"]) {
      assert.equal(family[role].length, 3);
      assert.ok(family[role].every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 255));
    }
  }
});

test("short, medium and long palette counts remain gated to one, three or five real pigment stops", () => {
  for (const count of [1, 3, 5]) {
    const profile = createNaturalPigment("native-count", count);
    assert.equal(profile.families.length, count);
    const original = structuredClone(profile);
    for (const style of STYLES) for (const progress of [0, 0.17, 0.5, 0.83, 1]) {
      const palette = sampleNaturalPigment(profile, progress, TEXTURE, style);
      for (const layer of LAYERS) rgb(palette[layer]);
    }
    assert.deepEqual(profile, original, "sampling cannot mutate the profile or its palette stops");
  }
});

test("native dark paint has a substantial darkness range across strokes and organic tonal movement within one pigment", () => {
  const averages = [];
  let varying = 0;
  for (let index = 0; index < 128; index++) {
    const profile = createNaturalPigment(`native-range-${index}`, 1);
    const values = Array.from({ length: 51 }, (_, step) =>
      light(rgb(sampleNaturalPigment(profile, step / 50, TEXTURE, "soft").color)));
    averages.push(values.reduce((sum, value) => sum + value, 0) / values.length);
    if (Math.max(...values) - Math.min(...values) >= 4) varying++;
    assert.ok(Math.min(...values) > 12, "paint remains legible on black rather than becoming transparent black");
    assert.ok(Math.max(...values) < 195, "native dark families do not turn into pale neon highlights");
  }
  assert.ok(Math.max(...averages) - Math.min(...averages) >= 25,
    "artworks need noticeably distinct depths, not one fixed grey-dark transform");
  assert.ok(varying >= 112, "tonal fluctuation must be common even for a single pigment, not restricted to multicolor strokes");
});

test("natural pigment flow and family transitions are continuous, with no new random draws during playback", () => {
  for (const count of [1, 3, 5]) for (let index = 0; index < 12; index++) {
    const profile = createNaturalPigment(`native-smooth-${index}`, count);
    for (const style of STYLES) {
      let previous;
      for (let step = 0; step <= 400; step++) {
        const palette = sampleNaturalPigment(profile, step / 400, TEXTURE, style);
        const current = Object.fromEntries(LAYERS.map(layer => [layer, rgb(palette[layer])]));
        if (previous) for (const layer of LAYERS) {
          assert.ok(distance(current[layer], previous[layer]) <= 4,
            `${style}/${count}/${layer}: ink variation must not introduce abrupt color bands`);
        }
        previous = current;
      }
      for (const progress of [0.82, 0.14, 0.82, 0.5, 0.14]) {
        assert.deepEqual(sampleNaturalPigment(profile, progress, TEXTURE, style),
          sampleNaturalPigment(createNaturalPigment(`native-smooth-${index}`, count), progress, TEXTURE, style),
          "replaying or scrubbing must revisit the same pigment state");
      }
    }
  }
});

test("material deposition changes opaque paint colors without alpha darkening", () => {
  for (const style of STYLES) {
    const profile = createNaturalPigment(`native-deposit-${style}`, 1);
    const loaded = sampleNaturalPigment(profile, 0.43, { pigmentLoad: 1, grain: 0.5 }, style);
    const dry = sampleNaturalPigment(profile, 0.43, { pigmentLoad: 0, grain: 0.5 }, style);
    for (const palette of [loaded, dry]) for (const layer of LAYERS) rgb(palette[layer]);
    assert.notDeepEqual(loaded, dry, "material load should participate in actual pigment density");
  }
});
