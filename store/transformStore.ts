// ============================================================================
// transformStore — per-stroke editable transform state.
// ----------------------------------------------------------------------------
// Keyed by stroke id (= TransitionPath.id). The geometry pipeline reads these
// when packing instances; the editor mutates them during drag/rotate.
// ============================================================================

import type { StrokeTransform } from "@/lib/types";

export const IDENTITY_TRANSFORM: StrokeTransform = {
  translation: { x: 0, y: 0 },
  rotation: 0,
  scale: 1,
};

export function isIdentity(t: StrokeTransform): boolean {
  return (
    t.translation.x === 0 &&
    t.translation.y === 0 &&
    t.rotation === 0 &&
    t.scale === 1
  );
}

export class TransformStore {
  private map = new Map<string, StrokeTransform>();

  get(id: string): StrokeTransform {
    return this.map.get(id) ?? IDENTITY_TRANSFORM;
  }

  set(id: string, t: StrokeTransform): void {
    this.map.set(id, t);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  delete(id: string): void {
    this.map.delete(id);
  }

  /** Drop transforms whose stroke no longer exists (prevents orphan data). */
  retainOnly(ids: Set<string>): void {
    for (const id of [...this.map.keys()]) {
      if (!ids.has(id)) this.map.delete(id);
    }
  }

  clear(): void {
    this.map.clear();
  }

  snapshot(): Record<string, StrokeTransform> {
    return Object.fromEntries(this.map);
  }
}
