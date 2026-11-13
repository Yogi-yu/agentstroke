/** Public policy; safe to import in server code and client status panels. */
export const AGENT_POOL_MIN = 30;
export const AGENT_POOL_TARGET = 40;
export const AGENT_POOL_MAX = 50;
export const AGENT_IDLE_TIMEOUT_MS = 10 * 60_000;
export const AUTO_STROKE_INTERVAL_MS = 5 * 60_000;
export const AUTOPILOT_TICK_MS = 30_000;
export const CANVAS_STROKE_LIMIT = 50;

export interface AutopilotStatus {
  enabled: boolean;
  running: boolean;
  generating: boolean;
  nextGenerationAt: number | null;
  lastTickAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastStrokeId: string | null;
  minAgents: number;
  targetAgents: number;
  maxAgents: number;
  idleTimeoutMs: number;
  generationIntervalMs: number;
  canvasLimit: number;
  mode: "while-service-running";
}
