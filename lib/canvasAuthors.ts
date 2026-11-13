import type { AgentProfile } from "@/lib/types";

/** Live membership must not change a saved work's rendering or attribution. */
export function canvasAuthors(agents: readonly AgentProfile[], authors: readonly AgentProfile[] = []): AgentProfile[] {
  return [...new Map([...agents, ...authors].map(agent => [agent.id, agent])).values()];
}
