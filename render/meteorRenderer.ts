import type { Agent, BrushStrokeStyle, StrokeVisualSignature, TransitionPath } from "@/lib/types";
import type { StrokeStore } from "@/state/strokeStore";
import type { CanvasTransformState } from "@/store/canvasTransform";
import { resolveVisualSignature, sampleWidthProfile } from "@/engine/visualSignature";
import { hashStr } from "@/simulation/rng";
import { createNaturalPigment, pigmentHsl, sampleNaturalPigment } from "@/engine/colorTreatment";
import { ANIMATED_TRAIL_RETENTION, animatedTrailOpacity, animatedTrailStart, clampTrailRetention } from "@/engine/meteorTrail";
import { resolveBrushHeadProfile } from "@/engine/brushHeadProfile";
import { normalizeBrushHead, placeBrushHead, interpolateBrushHeadPose, buildBrushHeadSweep, appendBrushHeadSweep, simplifyBrushHeadPoses, type NibPoint, type BrushHeadPose } from "@/engine/brushHeadSweep";
import { NibRasterCache, splitNibTiles } from "@/render/nibRasterCache";
import { sampleMeteorCenterline } from "@/engine/meteorCenterline";
export { sampleMeteorCenterline } from "@/engine/meteorCenterline";

/** A surface adapter may relocate controls without mutating an archived work. */
export type MeteorStrokeSource = Pick<StrokeStore, "controlPointsOf" | "transformOf">;

interface Point { x: number; y: number }
interface MeteorSample extends Point {
  /** Actual cumulative travelled distance, not sample-array position. */
  progress: number;
  nx: number;
  ny: number;
  pressure: number;
  color: string;
  core: string;
  rim: string;
  groove: string;
  texture: BrushTextureSample;
}
interface MeteorGeometry {
  controls: readonly Point[];
  path: TransitionPath;
  hue: number;
  samples: MeteorSample[];
  length: number;
  signature: StrokeVisualSignature;
  nib: readonly NibPoint[];
  nibBearing: { nx: number; ny: number };
}

interface RibbonNode extends Point {
  /** Physical nib frame is independent of the direction of travel. */
  nibNx?: number;
  nibNy?: number;
  nx: number;
  ny: number;
  width: number;
  bias: number;
  cutback: number;
  energy: number;
  sample: MeteorSample;
  texture: BrushTextureSample;
  progress: number;
}

interface RasterTile { key: string; start: number; end: number; x: number; y: number; width: number; height: number }
interface RasterWork { geometry: MeteorGeometry; key: string; nodes: RibbonNode[]; tiles: RasterTile[]; zoom: number; retainTrace: boolean }
interface NodeCapture { nodes: RibbonNode[]; retainTrace: boolean }

export interface BrushMaterialConfig {
  surface: "cut-face" | "ink-belly" | "wet-sediment" | "dry-fibers" | "split-ink";
  bodyLightness: number;
  highlightLightness: number;
  rimLightness: number;
  grooveLightness: number;
  sedimentContrast: number;
  edgeRoughness: number;
  fiberCount: number;
}

const MATERIAL_CONFIG: Record<BrushStrokeStyle, Readonly<BrushMaterialConfig>> = {
  hard: { surface: "cut-face", bodyLightness: 60, highlightLightness: 88, rimLightness: 32, grooveLightness: 30, sedimentContrast: 0, edgeRoughness: 0, fiberCount: 0 },
  soft: { surface: "ink-belly", bodyLightness: 59, highlightLightness: 76, rimLightness: 21, grooveLightness: 5, sedimentContrast: 12, edgeRoughness: 0.18, fiberCount: 3 },
  watercolor: { surface: "wet-sediment", bodyLightness: 67, highlightLightness: 86, rimLightness: 23, grooveLightness: 37, sedimentContrast: 38, edgeRoughness: 0.62, fiberCount: 0 },
  texture: { surface: "dry-fibers", bodyLightness: 67, highlightLightness: 84, rimLightness: 25, grooveLightness: 2, sedimentContrast: 24, edgeRoughness: 0.31, fiberCount: 5 },
  // Calligraphy has a matte, loaded face rather than a pale wash or glossy
  // bevel. Its dry channels are unpainted gaps, not an opacity simulation.
  calligraphy: { surface: "split-ink", bodyLightness: 59, highlightLightness: 62, rimLightness: 47, grooveLightness: 2, sedimentContrast: 8, edgeRoughness: 0.46, fiberCount: 7 },
};

/** Read-only material recipe, also used by the attribute inspector and QA. */
export function getBrushMaterialConfig(style: BrushStrokeStyle): Readonly<BrushMaterialConfig> {
  return MATERIAL_CONFIG[style];
}

export interface BrushTextureSource {
  entropy: number;
  confidence: number;
  intensity: number;
  pressure: number;
}

export interface BrushTextureSample {
  leftEdge: number;
  rightEdge: number;
  depositOffset: number;
  depositWidth: number;
  grooveOffset: number;
  grooveWidth: number;
  /** Smoothly opens/closes dry channels; the underlying ribbon stays intact. */
  grooveBreakup: number;
  pigmentLoad: number;
  dryness: number;
  grain: number;
}

/**
 * Continuous, seeded material structure, sampled by travelled distance.
 * Entropy increases dryness/edge irregularity, confidence consolidates the
 * boundary, intensity loads pigment, and pressure closes or opens dry grooves.
 * None of these fields adds points or moves the single trajectory centreline.
 */
export function sampleBrushTexture(style: BrushStrokeStyle, source: BrushTextureSource, progress: number, seed: number): BrushTextureSample {
  const entropy = clamp(source.entropy, 0, 1);
  const confidence = clamp(source.confidence, 0, 1);
  const intensity = clamp(source.intensity, 0, 1);
  const pressure = clamp(source.pressure, 0.1, 3.2);
  const t = clamp(progress, 0, 1);
  const phase = ((Math.imul(seed | 0, 1664525) + 1013904223) >>> 0) / 4294967296 * Math.PI * 2;
  const coarse = Math.sin(t * Math.PI * (8 + entropy * 7) + phase);
  const fine = Math.sin(t * Math.PI * (30 + entropy * 26) + phase * 1.73);
  const grain = clamp(0.5 + coarse * 0.31 + fine * 0.17, 0, 1);
  const poolPosition = clamp((grain - 0.23) / 0.54, 0, 1);
  const pool = poolPosition * poolPosition * (3 - 2 * poolPosition);
  const dryness = clamp(entropy * 0.55 + (1 - confidence) * 0.24 + (1 - intensity) * 0.16 + (1.2 - pressure) * 0.2, 0, 1);
  const pigmentLoad = clamp(intensity * 0.52 + confidence * 0.2 + pressure * 0.18, 0.15, 1);
  const roughness = getBrushMaterialConfig(style).edgeRoughness * (0.25 + entropy * 0.5 + (1 - confidence) * 0.25);
  return {
    leftEdge: 1 - roughness * (0.5 + fine * 0.27 + coarse * 0.2),
    rightEdge: 1 - roughness * (0.5 - fine * 0.2 + Math.sin(t * 39 + phase) * 0.27),
    depositOffset: coarse * (0.09 + entropy * 0.22),
    // Pigment pools occupy up to most of the face, while their connecting
    // deposit stays slender. This makes actual wash patches, not a fixed stripe.
    depositWidth: 0.055 + Math.pow(pool, 1.35) * (0.85 + entropy * 0.45) + pigmentLoad * 0.15,
    grooveOffset: Math.sin(t * Math.PI * 9 + phase * 1.3) * (0.025 + dryness * 0.1),
    grooveWidth: 0.48 + dryness * 1.9 + (1 - grain) * 0.45,
    grooveBreakup: 0.12 + pool * 0.88,
    pigmentLoad,
    dryness,
    grain,
  };
}

