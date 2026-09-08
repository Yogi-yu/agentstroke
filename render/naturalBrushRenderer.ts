import type { Agent, TransitionPath } from "@/lib/types";
import type { StrokeStore } from "@/state/strokeStore";
import { resolveVisualSignature, sampleProfile } from "@/engine/visualSignature";
import { hashStr } from "@/simulation/rng";

type BrushModule = typeof import("p5.brush/standalone");

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

type BrushPoint = [number, number, number];

const catmullValue = (p0: number, p1: number, p2: number, p3: number, t: number) => {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};

const sampleBrushCurve = (points: BrushPoint[], progress: number): BrushPoint => {
  const scaled = clamp(progress, 0, 1) * Math.max(1, points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  const t = scaled - index;
  const a = points[index - 1] ?? points[index];
  const b = points[index];
  const c = points[index + 1];
  const d = points[index + 2] ?? c;
  return [
    catmullValue(a[0], b[0], c[0], d[0], t),
    catmullValue(a[1], b[1], c[1], d[1], t),
    clamp(catmullValue(a[2], b[2], c[2], d[2], t), 0.08, 1.3),
  ];
};

const paletteHueAt = (hues: number[], t: number) => {
  if (hues.length <= 1) return hues[0] ?? 0;
  const scaled = clamp(t, 0, 1) * (hues.length - 1);
  const index = Math.min(hues.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const start = hues[index];
  const end = hues[index + 1];
  const delta = ((end - start + 540) % 360) - 180;
  return (start + delta * local + 360) % 360;
};

export const hslToCss = (hue: number, saturation: number, lightness: number) => {
  const h = ((hue % 360) + 360) % 360;
  const s = clamp(saturation, 0, 1);
  const l = clamp(lightness, 0, 1);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return `rgb(${rgb.map((v) => Math.round((v + m) * 255)).join(" ")})`;
};

function registerNoemaBrushes(brush: BrushModule) {
  const names = new Set(brush.box());
  if (!names.has("noema-hard-v3")) {
    brush.add("noema-hard-v3", {
      type: "custom",
      weight: 1,
      scatter: 0,
      opacity: 238,
      spacing: 0.018,
      pressure: [0.86, 1, 0.8],
      rotate: "natural",
      markerTip: false,
      noise: 0,
      tip: (tip: { noStroke(): void; fill(value: number): void; ellipse(x: number, y: number, w: number, h: number): void }) => {
        tip.noStroke();
        tip.fill(22);
        // A compact oval nib keeps the hard edge but sweeps continuously
        // through corners. The former long rectangle rotated independently on
        // either side of a turn and created a false third arm at the join.
        tip.ellipse(0, 0, 34, 9);
      },
    });
  }
  if (!names.has("noema-soft-v2")) {
    brush.add("noema-soft-v2", {
      type: "custom",
      weight: 1,
      scatter: 0,
      opacity: 218,
      spacing: 0.02,
      pressure: [0.16, 1.12, 0.1],
      rotate: "natural",
      markerTip: false,
      noise: 0,
      tip: (tip: { noStroke(): void; fill(value: number): void; ellipse(x: number, y: number, w: number, h: number): void }) => {
        tip.noStroke();
        tip.fill(172);
        tip.ellipse(0, 0, 58, 34);
        tip.fill(72);
        tip.ellipse(0, 0, 46, 22);
        tip.fill(18);
        tip.ellipse(0, 0, 30, 12);
      },
    });
  }
  if (!names.has("noema-watercolor-v3")) {
    brush.add("noema-watercolor-v3", {
      type: "custom",
      weight: 1,
      scatter: 0,
      opacity: 168,
      spacing: 0.025,
      pressure: [0.34, 1.15, 0.2],
      rotate: "natural",
      markerTip: false,
      noise: 0,
      // A pale belly enclosed by darker wet rims. p5.brush rasterises this
      // once as a real reusable tip and spectrally deposits it along the path.
      tip: (tip: { noStroke(): void; fill(value: number): void; ellipse(x: number, y: number, w: number, h: number): void }) => {
        tip.noStroke();
        tip.fill(52);
        tip.ellipse(0, 0, 70, 28);
        tip.fill(196);
        tip.ellipse(0, 0, 62, 18);
        tip.fill(132);
        tip.ellipse(-1.2, -7.2, 57, 3.2);
        tip.ellipse(1.2, 7.2, 57, 3.2);
      },
    });
  }
  if (!names.has("noema-texture-v2")) {
    brush.add("noema-texture-v2", {
      type: "custom",
      weight: 1,
      scatter: 0,
      opacity: 205,
      spacing: 0.02,
      pressure: { mode: "gaussian", curve: [0.22, 0.18], min_max: [1.08, 0.82] },
      rotate: "natural",
      markerTip: false,
      noise: 0,
      tip: (tip: { noStroke(): void; fill(value: number): void; rect(x: number, y: number, w: number, h: number): void; ellipse(x: number, y: number, w: number, h: number): void }) => {
        tip.noStroke();
        tip.fill(44);
        tip.ellipse(0, 0, 68, 24);
        // Pale cuts remain inside the nib footprint, creating bristle channels
        // without emitting any particles outside the continuous mark.
        tip.fill(226);
        tip.rect(-33, -6.4, 66, 1.8);
        tip.rect(-33, -1.4, 66, 1.25);
        tip.rect(-33, 3.2, 66, 2.1);
        tip.fill(118);
        tip.rect(-33, 6.7, 66, 1.1);
      },
    });
  }
}

/**
 * Visible mark layer backed by p5.brush's standalone WebGL2 renderer.
 * Geometry, selection and editing remain owned by StrokeStore; this class only
 * turns the resulting continuous paths into materially different instruments.
 */
export class NaturalBrushRenderer {
  private width = 1;
  private height = 1;
  private dpr = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly brush: BrushModule,
  ) {
    registerNoemaBrushes(brush);
  }

  resize(cssWidth: number, cssHeight: number, dpr: number) {
    this.width = Math.max(1, cssWidth);
    this.height = Math.max(1, cssHeight);
    this.dpr = Math.max(1, dpr);
    this.canvas.width = Math.max(1, Math.round(this.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.height * this.dpr));
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  draw(
    time: number,
    paths: TransitionPath[],
    agents: Agent[],
    store: StrokeStore,
    focusId: string | null,
    filterAgentId: string | null,
    view: { scale: number; translateX: number; translateY: number },
  ) {
    const { brush, canvas } = this;
    brush.load(canvas);
    brush.clear();
    brush.push();
    brush.translate(-canvas.width / 2, -canvas.height / 2);

    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    const ordered = [...paths].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    for (const path of ordered) {
      if (focusId && path.id !== focusId) continue;
      if (!focusId && filterAgentId && path.agent_id !== filterAgentId) continue;
      const control = store.controlPointsOf(path.id);
      if (control.length < 2) continue;

      const agent = agentsById.get(path.agent_id);
      const baseHue = (agent?.style.hue ?? 210) + (path.mood?.color_variation ?? 0) * 40;
      const signature = resolveVisualSignature(path, baseHue);
      const motionSeed = (hashStr(`${path.id}:living-ink`) % 1000) / 1000;
      const motionVariation = path.mood?.motion_variation ?? 0.5;
      const speedFactor = agent?.style.speedFactor ?? 0.7;
      const motionClock = time * (0.00055 + speedFactor * 0.00032) + motionSeed * Math.PI * 2;
      const source = path.points;
      const sourceAt = (t: number) => {
        const x = clamp(t, 0, 1) * Math.max(0, source.length - 1);
        const i = Math.floor(x);
        const a = source[i] ?? source[0];
        const b = source[Math.min(source.length - 1, i + 1)] ?? a;
        const f = x - i;
        return {
          width: (a?.stroke_width ?? 1) + ((b?.stroke_width ?? 1) - (a?.stroke_width ?? 1)) * f,
          intensity: (a?.intensity ?? 0.5) + ((b?.intensity ?? 0.5) - (a?.intensity ?? 0.5)) * f,
        };
      };
      const pressureAt = (t: number) => {
        const semantic = sourceAt(t);
        const envelope = Math.pow(Math.sin(Math.PI * t), 0.62);
        const widthSignal = clamp(semantic.width / 6, 0, 1);
        let pressure = 0.72 + widthSignal * 0.35;
        if (signature.brush_style === "soft") pressure = (0.12 + envelope * 0.98) * (0.62 + widthSignal * 0.5);
        if (signature.brush_style === "watercolor") pressure = (0.42 + envelope * 0.7) * (0.72 + widthSignal * 0.35);
        if (signature.brush_style === "texture") {
          const drag = 0.78 + 0.22 * Math.sin(t * Math.PI * 7 + semantic.intensity * 11);
          pressure = (0.24 + envelope * 0.88) * (0.58 + widthSignal * 0.6) * drag;
        }
        if (signature.width_change_count === 0) {
          pressure = 0.9;
        } else {
          pressure *= sampleProfile(signature.width_profile, t);
        }
        // Pressure is not an overlay: the actual brush footprint contracts and
        // expands as a restrained pulse travels from the handle to the nib.
        const pressureDepth = signature.width_change_count === 0 ? 0
          : signature.brush_style === "hard" ? 0.08
            : signature.brush_style === "texture" ? 0.16
              : signature.brush_style === "soft" ? 0.22 : 0.28;
        const pressurePulse = 1 + Math.sin(motionClock - t * Math.PI * 2.4) * pressureDepth * envelope;
        pressure *= pressurePulse;

        return clamp(pressure, 0.06, 1.45);
      };

      const livingControls: BrushPoint[] = control.map((point, index) => {
        const t = index / Math.max(1, control.length - 1);
        const envelope = Math.pow(Math.sin(Math.PI * t), 0.62);

        // Keep both ends planted while the body of the same spline flexes in
        // its local normal direction. This reads as one living gesture, never
        // as a second animated line laid over a static mark.
        const before = control[Math.max(0, index - 1)];
        const after = control[Math.min(control.length - 1, index + 1)];
        const dx = after.x - before.x;
        const dy = after.y - before.y;
        const tangentLength = Math.max(0.00001, Math.hypot(dx, dy));
        const nx = -dy / tangentLength;
        const ny = dx / tangentLength;
        const toolFlex = signature.brush_style === "hard" ? 0.34
          : signature.brush_style === "texture" ? 0.72
            : signature.brush_style === "soft" ? 1 : 1.12;
        const flexPx = (1.3 + motionVariation * 4.2) * toolFlex * envelope;
        const flex = flexPx / Math.max(1, Math.min(this.width, this.height));
        const displacement = Math.sin(motionClock * 0.82 + t * Math.PI * 2.15) * flex;
        const livingX = point.x + nx * displacement;
        const livingY = point.y + ny * displacement;
        const screenX = (livingX * view.scale + view.translateX) * this.width * this.dpr;
        const screenY = (livingY * view.scale + view.translateY) * this.height * this.dpr;
        return [screenX, screenY, pressureAt(t)];
      });

      // Width phases must not be sampled only at the handful of path anchors:
      // doing that erased most of a 3-8 phase profile before it reached
      // p5.brush. Densely sample the same continuous centreline and evaluate
      // pressure independently at every sample, so the actual nib footprint
      // visibly expands and contracts without splitting the stroke.
      const pressureSamples = Math.max(33, signature.width_change_count * 12 + 1, control.length * 8);
      const points: BrushPoint[] = Array.from({ length: pressureSamples }, (_, index) => {
        const t = index / Math.max(1, pressureSamples - 1);
        const position = sampleBrushCurve(livingControls, t);
        return [position[0], position[1], pressureAt(t)];
      });

      const side = Math.min(this.width, this.height);
      const visualWidth = clamp(3.2 + signature.width_ratio * side * 0.85, 3.2, 11);
      const transformScale = store.transformOf(path.id).scale;
      const targetWidth = visualWidth * transformScale * view.scale * this.dpr;
      const wetness = Math.sin(motionClock * 0.7) * (signature.brush_style === "watercolor" ? 0.025 : 0.012);
      const saturation = 0.74;
      const lightness = (focusId === path.id ? 0.68 : 0.58) + wetness;

      brush.seed(hashStr(path.id));
      brush.noiseSeed(hashStr(`${path.id}:grain`));
      const setInstrument = (color: string) => {
        if (signature.brush_style === "hard") brush.set("noema-hard-v3", color, targetWidth * 9);
        else if (signature.brush_style === "soft") brush.set("noema-soft-v2", color, targetWidth * 3);
        else if (signature.brush_style === "watercolor") brush.set("noema-watercolor-v3", color, targetWidth * 8);
        else brush.set("noema-texture-v2", color, targetWidth * 3.5);
      };
      const baseCurvature = 0.2 + (1 - signature.turn_sharpness) * 0.68;
      const toolCurve = signature.brush_style === "hard"
        ? baseCurvature * 0.45
        : signature.brush_style === "watercolor"
          ? baseCurvature + 0.14
          : signature.brush_style === "soft"
            ? baseCurvature + 0.08
            : baseCurvature;
      const livingTension = Math.sin(motionClock * 0.46) * (
        signature.brush_style === "hard" ? 0.012 : 0.035
      );
      const curvature = clamp(toolCurve + livingTension, 0.08, 0.9);
      if (signature.color_count === 1) {
        setInstrument(hslToCss(signature.color_hues[0] ?? signature.hue_start, saturation, lightness));
        brush.spline(points, curvature);
      } else {
        // Sample the same living spline densely, then redistribute by travelled
        // distance. Consecutive micro-segments share endpoints, so this remains
        // one uninterrupted mark while the pigment changes uniformly by length.
        const dense = Array.from({ length: 97 }, (_, index) => sampleBrushCurve(points, index / 96));
        const cumulative = [0];
        for (let index = 1; index < dense.length; index++) {
          cumulative.push(cumulative[index - 1] + Math.hypot(dense[index][0] - dense[index - 1][0], dense[index][1] - dense[index - 1][1]));
        }
        const total = Math.max(0.001, cumulative[cumulative.length - 1]);
        const atDistance = (distance: number): BrushPoint => {
          let index = 1;
          while (index < cumulative.length - 1 && cumulative[index] < distance) index++;
          const lo = cumulative[index - 1];
          const hi = cumulative[index];
          const f = hi <= lo ? 0 : (distance - lo) / (hi - lo);
          return [
            mix(dense[index - 1][0], dense[index][0], f),
            mix(dense[index - 1][1], dense[index][1], f),
            mix(dense[index - 1][2], dense[index][2], f),
          ];
        };
        const gradientSegments = signature.color_count === 3 ? 18 : 26;
        let previous = atDistance(0);
        for (let segment = 0; segment < gradientSegments; segment++) {
          const endT = (segment + 1) / gradientSegments;
          const next = atDistance(total * endT);
          const hue = paletteHueAt(signature.color_hues, (segment + 0.5) / gradientSegments);
          setInstrument(hslToCss(hue, saturation, lightness));
          brush.spline([previous, next], 0);
          previous = next;
        }
      }
    }

    brush.pop();
    brush.render();
  }
}
