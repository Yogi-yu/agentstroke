import type { StrokeTransform } from "@/lib/types";
import type { XY } from "@/engine/strokeMutation";
import type { CanvasTransformState } from "@/store/canvasTransform";

/**
 * Give compact marks room to reveal their folds and pressure changes. This is
 * a camera per stroke, never a change to the authored geometry or attributes.
 * Measure the unedited footprint, not arc length (a folded route can be long
 * yet occupy only a few pixels). Undo manual rotation/scale for that measurement
 * so an intentional resize is not cancelled by automatic readability fitting.
 */
export function strokeDisplayView(
  points: readonly XY[],
  transform: StrokeTransform,
  viewport: { width: number; height: number },
  camera: CanvasTransformState,
): CanvasTransformState {
  if (points.length < 2 || viewport.width <= 0 || viewport.height <= 0) return camera;
  const center = points.reduce((sum, p) => ({
    x: sum.x + p.x / points.length, y: sum.y + p.y / points.length,
  }), { x: 0, y: 0 });
  const cos = Math.cos(transform.rotation), sin = Math.sin(transform.rotation);
  const authoredScale = Math.max(0.0001, transform.scale);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    const dx = point.x - center.x, dy = point.y - center.y;
    const x = (dx * cos + dy * sin) / authoredScale;
    const y = (-dx * sin + dy * cos) / authoredScale;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const extent = Math.max((maxX - minX) * viewport.width, (maxY - minY) * viewport.height);
  if (!Number.isFinite(extent) || extent < 0.01 || extent >= 120) return camera;
  // A soft floor retains size differences; the 5x cap keeps near-point marks
  // small. Already readable marks and true point gestures are unchanged.
  const gain = Math.min(5, 0.4 + 72 / extent);
  return {
    scale: camera.scale * gain,
    translateX: camera.translateX + center.x * camera.scale * (1 - gain),
    translateY: camera.translateY + center.y * camera.scale * (1 - gain),
  };
}