interface VisibleMeteor {
  id: string;
  geometry: MeteorGeometry;
  from: number;
  to: number;
  zoom: number;
  x: number;
  y: number;
  retainTrace: boolean;
  opacity: number;
  trailRetention: number;
}

export interface BrushMaterialSample {
  /** Full physical ribbon width in CSS pixels, never more than twelve. */
  width: number;
  /** Continuous lateral nib displacement, as a fraction of its half width. */
  edgeBias: number;
  /** Length of the live nib's leading edge, in CSS pixels. */
  tipLength: number;
  fiberCount: number;
}

export interface CalligraphyBundle { low: number; high: number }

/**
 * Seven connected brush-hair bundles across one nib. Their moving boundaries
 * leave real unpainted longitudinal gaps. A central ink spine is never cut,
 * so these are surface fissures in one stroke, not seven separate trajectories.
 * Wet/high-pressure ink closes the gaps; a lifted, drying nib opens them.
 */
export function sampleCalligraphyBundles(texture: BrushTextureSample, progress: number, bodyWidth = 12): CalligraphyBundle[] {
  const t = clamp(progress, 0, 1);
  const settle = clamp((t - 0.28) / 0.46, 0, 1);
  // Subpixel hairs would look like disconnected specks. A lifted/narrow nib
  // closes its fissures and retains one legible continuous hairline instead.
  const readableSplits = clamp((bodyWidth - 2.4) / 3.6, 0, 1);
  const drying = clamp((0.15 + texture.dryness * 0.54 + t * 0.35 + (1 - texture.pigmentLoad) * 0.16)
    * settle * settle * (3 - 2 * settle) * readableSplits, 0, 0.92);
  const centers = [-0.84, -0.61, -0.3, 0.23, 0.51, 0.81];
  const bundles: CalligraphyBundle[] = [];
  let edge = -1;
  for (let i = 0; i < centers.length; i++) {
    // The coherent, slowly drifting splits have different lengths/widths,
    // unlike evenly spaced parallel vector stripes or scattered spray dots.
    const wave = Math.sin(t * (13 + i * 2.3) + texture.grain * 2.1 + i * 1.9);
    const center = centers[i] + wave * 0.028 + texture.grooveOffset * 0.13;
    const opening = clamp((settle - [0, 0.28, 0.05, 0.43, 0.17, 0.36][i]) * 1.8, 0, 1);
    const split = drying * opening * (0.065 + (i % 3) * 0.031) * (0.64 + (wave + 1) * 0.22);
    const low = clamp(center - split, edge, i < 3 ? -0.12 : 1);
    const high = clamp(center + split, i < 3 ? -1 : 0.12, 1);
    bundles.push({ low: edge, high: low });
    edge = high;
  }
  bundles.push({ low: edge, high: 1 });
  return bundles;
}

/** Prevent several pressure peaks from becoming round beads on a short mark. */
export function getBrushDisplayLimits(pathPixels: number, widthChanges: number, nominalTipLength: number) {
  const length = Math.max(0, pathPixels);
  const phasePixels = length / Math.max(1, widthChanges);
  return {
    maxWidth: widthChanges > 0 ? clamp(phasePixels * 0.48, 1.35, 12) : 12,
    minConnector: 0.72,
    tipLength: Math.min(nominalTipLength, Math.max(1.2, length * 0.14), Math.max(1.2, phasePixels * 0.72)),
  };
}

/** Real nib geometry. Opacity is deliberately not part of this mapping. */
export function sampleBrushMaterial(
  style: BrushStrokeStyle,
  pressure: number,
  progress: number,
  tangentAngle: number,
  widthRatio: number,
  scale = 1,
): BrushMaterialSample {
  const p = clamp(pressure, 0.1, 3.2);
  const t = clamp(progress, 0, 1);
  const mass = clamp(0.88 + widthRatio * 80, 0.9, 1.38) * clamp(scale, 0.75, 1.35);
  const belly = Math.pow(Math.max(0, Math.sin(Math.PI * t)), 0.6);
  if (style === "calligraphy") {
    // A loaded shoulder, pressure-driven belly and lifted finish. Unlike the
    // symmetric soft nib, its weight is carried early and narrows into a swash.
    const landing = clamp(t / 0.055, 0, 1);
    const lifting = clamp((1 - t) / 0.2, 0, 1);
    const unload = clamp((t - 0.24) / 0.48, 0, 1);
    const inkLoad = 0.48 * (1 - unload * unload * (3 - 2 * unload));
    const envelope = (0.42 + 0.58 * landing * landing * (3 - 2 * landing))
      * (0.045 + 0.955 * Math.pow(lifting, 0.76));
    const nibProjection = 0.76 + 0.24 * Math.abs(Math.sin(tangentAngle - 0.65));
    return {
      width: clamp(7.4 * mass * Math.pow(p + inkLoad, 1.45) * envelope * nibProjection, 0.28, 12),
      edgeBias: 0.1 * Math.sin(t * Math.PI * 1.6 + 0.4),
      tipLength: 19,
      fiberCount: 7,
    };
  }
  if (style === "hard") {
    // A fixed 35-degree chisel becomes broad or thin as travel changes direction.
    const nibProjection = 0.3 + 0.7 * Math.abs(Math.sin(tangentAngle - Math.PI * 35 / 180));
    return { width: clamp(4.4 * mass * Math.pow(p, 1.05) * nibProjection, 0.6, 6.4), edgeBias: 0, tipLength: 5, fiberCount: 0 };
  }
  if (style === "soft") {
    return { width: clamp(6.7 * mass * Math.pow(p, 1.25) * (0.09 + belly * 0.91), 0.35, 12), edgeBias: 0.09 * Math.sin(t * Math.PI * 3), tipLength: 16, fiberCount: 3 };
  }
  if (style === "watercolor") {
    return { width: clamp(7.2 * mass * Math.pow(p, 1.1) * (0.68 + belly * 0.32), 0.65, 12), edgeBias: 0.11 * Math.sin(t * Math.PI * 7 + p * 0.4), tipLength: 9, fiberCount: 0 };
  }
  return { width: clamp(6.5 * mass * Math.pow(p, 1.2) * (0.6 + belly * 0.4), 0.55, 11.8), edgeBias: 0.07 * Math.sin(t * Math.PI * 11), tipLength: 4.5, fiberCount: 5 };
}

