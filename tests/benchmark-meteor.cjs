/*
 * Repeatable CPU/command benchmark for the real renderer, not a replacement
 * drawing algorithm. No database, API key, browser, saved work or file writes.
 * Run: node tests/benchmark-meteor.cjs [stroke-count] [measured-frames]
 * Raster/GPU work is intentionally NOT timed by this command-counting canvas;
 * the browser remains the visual / end-to-end performance acceptance test.
 */
const { performance } = require("node:perf_hooks");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

function fixtures(count = 20) {
  const modes = ["linear", "curved", "spiral", "recursive", "oscillatory", "fragmented"];
  const intensities = [0.65, 0.73, 0.79, 0.9, 0.79];
  return Array.from({ length: count }, (_, index) => ({
    id: `nib-benchmark-${index}`, agent_id: `agent-${String(index).padStart(3, "0")}`,
    from: "ink", to: "flight", timestamp: 100, created_at: 100 + index,
    motion_type: "curved", geometry_mode: modes[index % modes.length], motion_model: "wave",
    generation_mode: "autonomous", base_seed: 456 + index * 331,
    variation_seed: 987321 + index * 1009, brush_treatment: index % 5 === 4 ? "calligraphy" : "original",
    color_treatment: index % 2 ? "muted" : "bright",
    mood: { timestamp: 100, entropy_shift: 0, drift_bias: 0.28, curvature_bias: 0.35,
      motion_variation: 0.35 + index % 4 * 0.16, color_variation: -0.1 },
    points: Array.from({ length: 12 + index % 11 }, (_, step) => ({
      step, anchor: ["ink", "paper", "grain", "fiber", "wing", "wind", "sky", "flight"][step % 8],
      x: step / (11 + index % 11), y: 0.5 + Math.sin(step * 0.7 + index) * 0.12,
      entropy: 0.46 + step % 3 * 0.08, confidence: 0.54 + step % 4 * 0.05,
      intensity: intensities[index % intensities.length], stroke_width: 1,
      branch: step % 3 === 0 ? 1 : 0, duration_ms: 200 + step * 30,
    })),
  }));
}

function countingSurface() {
  let counts = Object.create(null);
  let canvases = 0;
  const allocated = [];
  const count = (key, amount = 1) => { counts[key] = (counts[key] ?? 0) + amount; };
  const gradient = () => ({ addColorStop() { count("colorStops"); } });
  class CountingPath {
    constructor(source) { count("pathObjects"); this.source = source; }
    moveTo() { count("pathMoves"); }
    lineTo() { count("pathLines"); }
    closePath() { count("pathCloses"); }
    rect() { count("pathRects"); }
    arc() { count("pathArcs"); }
    ellipse() { count("pathEllipses"); }
    addPath() { count("pathAdds"); }
  }
  class CountingCanvas {
    constructor() {
      canvases++;
      allocated.push(this);
      this.style = {};
      this.width = 1; this.height = 1;
      this.ownerDocument = document;
      const values = { canvas: this, globalAlpha: 1, globalCompositeOperation: "source-over" };
      const stack = [];
      const methods = {
        createLinearGradient: gradient, createRadialGradient: gradient,
        save() { stack.push({ globalAlpha: values.globalAlpha, globalCompositeOperation: values.globalCompositeOperation }); count("save"); },
        restore() { Object.assign(values, stack.pop() ?? {}); count("restore"); },
        measureText(value) { return { width: value.length * 7 }; },
        getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
      };
      this.context = new Proxy(values, {
        get(target, key) {
          if (key in methods) return methods[key];
          if (key in target) return target[key];
          return (...args) => {
            count(String(key));
            if (key === "drawImage") {
              const width = args.length === 9 ? args[7] : args.length === 5 ? args[3] : args[0]?.width ?? 0;
              const height = args.length === 9 ? args[8] : args.length === 5 ? args[4] : args[0]?.height ?? 0;
              count("imagePixels", width * height);
            }
          };
        },
        set(target, key, value) { target[key] = value; return true; },
      });
    }
    getContext(kind) { return kind === "2d" ? this.context : null; }
    get clientWidth() { return this.width; }
    get clientHeight() { return this.height; }
  }
  const document = { createElement(tag) { if (tag !== "canvas") throw Error(`Unexpected element: ${tag}`); return new CountingCanvas(); } };
  return {
    createCanvas: () => new CountingCanvas(), document, Path2D: CountingPath,
    snapshot: () => ({ ...counts, canvases }),
    canvases: allocated,
    reset: () => { counts = Object.create(null); },
  };
}

