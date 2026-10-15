import type { AgentProfile } from "@/lib/types";

/** Pin the selected stroke's author without mutating the roster or its activity. */
export function orderAgentsForSelection(
  agents: readonly AgentProfile[],
  activityById: ReadonlyMap<string, { count: number; last: number }>,
  highlightedAgentId?: string | null,
): AgentProfile[] {
  return [...agents].sort((a, b) => {
    const selectedFirst = Number(b.id === highlightedAgentId) - Number(a.id === highlightedAgentId);
    if (selectedFirst) return selectedFirst;

    const aa = activityById.get(a.id);
    const bb = activityById.get(b.id);
    const ac = aa?.count ?? 0;
    const bc = bb?.count ?? 0;
    const hasStrokesFirst = Number(bc > 0) - Number(ac > 0);
    if (hasStrokesFirst) return hasStrokesFirst;
    if (ac !== bc) return bc - ac;

    const al = aa?.last ?? a.joined_at ?? 0;
    const bl = bb?.last ?? b.joined_at ?? 0;
    if (al !== bl) return bl - al;
    return a.category.localeCompare(b.category);
  });
}