export interface MeteorRenderOptions {
  /** Persistent exact contact outline while the animation/player is shown. */
  showNib?: boolean;
  /** A labeled enlarged view of the SAME contact; never baked into the art. */
  inspectNib?: boolean;
  /** Detail / edit views keep an inspectable trace of the travelled path. */
  retainTrace?: boolean;
  /** Animated trail retention fraction; live display-only preference, 0.2–0.8. */
  trailRetention?: number;
  /** Opacity of the entire meteor during its arrival / departure lifecycle. */
  opacityById?: ReadonlyMap<string, number>;
  /** Display-only layout camera for each path; persisted transforms are untouched. */
  viewById?: ReadonlyMap<string, CanvasTransformState>;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Interpolate the seeded pigments by travelled distance, not anchor index. */
function hueAt(hues: number[], progress: number): number {
  if (hues.length < 2) return hues[0] ?? 210;
  const position = clamp(progress, 0, 1) * (hues.length - 1);
  const index = Math.min(hues.length - 2, Math.floor(position));
  const delta = ((hues[index + 1] - hues[index] + 540) % 360) - 180;
  return (hues[index] + delta * (position - index) + 360) % 360;
}

/**
 * A deterministic swept nib. The playback layer supplies travelled distance;
 * the attribute-shaped head is swept continuously, never emitted as separate
 * particles. Replay and scrubbing produce the same exact footprint.
 */
export class MeteorRenderer {
  private context: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private cache = new Map<string, MeteorGeometry>();
  private pathsReference: TransitionPath[] | null = null;
  private ordered: TransitionPath[] = [];
  private agentsReference: Agent[] | null = null;
  private agentsById = new Map<string, Agent>();
  private visible: VisibleMeteor[] = [];
  private activeNib: readonly NibPoint[] = [];
  private lastFrameKey = "";
  private lastFramePaths: TransitionPath[] | null = null;
  private lastFrameAgents: Agent[] | null = null;
  private lastFrameControls: (readonly Point[])[] = [];
  private readonly raster: NibRasterCache;
  private readonly rasterEnabled: boolean;
  private rasterWorks = new Map<string, RasterWork>();
  private scratch: HTMLCanvasElement | null = null;
  private contactLens: HTMLCanvasElement | null = null;
  private rasterSerial = 0;
  private metrics = { frameMs: 0, tileBakes: 0, spriteDraws: 0, frameTileBakes: 0, frameSpriteDraws: 0 };

  constructor(private readonly canvas: HTMLCanvasElement, options: { createCanvas?: (width: number, height: number) => HTMLCanvasElement | null; disableRasterCache?: boolean } = {}) {
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Noema requires a Canvas 2D context for its meteor layer.");
    this.context = context;
    const owner = canvas.ownerDocument;
    this.rasterEnabled = !options.disableRasterCache && (!!options.createCanvas || !!owner?.createElement);
    this.raster = new NibRasterCache(options.createCanvas ?? ((width, height) => {
      if (!owner?.createElement) return null;
      const tile = owner.createElement("canvas"); tile.width = width; tile.height = height;
      return tile;
    }));
  }

  getRenderStats() { return { ...this.metrics, ...this.raster.stats }; }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const width = Math.max(1, cssWidth);
    const height = Math.max(1, cssHeight);
    const ratio = Math.max(1, dpr);
    if (this.width === width && this.height === height && this.dpr === ratio) return;
    this.width = width;
    this.height = height;
    this.dpr = ratio;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.cache.clear();
    this.raster.clear(); this.rasterWorks.clear();
    this.lastFrameKey = "";
  }

  private geometry(path: TransitionPath, store: MeteorStrokeSource): MeteorGeometry {
    const controls = store.controlPointsOf(path.id);
    const hue = (this.agentsById.get(path.agent_id)?.style.hue ?? 210) + (path.mood?.color_variation ?? 0) * 40;
    const cached = this.cache.get(path.id);
    if (cached?.controls === controls && cached.path === path && cached.hue === hue) return cached;
    const signature = resolveVisualSignature(path, hue);
    const config = getBrushMaterialConfig(signature.brush_style);
    const naturalPigment = signature.color_treatment === "muted" ? createNaturalPigment(path.id, signature.color_count) : null;
    const materialSeed = path.variation_seed ?? path.base_seed ?? hashStr(path.id);
    const { points, length } = sampleMeteorCenterline(controls, this.width, this.height, signature.turn_sharpness);
    const firstDx = (points[1]?.x ?? points[0]?.x ?? 0) - (points[0]?.x ?? 0);
    const firstDy = (points[1]?.y ?? points[0]?.y ?? 0) - (points[0]?.y ?? 0);
    const firstLength = Math.hypot(firstDx, firstDy);
    // Hold the actual polygon like a physical nib; changing travel direction
    // must not automatically spin it and round every corner into a tube.
    const nibBearing = firstLength > 1e-10
      ? { nx: -firstDy / firstLength, ny: firstDx / firstLength } : { nx: 0, ny: 1 };
    let travelled = 0;
    const samples: MeteorSample[] = points.map((point, index) => {
      const before = points[Math.max(0, index - 1)];
      const after = points[Math.min(points.length - 1, index + 1)];
      const dx = after.x - before.x;
      const dy = after.y - before.y;
      const distance = Math.max(0.0001, Math.hypot(dx, dy));
      if (index) travelled += Math.hypot(point.x - before.x, point.y - before.y);
      const progress = length > 0 ? clamp(travelled / length, 0, 1) : 0;
      const pigment = hueAt(signature.color_hues, progress);
      const pressure = signature.width_change_count === 0 ? 1 : sampleWidthProfile(signature.width_profile, progress);
      const sourcePosition = progress * Math.max(0, path.points.length - 1);
      const sourceIndex = Math.floor(sourcePosition);
      const sourceA = path.points[sourceIndex];
      const sourceB = path.points[Math.min(path.points.length - 1, sourceIndex + 1)] ?? sourceA;
      const local = sourcePosition - sourceIndex;
      const texture = sampleBrushTexture(signature.brush_style, {
        entropy: mix(sourceA?.entropy ?? 0.5, sourceB?.entropy ?? 0.5, local),
        confidence: mix(sourceA?.confidence ?? 0.5, sourceB?.confidence ?? 0.5, local),
        intensity: mix(sourceA?.intensity ?? 0.5, sourceB?.intensity ?? 0.5, local),
        pressure,
      }, progress, materialSeed);
      const pigmentVariation = (texture.grain - 0.5) * config.sedimentContrast;
      const faceLightness = config.bodyLightness + (1 - texture.pigmentLoad) * 7 + pigmentVariation;
      const paint = naturalPigment ? sampleNaturalPigment(naturalPigment, progress, texture, signature.brush_style) : {
        color: pigmentHsl(pigment, signature.brush_style === "calligraphy" ? 68 : 82, faceLightness),
        core: pigmentHsl(pigment, 61, config.highlightLightness + pigmentVariation * 0.4),
        rim: pigmentHsl(pigment, 88, config.rimLightness + pigmentVariation * 0.55),
        groove: pigmentHsl(pigment, 52, config.grooveLightness),
      };
      return {
        ...point,
        progress,
        nx: -dy / distance,
        ny: dx / distance,
        pressure,
        texture,
        ...paint,
      };
    });
    const nib = normalizeBrushHead(resolveBrushHeadProfile(path));
    const geometry = { controls, path, hue, samples, length, signature, nib, nibBearing };
    this.cache.set(path.id, geometry);
    return geometry;
  }

