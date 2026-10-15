import type { Agent, BrushStrokeStyle, StrokeVisualSignature, TransitionPath } from "@/lib/types";
import type { StrokeStore } from "@/state/strokeStore";
import type { CanvasTransformState } from "@/store/canvasTransform";
import { resolveVisualSignature, sampleWidthProfile } from "@/engine/visualSignature";
import { hashStr } from "@/simulation/rng";
import { ANIMATED_TRAIL_RETENTION, animatedTrailOpacity, animatedTrailStart, clampTrailRetention } from "@/engine/meteorTrail";

interface Point { x: number; y: number }
interface MeteorSample extends Point {
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
}

interface RibbonNode extends Point {
  nx: number;
  ny: number;
  width: number;
  bias: number;
  cutback: number;
  energy: number;
  sample: MeteorSample;
  texture: BrushTextureSample;
}

export interface BrushMaterialConfig {
  surface: "cut-face" | "ink-belly" | "wet-sediment" | "dry-fibers";
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
 * Round inside each control-point triangle. Unlike an unconstrained spline,
 * these quadratic joins cannot overshoot a reversal and invent an extra arm.
 * Returned samples are evenly spaced by arc length and include both endpoints.
 */
export function sampleMeteorCenterline(
  controls: readonly Point[],
  width: number,
  height: number,
  sharpness = 0,
): { points: Point[]; length: number } {
  const source: Point[] = [];
  for (const control of controls) {
    if (!Number.isFinite(control.x) || !Number.isFinite(control.y)) continue;
    const point = { x: control.x * width, y: control.y * height };
    const last = source[source.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 0.0001) source.push(point);
  }
  if (source.length < 2) return { points: source, length: 0 };
  const dense: Point[] = [source[0]];
  const rounding = mix(0.36, 0.12, clamp(sharpness, 0, 1));
  for (let i = 1; i < source.length - 1; i++) {
    const before = source[i - 1];
    const point = source[i];
    const after = source[i + 1];
    const incoming = Math.hypot(point.x - before.x, point.y - before.y);
    const outgoing = Math.hypot(after.x - point.x, after.y - point.y);
    const radius = Math.min(incoming, outgoing) * rounding;
    const entry = {
      x: mix(point.x, before.x, radius / incoming),
      y: mix(point.y, before.y, radius / incoming),
    };
    const exit = {
      x: mix(point.x, after.x, radius / outgoing),
      y: mix(point.y, after.y, radius / outgoing),
    };
    dense.push(entry);
    const steps = clamp(Math.ceil(radius / 2), 3, 10);
    for (let j = 1; j <= steps; j++) {
      const t = j / steps;
      const u = 1 - t;
      dense.push({
        x: u * u * entry.x + 2 * u * t * point.x + t * t * exit.x,
        y: u * u * entry.y + 2 * u * t * point.y + t * t * exit.y,
      });
    }
  }
  dense.push(source[source.length - 1]);
  const distances = [0];
  for (let i = 1; i < dense.length; i++) {
    distances.push(distances[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y));
  }
  const length = distances[distances.length - 1];
  if (length < 0.0001) return { points: [source[0]], length: 0 };
  // A fixed upper bound keeps a busy sky cheap; pressure is sampled separately
  // and densely enough to retain even an eight-phase width profile.
  const segments = clamp(Math.ceil(length / 2.5), 32, 256);
  const points: Point[] = [];
  let cursor = 1;
  for (let i = 0; i <= segments; i++) {
    const distance = (i / segments) * length;
    while (cursor < distances.length - 1 && distances[cursor] < distance) cursor++;
    const local = (distance - distances[cursor - 1]) / Math.max(0.00001, distances[cursor] - distances[cursor - 1]);
    points.push({
      x: mix(dense[cursor - 1].x, dense[cursor].x, local),
      y: mix(dense[cursor - 1].y, dense[cursor].y, local),
    });
  }
  return { points, length };
}

/**
 * A deterministic luminous ribbon. The playback layer supplies travelled
 * distance; no wall-clock noise, brush stamps, particles or secondary paths
 * are added here, so replaying and scrubbing produce the same exact frame.
 */
export class MeteorRenderer {
  private readonly context: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private cache = new Map<string, MeteorGeometry>();
  private pathsReference: TransitionPath[] | null = null;
  private ordered: TransitionPath[] = [];
  private agentsReference: Agent[] | null = null;
  private agentsById = new Map<string, Agent>();
  private visible: VisibleMeteor[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Noema requires a Canvas 2D context for its meteor layer.");
    this.context = context;
  }

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
  }