function rendererHarness(count = 20, { width = 1250, height = 720, dpr = 1, installCanvasFactory = true } = {}) {
  const surface = countingSurface();
  const savedDocument = global.document, savedPath = global.Path2D;
  if (installCanvasFactory) { global.document = surface.document; global.Path2D = surface.Path2D; }
  const load = createTypeScriptLoader();
  const { MeteorRenderer } = load("render/meteorRenderer.ts");
  const { StrokeStore } = load("state/strokeStore.ts");
  const renderer = new MeteorRenderer(surface.createCanvas());
  renderer.resize(width, height, dpr);
  const paths = fixtures(count);
  const before = JSON.stringify(paths);
  const agents = [];
  const store = new StrokeStore();
  store.setData(paths, agents);
  const view = { scale: 1, translateX: 0, translateY: 0 };
  const drawDistances = (progress, options = {}, frame = 0) => {
    surface.reset();
    const started = performance.now();
    renderer.draw(frame * 16.667, paths, agents, store, null, null, view, progress, { trailRetention: 0.2, showNib: true, ...options });
    return { ms: performance.now() - started, ...surface.snapshot() };
  };
  const draw = (frame, options = {}) => drawDistances(new Map(paths.map((path, index) =>
    [path.id, 0.2 + ((frame * 0.0031 + index * 0.039) % 0.7)])), options, frame);
  const dispose = () => {
    renderer.dispose();
    if (JSON.stringify(paths) !== before) throw Error("Renderer mutated saved artwork fixture");
    if (installCanvasFactory) {
      if (savedDocument === undefined) delete global.document; else global.document = savedDocument;
      if (savedPath === undefined) delete global.Path2D; else global.Path2D = savedPath;
    }
  };
  return { draw, drawDistances, dispose, surface, renderer, paths, agents, store, view };
}

function runBenchmark(count = 20, measuredFrames = 30) {
  const harness = rendererHarness(count);
  try {
    const cold = harness.draw(0);
    // Populate a complete flight before measuring cached playback. Cold work
    // is reported separately and may be intentionally spread across frames.
    for (let frame = 1; frame <= 24; frame++) harness.drawDistances(new Map(harness.paths.map(path => [path.id, frame / 24])));
    const frames = Array.from({ length: measuredFrames }, (_, frame) => harness.draw(frame + 9));
    const times = frames.map(frame => frame.ms).sort((a, b) => a - b);
    const names = [...new Set(frames.flatMap(frame => Object.keys(frame)))].filter(name => name !== "ms");
    return {
      description: "Actual renderer CPU and Canvas command counts; excludes browser raster/GPU time",
      strokes: count, viewport: "1250×720@1", trailRetention: 0.2,
      coldFrame: cold,
      rendererStats: harness.renderer.getRenderStats?.() ?? null,
      warm: {
        measuredFrames, medianMs: times[Math.floor(times.length * 0.5)],
        p90Ms: times[Math.min(times.length - 1, Math.floor(times.length * 0.9))],
        meanCommands: Object.fromEntries(names.map(name => [name, frames.reduce((sum, frame) => sum + (frame[name] ?? 0), 0) / frames.length])),
      },
    };
  } finally { harness.dispose(); }
}

module.exports = { fixtures, countingSurface, rendererHarness, runBenchmark };
if (require.main === module) console.log(JSON.stringify(runBenchmark(Number(process.argv[2]) || 20, Number(process.argv[3]) || 30), null, 2));
