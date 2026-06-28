// ============================================================================
// StrokeEditor — drag / rotate gesture controller (normalized space).
// ----------------------------------------------------------------------------
// Translates pointer gestures into StrokeTransform updates and applies them to
// the StrokeStore (which recomputes the stroke's geometry block + hitmap and
// flags a dirty GPU range). The render loop flushes that range incrementally.
// ============================================================================

import type { StrokeStore } from "@/state/strokeStore";
import type { StrokeTransform } from "@/lib/types";
import { angleFrom, type XY } from "@/engine/strokeMutation";

type Mode = "none" | "drag" | "rotate";

export interface CommitResult {
  id: string;
  transform: StrokeTransform;
}

export class StrokeEditor {
  private store: StrokeStore;
  private mode: Mode = "none";
  private id: string | null = null;
  private base: StrokeTransform = { translation: { x: 0, y: 0 }, rotation: 0, scale: 1 };
  private startPointer: XY = { x: 0, y: 0 };
  private pivot: XY = { x: 0, y: 0 };
  private startAngle = 0;

  constructor(store: StrokeStore) {
    this.store = store;
  }

  get active(): boolean {
    return this.mode !== "none";
  }

  get target(): string | null {
    return this.id;
  }

  beginDrag(id: string, pointer: XY): void {
    this.mode = "drag";
    this.id = id;
    this.base = clone(this.store.transformOf(id));
    this.startPointer = { ...pointer };
  }

  beginRotate(id: string, pointer: XY): void {
    this.mode = "rotate";
    this.id = id;
    this.base = clone(this.store.transformOf(id));
    this.pivot = this.store.pivotOf(id) ?? { x: 0.5, y: 0.5 };
    this.startAngle = angleFrom(this.pivot, pointer);
  }

  move(pointer: XY): void {
    if (this.mode === "none" || !this.id) return;
    if (this.mode === "drag") {
      const dx = pointer.x - this.startPointer.x;
      const dy = pointer.y - this.startPointer.y;
      this.store.updateTransform(this.id, {
        ...this.base,
        translation: { x: this.base.translation.x + dx, y: this.base.translation.y + dy },
      });
    } else if (this.mode === "rotate") {
      const delta = angleFrom(this.pivot, pointer) - this.startAngle;
      this.store.updateTransform(this.id, { ...this.base, rotation: this.base.rotation + delta });
    }
  }

  end(): CommitResult | null {
    if (this.mode === "none" || !this.id) {
      this.mode = "none";
      return null;
    }
    const result: CommitResult = { id: this.id, transform: clone(this.store.transformOf(this.id)) };
    this.mode = "none";
    this.id = null;
    return result;
  }
}

function clone(t: StrokeTransform): StrokeTransform {
  return { translation: { x: t.translation.x, y: t.translation.y }, rotation: t.rotation, scale: t.scale };
}