  private geometry(path: TransitionPath, store: StrokeStore): MeteorGeometry {
    const controls = store.controlPointsOf(path.id);
    const hue = (this.agentsById.get(path.agent_id)?.style.hue ?? 210) + (path.mood?.color_variation ?? 0) * 40;
    const cached = this.cache.get(path.id);
    if (cached?.controls === controls && cached.path === path && cached.hue === hue) return cached;
    const signature = resolveVisualSignature(path, hue);
    const config = getBrushMaterialConfig(signature.brush_style);
    const materialSeed = path.variation_seed ?? path.base_seed ?? hashStr(path.id);
    const { points, length } = sampleMeteorCenterline(controls, this.width, this.height, signature.turn_sharpness);
    const samples: MeteorSample[] = points.map((point, index) => {
      const before = points[Math.max(0, index - 1)];
      const after = points[Math.min(points.length - 1, index + 1)];
      const dx = after.x - before.x;
      const dy = after.y - before.y;
      const distance = Math.max(0.0001, Math.hypot(dx, dy));
      const progress = index / Math.max(1, points.length - 1);
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
      return {
        ...point,
        nx: -dy / distance,
        ny: dx / distance,
        pressure,
        texture,
        color: `hsl(${pigment.toFixed(1)} 82% ${faceLightness.toFixed(2)}%)`,
        core: `hsl(${pigment.toFixed(1)} 61% ${(config.highlightLightness + pigmentVariation * 0.4).toFixed(2)}%)`,
        rim: `hsl(${pigment.toFixed(1)} 88% ${(config.rimLightness + pigmentVariation * 0.55).toFixed(2)}%)`,
        groove: `hsl(${pigment.toFixed(1)} 52% ${config.grooveLightness}%)`,
      };
    });
    const geometry = { controls, path, hue, samples, length, signature };
    this.cache.set(path.id, geometry);
    return geometry;
  }

  draw(
    _time: number,
    paths: TransitionPath[],
    agents: Agent[],
    store: StrokeStore,
    focusId: string | null,
    filterAgentId: string | null,
    view: CanvasTransformState,
    progressById: ReadonlyMap<string, number>,
    options: MeteorRenderOptions = {},
  ): void {
    const ctx = this.context;
    this.visible.length = 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (paths !== this.pathsReference) {
      this.pathsReference = paths;
      this.ordered = [...paths].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
      const retained = new Set(paths.map((path) => path.id));
      for (const id of this.cache.keys()) if (!retained.has(id)) this.cache.delete(id);
    }
    if (agents !== this.agentsReference) {
      this.agentsReference = agents;
      this.agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    }
    ctx.globalCompositeOperation = "source-over";
    const trailRetention = clampTrailRetention(options.trailRetention ?? ANIMATED_TRAIL_RETENTION);
    for (const path of this.ordered) {
      if (focusId && path.id !== focusId) continue;
      if (!focusId && filterAgentId && path.agent_id !== filterAgentId) continue;
      const progress = clamp(progressById.get(path.id) ?? 1, 0, 1);
      const opacity = clamp(options.opacityById?.get(path.id) ?? 1, 0, 1);
      if (progress <= 0 || opacity <= 0) continue;
      const geometry = this.geometry(path, store);
      if (!geometry.samples.length) continue;
      const pathView = options.viewById?.get(path.id) ?? view;
      const zoom = Math.max(0.0001, pathView.scale);
      const x = pathView.translateX * this.width;
      const y = pathView.translateY * this.height;
      ctx.setTransform(this.dpr * zoom, 0, 0, this.dpr * zoom, x * this.dpr, y * this.dpr);
      const retainTrace = options.retainTrace ?? false;
      const start = this.drawMeteor(geometry, progress, zoom, store.transformOf(path.id).scale, retainTrace, opacity, trailRetention);
      if (opacity >= 0.08) this.visible.push({ id: path.id, geometry, from: start, to: progress, zoom, x, y, retainTrace, opacity, trailRetention });
    }
    ctx.globalAlpha = 1;
  }

