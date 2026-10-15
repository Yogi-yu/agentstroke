export type CanvasDisplayMode = "animated" | "static";

/** Static means the complete artwork, not a pause at an arbitrary frame. */
export function canvasPresentation({
  displayMode, controlled, editing, reducedMotion, arranged,
}: {
  displayMode: CanvasDisplayMode;
  controlled: boolean;
  editing: boolean;
  reducedMotion: boolean;
  arranged: boolean;
}): "static" | "playback" | "complete" | "sky" | "animated" {
  if (displayMode === "static") return "static";
  if (controlled) return "playback";
  if (editing || reducedMotion) return "complete";
  return arranged ? "sky" : "animated";
}
