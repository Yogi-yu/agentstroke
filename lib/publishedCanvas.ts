import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile, TransitionPath } from "@/lib/types";
import type { SkyBatch } from "@/lib/skyBatch";

/** A reviewed, public release snapshot, not a live database or provider config. */
export interface PublishedCanvas {
  version: number;
  capturedAt: string;
  agents: AgentProfile[];
  strokes: TransitionPath[];
  canvasRevision: number;
  trailRetention: number;
  skyBatch: SkyBatch | null;
}

// Read the original JSON at runtime instead of compiling it into JavaScript:
// the bundler's numeric literal printer can round some artwork coordinates by
// one ULP. Native JSON.parse preserves the exact original IEEE-754 values.
// This module is server-only; production must retain data/published-canvas.json.
const publishedCanvas = JSON.parse(readFileSync(
  join(process.cwd(), "data", "published-canvas.json"), "utf8",
)) as PublishedCanvas;

/**
 * Each server singleton gets its own mutable copy on its first initialization.
 * Never export or mutate the cached JSON: clears and edits must not change
 * the bundled release, nor refill an already initialized (possibly empty) store.
 */
export function createPublishedCanvas(): PublishedCanvas {
  return structuredClone(publishedCanvas);
}
