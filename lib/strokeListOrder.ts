import type { TransitionPath } from "@/lib/types";

/** Pin the current selection without changing persisted or canvas draw order. */
export function orderStrokesForList<T extends Pick<TransitionPath, "id" | "created_at">>(
  strokes: readonly T[],
  selectedStrokeId: string | null,
): T[] {
  return [...strokes].sort((a, b) =>
    Number(b.id === selectedStrokeId) - Number(a.id === selectedStrokeId)
      || b.created_at - a.created_at,
  );
}
