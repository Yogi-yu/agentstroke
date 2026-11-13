import type { BrushStrokeStyle, StrokeColorTreatment, TransitionPath } from "@/lib/types";
import { hashStr, makeRng } from "@/simulation/rng";

/** Independent of material/motion seeds; consecutive pairs always split 50/50. */
export function colorTreatmentForIndex(index: number, seed = 0): StrokeColorTreatment {
  const slot = Math.max(0, Math.floor(Number.isFinite(index) ? index : 0));
  return (slot + (seed >>> 0)) % 2 === 0 ? "muted" : "bright";
}

/** Old standalone snapshots remain stable even before the server assigns a tone. */
export function resolveColorTreatment(path: Pick<TransitionPath, "id" | "color_treatment">): StrokeColorTreatment {
  if (path.color_treatment === "muted" || path.color_treatment === "bright") return path.color_treatment;
  return colorTreatmentForIndex(hashStr(`noema-pigment-v1:${path.id}`));
}

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

/** The bright material recipe is unchanged; natural ink never passes here. */
export function pigmentHsl(hue: number, saturation: number, lightness: number): string {
  return `hsl(${hue.toFixed(1)} ${clamp(saturation, 0, 100).toFixed(2)}% ${clamp(lightness, 0, 100).toFixed(2)}%)`;
}

type RGB = readonly [number, number, number];
interface PigmentFamily { readonly name: string; readonly dense: RGB; readonly body: RGB; readonly dry: RGB }
export interface NaturalPigmentProfile {
  readonly families: readonly PigmentFamily[];
  readonly density: number;
  readonly flow: readonly number[];
}
export interface PigmentPaint { color: string; core: string; rim: string; groove: string }

const rgb = (hex: string): RGB => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
const family = (name: string, dense: string, body: string, dry: string): PigmentFamily =>
  Object.freeze({ name, dense: Object.freeze(rgb(dense)), body: Object.freeze(rgb(body)), dry: Object.freeze(rgb(dry)) });

// Intrinsic pigment recipes: concentrated ink, deposited color and dry mineral
// grain. These are deliberately NOT transformations of the old rainbow hues.
// Neighbouring recipes blend coherently on multi-pigment long strokes.
const NATURAL_PIGMENTS: readonly PigmentFamily[] = Object.freeze([
  family("Graphite",       "2d3337", "565e62", "929a9a"),
  family("Payne's grey",   "23323c", "455969", "8998a2"),
  family("Indigo ink",     "2a3049", "4a5575", "8a95ab"),
  family("Smoked plum",    "3a2d3e", "6b526d", "a38ba1"),
  family("Red ochre",      "492b2b", "84544b", "ba9180"),
  family("Raw umber",      "403027", "795e49", "b39a80"),
  family("Olive earth",    "3d3c27", "77734d", "b1ab89"),
  family("Moss earth",     "303b2a", "5e6c4d", "a2ab8b"),
  family("Deep viridian",  "233b37", "46675c", "91a698"),
  family("Blue slate",     "333c41", "65757b", "a3adb1"),
]);

/** Independent artwork identity seed: no reroll on playback, camera or agent edits. */
export function createNaturalPigment(id: string, colorCount: number): NaturalPigmentProfile {
  const random = makeRng(hashStr(`noema-natural-ink-v2:${id}`));
  const start = Math.floor(random() * NATURAL_PIGMENTS.length);
  const direction = random() < 0.5 ? -1 : 1;
  const count = colorCount >= 5 ? 5 : colorCount >= 3 ? 3 : 1;
  const families = Array.from({ length: count }, (_, index) => NATURAL_PIGMENTS[(start + direction * index + NATURAL_PIGMENTS.length) % NATURAL_PIGMENTS.length]);
  const density = 0.12 + random() * 0.8;
  const firstDry = random() < 0.5;
  const flow = Array.from({ length: 3 + Math.floor(random() * 3) }, (_, index) =>
    (Boolean(index % 2) === firstDry ? 0.62 : 0.08) + random() * 0.28);
  return { families, density, flow };
}

const mix = (a: number, b: number, amount: number) => a + (b - a) * amount;
const mixRgb = (a: RGB, b: RGB, amount: number): RGB => [mix(a[0], b[0], amount), mix(a[1], b[1], amount), mix(a[2], b[2], amount)];
const smooth = (t: number) => t * t * (3 - 2 * t);
function pigmentAt(pigment: PigmentFamily, dryness: number): RGB {
  const t = clamp(dryness, 0, 1);
  return t < 0.5 ? mixRgb(pigment.dense, pigment.body, t * 2) : mixRgb(pigment.body, pigment.dry, (t - 0.5) * 2);
}
function flowAt(flow: readonly number[], progress: number): number {
  const position = clamp(progress, 0, 1) * (flow.length - 1);
  const index = Math.floor(position);
  return mix(flow[index], flow[Math.min(index + 1, flow.length - 1)], smooth(position - index));
}
const cssRgb = (color: RGB) => `rgb(${color.map(channel => clamp(channel, 0, 255).toFixed(2)).join(" ")})`;

/**
 * Color-only material deposition. Density differs per artwork; the loaded/dry
 * balance changes slowly along its route, with existing grain as a small local
 * contribution. No black overlay, opacity multiplier or wall-clock randomness.
 */
export function sampleNaturalPigment(profile: NaturalPigmentProfile, progress: number, texture: { pigmentLoad: number; grain: number }, style: BrushStrokeStyle): PigmentPaint {
  const position = clamp(progress, 0, 1) * (profile.families.length - 1);
  const index = Math.floor(position);
  const a = profile.families[index], b = profile.families[Math.min(index + 1, profile.families.length - 1)];
  const blend = smooth(position - index);
  const deposition = (flowAt(profile.flow, progress) - 0.5) * 0.34;
  const localGrain = (clamp(texture.grain, 0, 1) - 0.5) * (style === "watercolor" ? 0.07 : style === "texture" ? 0.06 : 0.025);
  const dryness = clamp(0.19 + (1 - profile.density) * 0.66 + deposition + (0.5 - clamp(texture.pigmentLoad, 0, 1)) * 0.09 + localGrain, 0.14, 0.92);
  const paint = (level: number) => cssRgb(mixRgb(pigmentAt(a, level), pigmentAt(b, level), blend));
  // Reflectance stays in the same pigment family, never a white/neon highlight.
  const highlight = style === "calligraphy" ? 0.045 : style === "hard" ? 0.13 : 0.09;
  return {
    color: paint(dryness),
    core: paint(dryness + highlight),
    rim: paint(dryness - (style === "watercolor" ? 0.14 : 0.07)),
    groove: paint(Math.max(0, dryness - 0.34)),
  };
}