  draw(
    _time: number,
    paths: TransitionPath[],
    agents: Agent[],
    store: MeteorStrokeSource,
    focusId: string | null,
    filterAgentId: string | null,
    view: CanvasTransformState,
    progressById: ReadonlyMap<string, number>,
    options: MeteorRenderOptions = {},
  ): void {
    const frameStart = performance.now();
    this.metrics.frameTileBakes = 0; this.metrics.frameSpriteDraws = 0;
    const ctx = this.context;
    if (paths !== this.pathsReference) {
      this.pathsReference = paths;
      this.ordered = [...paths].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
      const retained = new Set(paths.map((path) => path.id));
      for (const id of this.cache.keys()) if (!retained.has(id)) this.cache.delete(id);
      for (const [id, work] of this.rasterWorks) if (!retained.has(id)) {
        this.raster.deletePrefix(work.key); this.rasterWorks.delete(id);
      }
    }
    if (agents !== this.agentsReference) {
      this.agentsReference = agents;
      this.agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    }
    ctx.globalCompositeOperation = "source-over";
    const trailRetention = clampTrailRetention(options.trailRetention ?? ANIMATED_TRAIL_RETENTION);
    // Static canvases and paused detail players retain their exact raster.
    // The sphere can rotate that atlas without rebuilding every brush polygon.
    // Include authored controls and every display input; no time-dependent
    // state is hidden from replay/scrub invalidation.
    const controls = this.ordered.map(path => store.controlPointsOf(path.id));
    const frameKey = [focusId, filterAgentId, options.retainTrace ?? false, trailRetention, options.showNib ?? false, options.inspectNib ?? false,
      ...this.ordered.flatMap(path => {
        const camera = options.viewById?.get(path.id) ?? view;
        return [path.id, progressById.get(path.id) ?? 1, options.opacityById?.get(path.id) ?? 1,
          camera.scale, camera.translateX, camera.translateY, store.transformOf(path.id).scale];
      })].join("|");
    if (frameKey === this.lastFrameKey && paths === this.lastFramePaths && agents === this.lastFrameAgents
      && controls.every((points, index) => points === this.lastFrameControls[index])) {
      this.metrics.frameMs = performance.now() - frameStart; return;
    }
    this.lastFrameKey = frameKey;
    this.lastFramePaths = paths;
    this.lastFrameAgents = agents;
    this.lastFrameControls = controls;
    this.visible.length = 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const path of this.ordered) {
      if (focusId && path.id !== focusId) continue;
      if (!focusId && filterAgentId && path.agent_id !== filterAgentId) continue;
      const progress = clamp(progressById.get(path.id) ?? 1, 0, 1);
      const opacity = clamp(options.opacityById?.get(path.id) ?? 1, 0, 1);
      if ((progress <= 0 && !options.showNib) || opacity <= 0) continue;
      const geometry = this.geometry(path, store);
      if (!geometry.samples.length) continue;
      const pathView = options.viewById?.get(path.id) ?? view;
      const zoom = Math.max(0.0001, pathView.scale);
      const x = pathView.translateX * this.width;
      const y = pathView.translateY * this.height;
      ctx.setTransform(this.dpr * zoom, 0, 0, this.dpr * zoom, x * this.dpr, y * this.dpr);
      const retainTrace = options.retainTrace ?? false;
      this.activeNib = geometry.nib;
      const transformScale = store.transformOf(path.id).scale;
      let start = retainTrace ? 0 : animatedTrailStart(progress, trailRetention);
      const work = this.rasterEnabled ? this.rasterWork(geometry, zoom, transformScale, retainTrace) : null;
      if (progress > 0) {
        if (work) this.drawRasterWork(work, progress, opacity, trailRetention);
        else start = this.drawMeteor(geometry, progress, zoom, transformScale, retainTrace, opacity, trailRetention);
      }
      if (options.showNib) {
        const node = work ? this.nodeAt(work.nodes, progress) : this.contactNode(geometry, progress, zoom, transformScale, retainTrace);
        if (progress === 0) this.paintContact(node, geometry, zoom, opacity, retainTrace);
        this.drawContact(node, geometry.nib, zoom, opacity, !!options.inspectNib, { x, y });
      }
      if (opacity >= 0.08) this.visible.push({ id: path.id, geometry, from: start, to: progress, zoom, x, y, retainTrace, opacity, trailRetention });
    }
    ctx.globalAlpha = 1;
    this.metrics.frameMs = performance.now() - frameStart;
  }

  private drawMeteor(geometry: MeteorGeometry, progress: number, zoom: number, transformScale: number, retainTrace: boolean, opacity: number, trailRetention: number, capture?: NodeCapture): number {
    const { samples, signature } = geometry;
    this.activeNib = geometry.nib;
    const style = signature.brush_style;
    const segmentCount = samples.length - 1;
    const pathPixels = geometry.length * zoom;
    const tailStyle = style === "hard" ? 0.82 : style === "texture" ? 0.93 : style === "watercolor" ? 1.2 : 1.1;
    const tailPixels = clamp(Math.min(this.width, this.height) * 0.24, 85, 185) * tailStyle;
    const tailSpan = Math.min(1, tailPixels / Math.max(1, pathPixels));
    const from = retainTrace ? 0 : animatedTrailStart(progress, trailRetention);
    const scale = clamp(Math.sqrt(Math.max(0.01, transformScale) * zoom), 0.8, 1.16) * ((capture?.retainTrace ?? retainTrace) ? 1.12 : 0.94);

    if (segmentCount === 0 || pathPixels < 0.01) {
      if (capture) { capture.nodes = []; return from; }
      // A zero-length gesture is an impression of this same nib, not a
      // generic diamond. Keep the previous compact 1.4 CSS-pixel size budget.
      const point = samples[0];
      const ctx = this.context;
      ctx.globalAlpha = opacity;
      ctx.fillStyle = point.color;
      ctx.beginPath();
      appendBrushHeadSweep(ctx, buildBrushHeadSweep([{ ...point, ...geometry.nibBearing, width: 1.4 }], this.activeNib, zoom));
      ctx.fill();
      return from;
    }

    const start = from;
    const end = progress;
    const positions = [start];
    for (const sample of samples) if (sample.progress > start && sample.progress < end) positions.push(sample.progress);
    // Sample the final nib independently of centreline density, so even a long
    // trajectory has a real tapered/chisel end instead of one oversized quad.
    const nominalTip = sampleBrushMaterial(style, 1, progress, 0, signature.width_ratio, scale).tipLength;
    const displayLimits = getBrushDisplayLimits(pathPixels, signature.width_change_count, nominalTip);
    const tipLength = displayLimits.tipLength;
    for (let i = 4; i >= 1; i--) {
      const position = end - (tipLength * i / 4) / pathPixels;
      if (position > start && position < end) positions.push(position);
    }
    positions.push(end);
    positions.sort((a, b) => a - b);

    const nodes: RibbonNode[] = [];
    let lastPosition = -1;
    let sampleCursor = 1;
    for (const position of positions) {
      if (position - lastPosition < 1e-12) continue;
      lastPosition = position;
      while (sampleCursor < segmentCount && samples[sampleCursor].progress < position) sampleCursor++;
      const index = sampleCursor - 1;
      const a = samples[index];
      const b = samples[index + 1];
      const f = clamp((position - a.progress) / Math.max(1e-12, b.progress - a.progress), 0, 1);
      const t = position;
      let nx = mix(a.nx, b.nx, f);
      let ny = mix(a.ny, b.ny, f);
      const normalLength = Math.hypot(nx, ny);
      if (normalLength > 0.001) {
        nx /= normalLength;
        ny /= normalLength;
      } else {
        const span = Math.max(0.0001, Math.hypot(b.x - a.x, b.y - a.y));
        nx = -(b.y - a.y) / span;
        ny = (b.x - a.x) / span;
      }
      const pressure = mix(a.pressure, b.pressure, f);
      const material = sampleBrushMaterial(style, pressure, t, Math.atan2(-nx, ny), signature.width_ratio, scale);
      const texture: BrushTextureSample = {
        leftEdge: mix(a.texture.leftEdge, b.texture.leftEdge, f),
        rightEdge: mix(a.texture.rightEdge, b.texture.rightEdge, f),
        depositOffset: mix(a.texture.depositOffset, b.texture.depositOffset, f),
        depositWidth: mix(a.texture.depositWidth, b.texture.depositWidth, f),
        grooveOffset: mix(a.texture.grooveOffset, b.texture.grooveOffset, f),
        grooveWidth: mix(a.texture.grooveWidth, b.texture.grooveWidth, f),
        grooveBreakup: mix(a.texture.grooveBreakup, b.texture.grooveBreakup, f),
        pigmentLoad: mix(a.texture.pigmentLoad, b.texture.pigmentLoad, f),
        dryness: mix(a.texture.dryness, b.texture.dryness, f),
        grain: mix(a.texture.grain, b.texture.grain, f),
      };
      const tail = retainTrace
        ? Math.pow(clamp(1 - (progress - t) / tailSpan, 0, 1), 1.2)
        : animatedTrailOpacity(progress, t, trailRetention);
      const tailWidth = retainTrace ? 1 : 0.22 + Math.pow(tail, 0.6) * 0.78;
      const edgeCoverage = (texture.leftEdge + texture.rightEdge) * 0.5;
      const minimumWidth = Math.min(displayLimits.maxWidth, displayLimits.minConnector / Math.max(0.4, edgeCoverage));
      const connectedWidth = clamp(material.width, minimumWidth, displayLimits.maxWidth);
      // The authored pressure envelope, size limits and fading tail are
      // unchanged. The former moving pointed/chisel taper was the OLD nib;
      // replacing it is essential or every new head would collapse to a point.
      const width = connectedWidth * tailWidth;
      nodes.push({
        x: mix(a.x, b.x, f),
        y: mix(a.y, b.y, f),
        nx, ny,
        nibNx: geometry.nibBearing.nx, nibNy: geometry.nibBearing.ny,
        width,
        texture,
        progress: t,
        bias: material.edgeBias,
        cutback: 0,
        // Completed comparison/detail frames keep pigment readable instead of
        // fading the very surface detail the viewer is trying to inspect.
        energy: opacity * (retainTrace ? style === "calligraphy" ? 1 : 0.82 + tail * 0.18 : tail),
        sample: f < 0.5 ? a : b,
      });
    }

    if (capture) {
      capture.nodes = nodes.map(node => ({ ...node, energy: 1 }));
      return from;
    }
    this.paintMaterials(nodes, signature, zoom, retainTrace);
    return from;
  }

  private paintMaterials(nodes: RibbonNode[], signature: StrokeVisualSignature, zoom: number, retainTrace: boolean): void {
    const style = signature.brush_style;
    // The shared halo is deliberately weaker than the pigment surface. Each
    // instrument has its own internal deposit/edge structure inside one ribbon.
    const halo = style === "hard" ? 1.35 : style === "watercolor" ? 1.25 : 1.35;
    if (style !== "calligraphy") this.drawBand(nodes, -halo, halo, retainTrace ? 0.018 : 0.035, "color", zoom);
    if (style === "calligraphy") {
      this.drawCalligraphy(nodes, zoom, retainTrace && signature.color_count === 1);
    } else if (style === "hard") {
      // A solid, cleanly cut face with a narrow bevel, not a luminous tube.
      this.drawBand(nodes, -1, 1, 1, "color", zoom);
      this.drawBand(nodes, 0.62, 1, 0.76, "rim", zoom);
      this.drawBand(nodes, -0.85, -0.68, 0.9, "core", zoom);
    } else if (style === "soft") {
      this.drawBand(nodes, -1, 1, 1, "color", zoom);
      // Pressure lays down an uneven ink belly and a compressed outer edge.
      this.drawBand(nodes, (n) => -0.6 + n.texture.depositOffset, (n) => 0.25 + n.texture.depositOffset + n.texture.depositWidth * 0.25, 0.88, "rim", zoom);
      this.drawBand(nodes, (n) => 0.62 + n.texture.grain * 0.16, 1, 0.96, "rim", zoom);
      this.drawFibers(nodes, zoom, 3, "soft");
    } else if (style === "watercolor") {
      this.drawBand(nodes, -1, 1, 0.7, "color", zoom);
      // Diluted wash and pigment sediment have different, continuously drifting
      // boundaries. Seeded granulation changes their geometry and color density.
      this.drawBand(nodes, (n) => -0.62 + n.texture.depositOffset, (n) => 0.52 + n.texture.depositOffset * 0.5, 0.54, "core", zoom);
      this.drawBand(nodes, (n) => n.texture.depositOffset - n.texture.depositWidth * 0.5, (n) => n.texture.depositOffset + n.texture.depositWidth * 0.5, 0.97, "rim", zoom);
      this.drawBand(nodes, -1, (n) => -0.86 + n.texture.grain * 0.3, 1, "rim", zoom);
      this.drawBand(nodes, (n) => 0.58 + n.texture.grain * 0.28, 1, 1, "rim", zoom);
      this.drawBand(nodes, (n) => -0.75 + n.texture.depositOffset * 0.4, (n) => -0.48 + n.texture.depositOffset * 0.4 + n.texture.depositWidth * 0.22, 0.74, "groove", zoom);
    } else {
      this.drawBand(nodes, -1, 1, 1, "color", zoom);
      this.drawBand(nodes, (n) => -0.4 + n.texture.depositOffset, (n) => 0.4 + n.texture.depositOffset, 0.32, "rim", zoom);
      this.drawFibers(nodes, zoom, 5, "texture");
    }
  }

  private rasterWork(geometry: MeteorGeometry, zoom: number, transformScale: number, retainTrace: boolean): RasterWork | null {
    if (geometry.samples.length < 2 || geometry.length * zoom < 0.01) return null;
    const recipe = `${zoom}:${transformScale}:${this.dpr}:${retainTrace}`;
    const prior = this.rasterWorks.get(geometry.path.id);
    if (prior?.geometry === geometry && prior.key.endsWith(`:${recipe}/`)) return prior;
    if (prior) this.raster.deletePrefix(prior.key);
    const capture: NodeCapture = { nodes: [], retainTrace };
    this.drawMeteor(geometry, 1, zoom, transformScale, true, 1, 0.2, capture);
    const nodes = capture.nodes;
    if (nodes.length < 2) return null;
    const key = `${++this.rasterSerial}:${geometry.path.id}:${recipe}/`;
    const resolution = zoom * this.dpr;
    const tiles = splitNibTiles(nodes, zoom).map((part, index) => {
      const contacts = nodes.slice(Math.max(0, part.start - 2), part.end + 1)
        .flatMap(node => placeBrushHead(geometry.nib, this.nibPose(node), zoom));
      const pad = 3 / zoom;
      const x = Math.floor((Math.min(...contacts.map(p => p.x)) - pad) * resolution) / resolution;
      const y = Math.floor((Math.min(...contacts.map(p => p.y)) - pad) * resolution) / resolution;
      const right = Math.ceil((Math.max(...contacts.map(p => p.x)) + pad) * resolution) / resolution;
      const bottom = Math.ceil((Math.max(...contacts.map(p => p.y)) + pad) * resolution) / resolution;
      return { ...part, key: `${key}${index}`, x, y, width: right - x, height: bottom - y };
    });
    const work = { geometry, key, nodes, tiles, zoom, retainTrace };
    this.rasterWorks.set(geometry.path.id, work);
    return work;
  }

  private tileSurface(work: RasterWork, tile: RasterTile): HTMLCanvasElement | null {
    const cached = this.raster.get(tile.key);
    if (cached) return cached;
    const resolution = work.zoom * this.dpr;
    const canvas = this.raster.make(Math.ceil(tile.width * resolution), Math.ceil(tile.height * resolution));
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return null;
    const previous = this.context;
    this.context = context;
    try {
      context.setTransform(resolution, 0, 0, resolution, -tile.x * resolution, -tile.y * resolution);
      // A half-device-pixel bleed closes antialias seams between adjacent
      // bitmaps. It only reveals already swept ink, never future contacts.
      const bleed = 0.6 / resolution;
      if (tile.start > 0) this.clipNibSpan(work.nodes[tile.start], true, bleed);
      if (tile.end < work.nodes.length - 1) this.clipNibSpan(work.nodes[tile.end], false, bleed);
      this.paintMaterials(work.nodes.slice(Math.max(0, tile.start - 2), tile.end + 1), work.geometry.signature, work.zoom, work.retainTrace);
    } finally { this.context = previous; }
    this.raster.put(tile.key, canvas);
    this.metrics.tileBakes++; this.metrics.frameTileBakes++;
    return canvas;
  }

  private nodeAt(nodes: RibbonNode[], progress: number): RibbonNode {
    const t = clamp(progress, 0, 1);
    let index = 1;
    while (index < nodes.length - 1 && nodes[index].progress < t) index++;
    const a = nodes[index - 1] ?? nodes[0], b = nodes[index] ?? a;
    const f = clamp((t - a.progress) / Math.max(1e-10, b.progress - a.progress), 0, 1);
    // Interpolate the PHYSICAL contact, exactly as the swept material does.
    // Interpolating raw width then applying an old texture edge could make the
    // displayed head 50% wider; normalized-vector lerp also misrotated turns.
    const pose = interpolateBrushHeadPose(this.nibPose(a), this.nibPose(b), f);
    const travel = interpolateBrushHeadPose({ ...a, width: a.width }, { ...b, width: b.width }, f);
    const texture = Object.fromEntries(Object.keys(a.texture).map(key => [key,
      mix(a.texture[key as keyof BrushTextureSample], b.texture[key as keyof BrushTextureSample], f),
    ])) as unknown as BrushTextureSample;
    const coverage = Math.max(1e-10, (texture.leftEdge + texture.rightEdge) * 0.5);
    return { ...a, x: pose.x, y: pose.y, nx: travel.nx, ny: travel.ny, nibNx: pose.nx, nibNy: pose.ny,
      width: pose.width / coverage, texture, progress: t, sample: f < 0.5 ? a.sample : b.sample };
  }

  private contactNode(geometry: MeteorGeometry, progress: number, zoom: number, transformScale: number, retainTrace: boolean): RibbonNode {
    const capture: NodeCapture = { nodes: [], retainTrace };
    this.drawMeteor(geometry, 1, zoom, transformScale, true, 1, 0.2, capture);
    if (capture.nodes.length) return this.nodeAt(capture.nodes, progress);
    const sample = geometry.samples[0];
    const coverage = Math.max(1e-10, (sample.texture.leftEdge + sample.texture.rightEdge) * 0.5);
    return { ...sample, nx: 0, ny: 1, nibNx: geometry.nibBearing.nx, nibNy: geometry.nibBearing.ny,
      width: 1.4 / coverage, bias: 0, cutback: 0, energy: 1, sample, progress: 0 };
  }

  private drawRasterWork(work: RasterWork, progress: number, opacity: number, retention: number): void {
    const ctx = this.context;
    const from = work.retainTrace ? 0 : animatedTrailStart(progress, retention);
    const head = this.nodeAt(work.nodes, progress), rear = this.nodeAt(work.nodes, from);
    const pathPixels = work.geometry.length * work.zoom;
    const style = work.geometry.signature.brush_style;
    const tailStyle = style === "hard" ? 0.82 : style === "texture" ? 0.93 : style === "watercolor" ? 1.2 : 1.1;
    const tailSpan = Math.min(1, clamp(Math.min(this.width, this.height) * 0.24, 85, 185) * tailStyle / Math.max(1, pathPixels));
    const energy = (position: number) => opacity * (work.retainTrace
      ? style === "calligraphy" ? 1 : 0.82 + 0.18 * Math.pow(clamp(1 - (progress - position) / tailSpan, 0, 1), 1.2)
      : animatedTrailOpacity(progress, position, retention));
    for (const tile of work.tiles) {
      const a = work.nodes[tile.start], b = work.nodes[tile.end];
      if (a.progress >= progress || b.progress < from) continue;
      if (progress < 1 && progress <= b.progress) {
        // Only the short advancing tile is swept live. Never reveal a clipped
        // FUTURE footprint (especially when a wider nib is about to turn).
        // Its final pose is the same object used for the visible head outline.
        const prefix = work.nodes.slice(Math.max(0, tile.start - 2), tile.end + 1)
          .filter(node => node.progress < progress).map(node => ({ ...node, energy: energy(node.progress) }));
        prefix.push({ ...head, energy: energy(progress) });
        ctx.save();
        if (tile.start > 0) this.clipNibSpan(a, true);
        if (from > a.progress) this.clipNibSpan(rear, true);
        this.paintMaterials(prefix, work.geometry.signature, work.zoom, work.retainTrace);
        ctx.restore();
        continue;
      }
      const source = this.tileSurface(work, tile);
      if (!source) {
        // A browser can refuse a bitmap under memory pressure or at extreme
        // zoom. Keep the ink complete with a scoped vector fallback, rather
        // than silently dropping this section of the artwork.
        ctx.save();
        if (tile.start > 0) this.clipNibSpan(a, true);
        if (tile.end < work.nodes.length - 1) this.clipNibSpan(b, false);
        if (progress < b.progress) this.clipNibSpan(head, false);
        if (from > a.progress) this.clipNibSpan(rear, true);
        const visibleNodes = work.nodes.slice(Math.max(0, tile.start - 2), tile.end + 1)
          .map(node => ({ ...node, energy: energy(node.progress) }));
        this.paintMaterials(visibleNodes, work.geometry.signature, work.zoom, work.retainTrace);
        ctx.restore();
        continue;
      }
      ctx.save();
      if (progress < b.progress) this.clipNibSpan(head, false);
      if (from > a.progress) this.clipNibSpan(rear, true);
      const low = energy(Math.max(from, a.progress)), high = energy(Math.min(progress, b.progress));
      let image: HTMLCanvasElement = source;
      if (Math.abs(high - low) > 0.01) {
        if (!this.scratch) this.scratch = this.raster.make(source.width, source.height);
        if (this.scratch) {
          this.scratch.width = source.width; this.scratch.height = source.height;
          const mask = this.scratch.getContext("2d")!;
          mask.drawImage(source, 0, 0);
          mask.globalCompositeOperation = "destination-in";
          const r = work.zoom * this.dpr;
          const gradient = mask.createLinearGradient((a.x - tile.x) * r, (a.y - tile.y) * r, (b.x - tile.x) * r + 1e-5, (b.y - tile.y) * r);
          for (let step = 0; step <= 8; step++) gradient.addColorStop(step / 8, `rgba(0,0,0,${energy(mix(a.progress, b.progress, step / 8))})`);
          mask.fillStyle = gradient; mask.fillRect(0, 0, source.width, source.height);
          mask.globalCompositeOperation = "source-over";
          image = this.scratch; ctx.globalAlpha = 1;
        } else ctx.globalAlpha = (low + high) * 0.5;
      } else ctx.globalAlpha = (low + high) * 0.5;
      ctx.drawImage(image, tile.x, tile.y, tile.width, tile.height);
      this.metrics.spriteDraws++; this.metrics.frameSpriteDraws++;
      ctx.restore();
    }
  }

  private contactPath(node: RibbonNode, vertices: readonly NibPoint[], zoom: number, width = this.nibPose(node).width): NibPoint[] {
    return placeBrushHead(vertices, { ...this.nibPose(node), width }, zoom);
  }

  private polygon(points: readonly NibPoint[]): void {
    const ctx = this.context;
    ctx.beginPath(); if (!points.length) return;
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
  }

  private paintContact(node: RibbonNode, geometry: MeteorGeometry, zoom: number, opacity: number, retainTrace: boolean): void {
    const ctx = this.context;
    const contact = { ...node, energy: opacity };
    ctx.save();
    // A stationary impression uses the SAME material as the dragged body.
    // Do not cover watercolor or dry-bristle gaps with a solid fake cap.
    this.paintMaterials([contact, contact], geometry.signature, zoom, retainTrace);
    ctx.restore();
  }

  private drawContact(node: RibbonNode, vertices: readonly NibPoint[], zoom: number, opacity: number, inspect: boolean, camera: Point): void {
    const ctx = this.context;
    ctx.save();
    const width = this.nibPose(node).width;
    // No decorative offset, introductory scale or independent rotation. This
    // is the exact footprint used by the just-painted terminal sweep.
    const contact = this.contactPath(node, vertices, zoom);
    ctx.strokeStyle = "#dcf7f1";
    ctx.lineWidth = 0.8 / zoom;
    ctx.globalAlpha = opacity * 0.85;
    this.polygon(contact); ctx.stroke();
    ctx.restore();
    if (!inspect) return;
    // The inspector is a magnified copy of the current nib contact, NOT a
    // second stroke or an enlarged paint footprint. Keep it in screen space.
    const magnification = clamp(46 / Math.max(0.4, width), 3, 28);
    // Capture the actual freshly drawn ink BEFORE laying down the lens panel.
    // The magnified trailing section visibly joins the exact contact polygon.
    if (!this.contactLens && this.rasterEnabled) this.contactLens = this.raster.make(Math.ceil(140 * this.dpr), Math.ceil(88 * this.dpr));
    const lensContext = this.contactLens?.getContext("2d");
    if (this.contactLens && lensContext) {
      lensContext.setTransform(1, 0, 0, 1, 0, 0);
      lensContext.clearRect(0, 0, this.contactLens.width, this.contactLens.height);
      lensContext.drawImage(this.canvas,
        (node.x * zoom + camera.x - 70 / magnification) * this.dpr,
        (node.y * zoom + camera.y - 44 / magnification) * this.dpr,
        140 * this.dpr / magnification, 88 * this.dpr / magnification,
        0, 0, this.contactLens.width, this.contactLens.height);
    }
    ctx.save(); ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const size = 140, left = Math.max(10, this.width - size - 14), top = 14;
    ctx.globalAlpha = 0.94; ctx.fillStyle = "#0b1218"; ctx.fillRect(left, top, size, 132);
    ctx.strokeStyle = "#48616a"; ctx.lineWidth = 1; ctx.strokeRect(left + 0.5, top + 0.5, size - 1, 131);
    ctx.globalAlpha = 1; ctx.fillStyle = "#d8ebe8"; ctx.font = "14px system-ui";
    ctx.fillText("BRUSH CONTACT", left + 10, top + 19);
    if (this.contactLens) ctx.drawImage(this.contactLens, left, top + 28, 140, 88);
    const pose = { ...this.nibPose(node), x: left + size / 2, y: top + 72, width: width * magnification };
    const enlarged = placeBrushHead(vertices, pose);
    // Outline the magnified REAL ink; never paint an independent flat proxy.
    this.polygon(enlarged);
    ctx.strokeStyle = "#d8f4ee"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = "#a9c5c0"; ctx.font = "14px system-ui";
    ctx.fillText("Contact · magnified", left + 8, top + 117);
    ctx.restore();
  }

  private drawCalligraphy(nodes: RibbonNode[], zoom: number, singlePigment: boolean): void {
    const sections = new Map(nodes.map((node) => [node, sampleCalligraphyBundles(node.texture, node.progress, node.width)]));
    // Clip the existing seven ink bundles THROUGH the actual head. All fans
    // share one compound fill, so touching wet hairs cannot brighten seams.
    this.paintNibBands(nodes, Array.from({ length: 7 }, (_, bundle) => ({
      low: (node: RibbonNode) => sections.get(node)![bundle].low,
      high: (node: RibbonNode) => sections.get(node)![bundle].high,
    })), 1, "color", zoom, singlePigment);
  }

  private nibPose(node: RibbonNode, low = -1, high = 1): BrushHeadPose {
    const expansion = Math.max(1, Math.abs(low), Math.abs(high));
    return { x: node.x, y: node.y, nx: node.nibNx ?? node.nx, ny: node.nibNy ?? node.ny,
      // Match the former ribbon's effective cross-width, not the circumcircle
      // of the radar polygon (which would make asymmetric heads much thinner).
      width: node.width * (node.texture.leftEdge + node.texture.rightEdge) * 0.5 * expansion,
      low: low / expansion, high: high / expansion };
  }

  /** A shared boundary assigns adjacent pigment spans without over-stamping. */
  private clipNibSpan(node: RibbonNode, forward: boolean, bleed = 0): void {
    const ctx = this.context;
    const reach = (Math.max(this.width, this.height) + Math.abs(node.x) + Math.abs(node.y) + 100) * 8;
    const direction = forward ? 1 : -1;
    const tx = node.ny * direction * reach, ty = -node.nx * direction * reach;
    const x = node.x - node.ny * direction * bleed, y = node.y + node.nx * direction * bleed;
    const ax = x + node.nx * reach, ay = y + node.ny * reach;
    const bx = x - node.nx * reach, by = y - node.ny * reach;
    ctx.beginPath();
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    ctx.lineTo(bx + tx, by + ty); ctx.lineTo(ax + tx, ay + ty);
    ctx.closePath(); ctx.clip();
  }

  private paintNibBands(nodes: RibbonNode[], bands: { low: number | ((node: RibbonNode) => number); high: number | ((node: RibbonNode) => number) }[], strength: number, pigment: "color" | "core" | "rim" | "groove", zoom: number, singlePigment = false): void {
    if (nodes.length < 2) return;
    const ctx = this.context;
    // Sweep each material exactly once. Palette spans reuse its pieces instead
    // of repeatedly rebuilding overlapping shoulder/edge neighbourhoods.
    const surfaces = bands.map(band => {
      const poses = nodes.map(node => this.nibPose(node,
        typeof band.low === "number" ? band.low : clamp(band.low(node), -1, 1),
        typeof band.high === "number" ? band.high : clamp(band.high(node), -1, 1)));
      const compact = simplifyBrushHeadPoses(poses, this.activeNib, zoom);
      const compactRanges: { start: number; end: number }[] = [];
      const polygons = buildBrushHeadSweep(compact.poses, this.activeNib, zoom, compactRanges);
      let cursor = 0;
      const ranges = nodes.map((_, index) => {
        while (cursor < compact.indices.length - 1 && compact.indices[cursor] < index) cursor++;
        return compactRanges[cursor];
      });
      return { polygons, ranges };
    });
    const chunkSize = singlePigment ? nodes.length - 1 : 16;
    for (let start = 0; start < nodes.length - 1;) {
      let end = Math.min(nodes.length - 1, start + chunkSize);
      if (!singlePigment) while (end > start + 1) {
        let arc = 0;
        for (let i = start + 1; i <= end; i++) arc += Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].y - nodes[i - 1].y);
        if (Math.hypot(nodes[end].x - nodes[start].x, nodes[end].y - nodes[start].y) >= arc * 0.9) break;
        end = start + Math.max(1, Math.floor((end - start) / 2));
      }
      const a = nodes[start], b = nodes[end];
      ctx.save();
      if (start > 0) this.clipNibSpan(a, true);
      if (end < nodes.length - 1) this.clipNibSpan(b, false);
      if (singlePigment) {
        ctx.fillStyle = nodes[Math.floor(nodes.length / 2)].sample[pigment];
        ctx.globalAlpha = a.energy * strength;
      } else {
        const gradient = ctx.createLinearGradient(a.x, a.y, b.x + 0.00001, b.y);
        for (let i = start; i <= end; i++) {
          const node = nodes[i];
          gradient.addColorStop(clamp((node.progress - a.progress) / Math.max(0.0000001, b.progress - a.progress), 0, 1),
            node.sample[pigment].replace(")", ` / ${clamp(node.energy, 0, 1).toFixed(4)})`));
        }
        ctx.globalAlpha = strength;
        ctx.fillStyle = gradient;
      }
      // Include nearby footprints on either side of the ownership boundary.
      // Their geometry must agree at the join; only the pigment span is cut.
      let first = start, last = end;
      const padding = 14 / zoom;
      while (first > 0 && start - first < 24 && Math.hypot(nodes[first].x - a.x, nodes[first].y - a.y) < padding) first--;
      while (last < nodes.length - 1 && last - end < 24 && Math.hypot(nodes[last].x - b.x, nodes[last].y - b.y) < padding) last++;
      ctx.beginPath();
      for (const surface of surfaces) {
        appendBrushHeadSweep(ctx, surface.polygons.slice(surface.ranges[first].start, surface.ranges[last].end));
      }
      // One nonzero union fill per layer/span: overlapping nib impressions do
      // not accumulate opacity. No per-stamp alpha or particle gaps are used.
      ctx.fill();
      ctx.restore();
      start = end;
    }
  }

  private ribbonVertex(node: RibbonNode, fraction: number, zoom: number, move = false): void {
    const radius = node.width / (2 * zoom);
    // A chisel's leading face is oblique, entirely behind the travelled head.
    const back = node.cutback * (1 - fraction) * 0.5 / zoom;
    const edge = fraction < 0 ? node.texture.leftEdge : node.texture.rightEdge;
    const offset = (fraction * edge + node.bias) * radius;
    const x = node.x + node.nx * offset - node.ny * back;
    const y = node.y + node.ny * offset + node.nx * back;
    if (move) this.context.moveTo(x, y);
    else this.context.lineTo(x, y);
  }

  private drawBand(nodes: RibbonNode[], low: number | ((node: RibbonNode) => number), high: number | ((node: RibbonNode) => number), strength: number, pigment: "color" | "core" | "rim" | "groove", zoom: number): void {
    this.paintNibBands(nodes, [{ low, high }], strength, pigment, zoom);
  }

  private drawFibers(nodes: RibbonNode[], zoom: number, count: number, material: "soft" | "texture"): void {
    if (nodes.length < 2) return;
    const ctx = this.context;
    ctx.save();
    // This explicit silhouette clip means a bristle can never become a branch.
    ctx.beginPath();
    const contact = simplifyBrushHeadPoses(nodes.map(node => this.nibPose(node)), this.activeNib, zoom);
    appendBrushHeadSweep(ctx, buildBrushHeadSweep(contact.poses, this.activeNib, zoom));
    ctx.clip();
    ctx.lineCap = "butt";
    for (let fiber = 0; fiber < count; fiber++) {
      const offset = material === "soft" ? [-0.72, -0.43, 0.57][fiber] : -0.76 + fiber * 1.52 / (count - 1);
      for (let i = 1; i < nodes.length; i++) {
        const a = nodes[i - 1];
        const b = nodes[i];
        const grooveWidth = (a.texture.grooveWidth + b.texture.grooveWidth) * 0.5;
        const dark = material === "soft" ? fiber < 2 : fiber % 2 === 0;
        const breakup = material === "texture" ? (a.texture.grooveBreakup + b.texture.grooveBreakup) * 0.5 : 1;
        const desiredWidth = grooveWidth * (material === "soft" ? 0.72 : dark ? 1.65 : 0.78) * breakup;
        // Deep channels are bold on a pressed belly, but never consume the
        // whole lifted nib. A continuous pigment substrate always remains.
        const bodyWidth = (a.width + b.width) * 0.5;
        const maxChannel = bodyWidth * (material === "soft" ? 0.16 : dark ? 0.21 : 0.11);
        ctx.lineWidth = Math.min(clamp(desiredWidth, 0.14, material === "soft" ? 1.35 : 2.45), Math.max(0.035, maxChannel)) / zoom;
        ctx.strokeStyle = dark ? a.sample.groove : material === "texture" ? a.sample.rim : a.sample.core;
        ctx.globalAlpha = clamp((a.energy + b.energy) * 0.5 * (material === "soft" ? 0.88 : 1), 0, 1);
        ctx.beginPath();
        this.ribbonVertex(a, offset + a.texture.grooveOffset, zoom, true);
        this.ribbonVertex(b, offset + b.texture.grooveOffset, zoom);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Hit the same corner-preserving centreline and arc progress as the ink. */
  hitTest(cssX: number, cssY: number, tolerance = 12): string | null {
    let nearest: string | null = null;
    let nearestDistance = Math.max(0, tolerance) ** 2;
    for (let v = this.visible.length - 1; v >= 0; v--) {
      const visible = this.visible[v];
      const samples = visible.geometry.samples;
      const segments = samples.length - 1;
      const from = visible.from;
      const to = visible.to;
      if (segments === 0) {
        const dx = cssX - (samples[0].x * visible.zoom + visible.x);
        const dy = cssY - (samples[0].y * visible.zoom + visible.y);
        const distance = dx * dx + dy * dy;
        if (distance <= nearestDistance) { nearestDistance = distance; nearest = visible.id; }
        continue;
      }
      for (let i = 0; i < segments; i++) {
        const a = samples[i];
        const b = samples[i + 1];
        if (b.progress < from) continue;
        if (a.progress > to) break;
        const interval = Math.max(1e-12, b.progress - a.progress);
        const f0 = clamp((from - a.progress) / interval, 0, 1);
        const f1 = clamp((to - a.progress) / interval, 0, 1);
        if (f1 <= f0) continue;
        const ax = mix(a.x, b.x, f0) * visible.zoom + visible.x;
        const ay = mix(a.y, b.y, f0) * visible.zoom + visible.y;
        const bx = mix(a.x, b.x, f1) * visible.zoom + visible.x;
        const by = mix(a.y, b.y, f1) * visible.zoom + visible.y;
        const dx = bx - ax;
        const dy = by - ay;
        const u = clamp(((cssX - ax) * dx + (cssY - ay) * dy) / Math.max(0.000001, dx * dx + dy * dy), 0, 1);
        const position = mix(a.progress, b.progress, mix(f0, f1, u));
        if (!visible.retainTrace && animatedTrailOpacity(visible.to, position, visible.trailRetention) * visible.opacity < 0.08) continue;
        const distance = (cssX - ax - u * dx) ** 2 + (cssY - ay - u * dy) ** 2;
        if (distance < nearestDistance) { nearestDistance = distance; nearest = visible.id; }
      }
    }
    return nearest;
  }

  dispose(): void {
    this.cache.clear();
    this.ordered = [];
    this.agentsById.clear();
    this.visible.length = 0;
    this.lastFrameKey = "";
    this.lastFramePaths = null;
    this.lastFrameAgents = null;
    this.lastFrameControls = [];
    this.raster.clear(); this.rasterWorks.clear();
    if (this.scratch) { this.scratch.width = 0; this.scratch.height = 0; this.scratch = null; }
    if (this.contactLens) { this.contactLens.width = 0; this.contactLens.height = 0; this.contactLens = null; }
  }
}