  private drawMeteor(geometry: MeteorGeometry, progress: number, zoom: number, transformScale: number, retainTrace: boolean, opacity: number, trailRetention: number): number {
    const { samples, signature } = geometry;
    const style = signature.brush_style;
    const segmentCount = samples.length - 1;
    const pathPixels = geometry.length * zoom;
    const tailStyle = style === "hard" ? 0.82 : style === "texture" ? 0.93 : style === "watercolor" ? 1.2 : 1.1;
    const tailPixels = clamp(Math.min(this.width, this.height) * 0.24, 85, 185) * tailStyle;
    const tailSpan = Math.min(1, tailPixels / Math.max(1, pathPixels));
    const from = retainTrace ? 0 : animatedTrailStart(progress, trailRetention);
    const scale = clamp(Math.sqrt(Math.max(0.01, transformScale) * zoom), 0.8, 1.16) * (retainTrace ? 1.12 : 0.94);

    if (segmentCount === 0 || pathPixels < 0.01) {
      // A genuine zero-length semantic gesture remains one compact diamond.
      const point = samples[0];
      const r = 0.7 / zoom;
      const ctx = this.context;
      ctx.globalAlpha = opacity;
      ctx.fillStyle = point.color;
      ctx.beginPath();
      ctx.moveTo(point.x - r, point.y);
      ctx.lineTo(point.x, point.y - r * 0.55);
      ctx.lineTo(point.x + r, point.y);
      ctx.lineTo(point.x, point.y + r * 0.55);
      ctx.closePath();
      ctx.fill();
      return from;
    }

    const start = from * segmentCount;
    const end = progress * segmentCount;
    const positions = [start];
    for (let i = Math.floor(start) + 1; i < end; i++) positions.push(i);
    // Sample the final nib independently of centreline density, so even a long
    // trajectory has a real tapered/chisel end instead of one oversized quad.
    const nominalTip = sampleBrushMaterial(style, 1, progress, 0, signature.width_ratio, scale).tipLength;
    const displayLimits = getBrushDisplayLimits(pathPixels, signature.width_change_count, nominalTip);
    const tipLength = displayLimits.tipLength;
    for (let i = 4; i >= 1; i--) {
      const position = end - (tipLength * i / 4) / pathPixels * segmentCount;
      if (position > start && position < end) positions.push(position);
    }
    positions.push(end);
    positions.sort((a, b) => a - b);

    const nodes: RibbonNode[] = [];
    let lastPosition = -1;
    for (const position of positions) {
      if (position - lastPosition < 0.000001) continue;
      lastPosition = position;
      const index = Math.min(segmentCount - 1, Math.floor(position));
      const a = samples[index];
      const b = samples[index + 1];
      const f = position - index;
      const t = position / segmentCount;
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
      const remaining = Math.max(0, (progress - t) * pathPixels);
      const tipPhase = clamp(remaining / tipLength, 0, 1);
      const tail = retainTrace
        ? Math.pow(clamp(1 - (progress - t) / tailSpan, 0, 1), 1.2)
        : animatedTrailOpacity(progress, t, trailRetention);
      let taper = 1;
      if (style === "soft") taper = 0.025 + 0.975 * Math.pow(Math.sin(tipPhase * Math.PI / 2), 1.3);
      else if (style === "watercolor") taper = 0.04 + 0.96 * Math.sqrt(Math.max(0, 1 - (1 - tipPhase) ** 2));
      else if (style === "texture") taper = 0.72 + tipPhase * 0.28;
      const tailWidth = retainTrace ? 1 : 0.22 + Math.pow(tail, 0.6) * 0.78;
      const edgeCoverage = (texture.leftEdge + texture.rightEdge) * 0.5;
      const minimumWidth = Math.min(displayLimits.maxWidth, displayLimits.minConnector / Math.max(0.4, edgeCoverage));
      const connectedWidth = clamp(material.width, minimumWidth, displayLimits.maxWidth);
      const width = connectedWidth * taper * tailWidth;
      nodes.push({
        x: mix(a.x, b.x, f),
        y: mix(a.y, b.y, f),
        nx, ny,
        width,
        texture,
        bias: material.edgeBias,
        // Keep edge retreat slower than centreline advance; otherwise a broad
        // chisel can fold its last quad backward and resemble a forked tip.
        cutback: Math.min(tipLength * 0.42, style === "hard" ? width * 0.6 : style === "texture" ? width * 0.28 : 0) * (1 - tipPhase) ** 2,
        // Completed comparison/detail frames keep pigment readable instead of
        // fading the very surface detail the viewer is trying to inspect.
        energy: opacity * (retainTrace ? 0.82 + tail * 0.18 : tail),
        sample: f < 0.5 ? a : b,
      });
    }

    // The shared halo is deliberately weaker than the pigment surface. Each
    // instrument has its own internal deposit/edge structure inside one ribbon.
    const halo = style === "hard" ? 1.35 : style === "watercolor" ? 1.25 : 1.35;
    this.drawBand(nodes, -halo, halo, retainTrace ? 0.018 : 0.035, "color", zoom);
    if (style === "hard") {
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
    return from;
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
    const ctx = this.context;
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1];
      const b = nodes[i];
      ctx.globalAlpha = clamp((a.energy + b.energy) * 0.5 * strength, 0, 1);
      ctx.fillStyle = a.sample[pigment];
      ctx.beginPath();
      this.ribbonVertex(a, typeof high === "number" ? high : clamp(high(a), -1, 1), zoom, true);
      this.ribbonVertex(b, typeof high === "number" ? high : clamp(high(b), -1, 1), zoom);
      this.ribbonVertex(b, typeof low === "number" ? low : clamp(low(b), -1, 1), zoom);
      this.ribbonVertex(a, typeof low === "number" ? low : clamp(low(a), -1, 1), zoom);
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawFibers(nodes: RibbonNode[], zoom: number, count: number, material: "soft" | "texture"): void {
    if (nodes.length < 2) return;
    const ctx = this.context;
    ctx.save();
    // This explicit silhouette clip means a bristle can never become a branch.
    ctx.beginPath();
    nodes.forEach((node, index) => this.ribbonVertex(node, 1, zoom, index === 0));
    for (let i = nodes.length - 1; i >= 0; i--) this.ribbonVertex(nodes[i], -1, zoom);
    ctx.closePath();
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

  /** Hit the visible, rounded centreline from the latest drawn frame, in CSS px. */
  hitTest(cssX: number, cssY: number, tolerance = 12): string | null {
    let nearest: string | null = null;
    let nearestDistance = Math.max(0, tolerance) ** 2;
    for (let v = this.visible.length - 1; v >= 0; v--) {
      const visible = this.visible[v];
      const samples = visible.geometry.samples;
      const segments = samples.length - 1;
      const from = visible.from * segments;
      const to = visible.to * segments;
      if (segments === 0) {
        const dx = cssX - (samples[0].x * visible.zoom + visible.x);
        const dy = cssY - (samples[0].y * visible.zoom + visible.y);
        const distance = dx * dx + dy * dy;
        if (distance <= nearestDistance) { nearestDistance = distance; nearest = visible.id; }
        continue;
      }
      for (let i = Math.floor(from); i < Math.min(segments, Math.ceil(to)); i++) {
        const a = samples[i];
        const b = samples[i + 1];
        const f0 = clamp(from - i, 0, 1);
        const f1 = clamp(to - i, 0, 1);
        if (f1 <= f0) continue;
        const ax = mix(a.x, b.x, f0) * visible.zoom + visible.x;
        const ay = mix(a.y, b.y, f0) * visible.zoom + visible.y;
        const bx = mix(a.x, b.x, f1) * visible.zoom + visible.x;
        const by = mix(a.y, b.y, f1) * visible.zoom + visible.y;
        const dx = bx - ax;
        const dy = by - ay;
        const u = clamp(((cssX - ax) * dx + (cssY - ay) * dy) / Math.max(0.000001, dx * dx + dy * dy), 0, 1);
        const position = (i + mix(f0, f1, u)) / segments;
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
  }
}
