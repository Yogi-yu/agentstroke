// ============================================================================
// agentProfiles — render-side agent indexing helper.
// ----------------------------------------------------------------------------
// The WebGL renderer keys per-agent selection/colour uniforms on a stable
// 0-based index derived from the `agent-NNN` id. (The real agent roster itself
// lives in lib/agents.ts.)
// ============================================================================

/** Stable 0-based index for an agent id (used by the renderer's shader uniforms). */
export function agentIndex(agentId: string): number {
  const n = Number(agentId.replace(/[^0-9]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
