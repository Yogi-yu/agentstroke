import type { BrushTreatment, TransitionPath } from "@/lib/types";

/**
 * Two brush gestures per five slots, without a random 0/10 or 10/10 batch.
 * A batch seed rotates the allocation, not the agent's authored route. Repeating
 * the five-slot cycle means any ten consecutive slots contain exactly four.
 */
export function brushTreatmentForIndex(index: number, seed = 0): BrushTreatment {
  const slot = ((Math.max(0, Math.floor(index)) + (seed >>> 0) % 5) % 5);
  return slot === 2 || slot === 4 ? "calligraphy" : "original";
}

/** Persist only the chosen instrument; semantic and geometric data are sacred. */
export function assignBrushTreatment<T extends TransitionPath>(path: T, treatment: BrushTreatment): T {
  path.brush_treatment = treatment;
  // Keep the serialized material label consistent with the runtime resolver.
  // Other signature fields are intentionally left byte-for-byte unchanged.
  if (path.visual_signature) {
    const intensity = path.points.length
      ? path.points.reduce((sum, point) => sum + point.intensity, 0) / path.points.length
      : 0;
    path.visual_signature = {
      ...path.visual_signature,
      brush_style: treatment === "calligraphy" ? "calligraphy"
        : intensity < 0.7 ? "hard" : intensity < 0.76 ? "soft" : intensity < 0.83 ? "watercolor" : "texture",
    };
  }
  return path;
}

/**
 * Explicit one-time migration for existing artwork. Never run this in render:
 * selection, filtering, deleting a neighbour or viewing one detail must not
 * change an artwork's instrument. Input order itself is preserved.
 */
export function assignBrushTreatments<T extends TransitionPath>(paths: T[], seed = 0): T[] {
  const ordered = [...paths].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  ordered.forEach((path, index) => assignBrushTreatment(path, brushTreatmentForIndex(index, seed)));
  return paths;
}
