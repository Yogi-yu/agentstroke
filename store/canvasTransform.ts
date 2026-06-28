// ============================================================================
// canvasTransform — the Edit Mode "view" transform (zoom + pan).
// ----------------------------------------------------------------------------
// Edit Mode is a TRANSFORMED COORDINATE WORKSPACE, not a static canvas. This
// module owns the screen↔world mapping that makes that possible:
//
//     screen_position = world_position * scale + translate
//     world_position  = (screen_position - translate) / scale
//
// All coordinates are in normalized [0,1]² space (the same space strokes, the
// hitmap and the editor already live in), so "world" = a stroke's authored
// position and "screen" = where it currently appears on the zoomed/panned
// canvas. World position is the SOURCE OF TRUTH; the view transform only
// changes how it is displayed and where the pointer lands.
// ============================================================================

import type { XY } from "@/engine/strokeMutation";

export interface CanvasTransformState {
  scale: number;
  translateX: number;
  translateY: number;
}

// Zoom limits (per spec): 5× out … 3× in.
export const MIN_SCALE = 0.2;
export const MAX_SCALE = 3.0;

export const DEFAULT_CANVAS_TRANSFORM: CanvasTransformState = {
  scale: 1,
  translateX: 0,
  translateY: 0,
};

export function clampScale(s: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
}

export function isDefaultTransform(v: CanvasTransformState): boolean {
  return v.scale === 1 && v.translateX === 0 && v.translateY === 0;
}

/** world → screen: where a world point currently appears under the view. */
export function worldToScreen(p: XY, v: CanvasTransformState): XY {
  return { x: p.x * v.scale + v.translateX, y: p.y * v.scale + v.translateY };
}

/** screen → world: the inverse used for hit-testing + editing under zoom. */
export function screenToWorld(p: XY, v: CanvasTransformState): XY {
  return { x: (p.x - v.translateX) / v.scale, y: (p.y - v.translateY) / v.scale };
}

/**
 * Zoom toward a fixed screen anchor (mouse position, or screen centre as a
 * fallback). The world point under `anchor` stays pinned under it after the
 * scale change, so content does not drift while zooming. Scale is clamped.
 */
export function zoomAt(
  v: CanvasTransformState,
  anchor: XY,
  nextScaleRaw: number,
): CanvasTransformState {
  const scale = clampScale(nextScaleRaw);
  const world = screenToWorld(anchor, v); // world point currently under the anchor
  return {
    scale,
    translateX: anchor.x - world.x * scale,
    translateY: anchor.y - world.y * scale,
  };
}
