/** Browser-only notifications; importing this module during SSR is harmless. */
export const CANVAS_RESET_EVENT = "noema:canvas-reset";
export const CANVAS_RESET_STORAGE = "noema:canvas-reset-signal";

export interface CanvasResetSignal {
  canvasRevision: number;
  id: string;
}

export function canvasRevisionOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseSignal(value: unknown): CanvasResetSignal | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CanvasResetSignal>;
  const canvasRevision = canvasRevisionOf(candidate.canvasRevision);
  return canvasRevision !== null && typeof candidate.id === "string"
    ? { canvasRevision, id: candidate.id } : null;
}

/** The custom event reaches this tab; storage reaches other same-origin tabs. */
export function publishCanvasReset(canvasRevision: number): void {
  if (typeof window === "undefined" || canvasRevisionOf(canvasRevision) === null) return;
  const signal: CanvasResetSignal = { canvasRevision, id: `${canvasRevision}:${Date.now()}:${Math.random().toString(36).slice(2)}` };
  window.dispatchEvent(new CustomEvent(CANVAS_RESET_EVENT, { detail: signal }));
  try { window.localStorage.setItem(CANVAS_RESET_STORAGE, JSON.stringify(signal)); } catch { /* Focus/poll recovery still works without storage. */ }
}

/** Events never issue another DELETE or POST. Consumers ignore stale revisions. */
export function subscribeCanvasReset(listener: (signal: CanvasResetSignal) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const browser = window;
  let lastRevision = -1;
  const deliver = (value: unknown) => {
    const signal = parseSignal(value);
    if (!signal || signal.canvasRevision <= lastRevision) return;
    lastRevision = signal.canvasRevision;
    listener(signal);
  };
  const local = (event: Event) => deliver((event as CustomEvent).detail);
  const remote = (event: StorageEvent) => {
    if (event.key !== CANVAS_RESET_STORAGE || !event.newValue) return;
    try { deliver(JSON.parse(event.newValue)); } catch { /* Ignore malformed unrelated storage data. */ }
  };
  browser.addEventListener(CANVAS_RESET_EVENT, local);
  browser.addEventListener("storage", remote);
  return () => {
    browser.removeEventListener(CANVAS_RESET_EVENT, local);
    browser.removeEventListener("storage", remote);
  };
}
