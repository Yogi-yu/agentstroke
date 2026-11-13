import type { StrokeColorTreatment, TransitionPath } from "@/lib/types";
import { hashStr } from "@/simulation/rng";

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

/**
 * Pigment-only adjustment: preserve hue order, texture, alpha and all geometry.
 * Muted ink retains a little cool/warm tint (11–20% saturation on the usual
 * recipes), a readable charcoal/slate face and subdued highlights. Map dark
 * grooves separately so they remain recessed instead of becoming pale lines.
 */
export function pigmentHsl(hue: number, saturation: number, lightness: number, treatment: StrokeColorTreatment = "bright"): string {
  const s = clamp(saturation, 0, 100);
  const l = clamp(lightness, 0, 100);
  const pigmentS = treatment === "muted" ? s * 0.22 : s;
  const pigmentL = treatment === "muted" ? (l <= 30 ? l * 0.65 : 19.5 + (l - 30) * 0.42) : l;
  return `hsl(${hue.toFixed(1)} ${pigmentS.toFixed(2)}% ${pigmentL.toFixed(2)}%)`;
}
