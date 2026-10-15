import type { CanvasTransformState } from "@/store/canvasTransform";

export interface SkyDisplayBox {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

/** Display-only placement: small gestures stay small instead of filling a tile. */
export function skyDisplayView(
  points: readonly { x: number; y: number }[],
  box: SkyDisplayBox,
): CanvasTransformState {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = points.length ? Math.min(...xs) : 0.5;
  const maxX = points.length ? Math.max(...xs) : 0.5;
  const minY = points.length ? Math.min(...ys) : 0.5;
  const maxY = points.length ? Math.max(...ys) : 0.5;
  // The full authored coordinate space, not this stroke's bounding box, is
  // the common scale reference. A bounds cap only shrinks oversized edits.
  const scale = Math.min(
    box.width / 0.95,
    box.height / 0.95,
    box.width / Math.max(0.001, maxX - minX),
    box.height / Math.max(0.001, maxY - minY),
  );
  return {
    scale,
    translateX: box.centerX - (minX + maxX) * 0.5 * scale,
    translateY: box.centerY - (minY + maxY) * 0.5 * scale,
  };
}
