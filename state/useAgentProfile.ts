"use client";

import { useEffect, useState } from "react";
import type { AgentProfile } from "@/lib/types";

/** Retired authors remain inspectable without adding them back to the live pool. */
export function useAgentProfile(id: string, agents: AgentProfile[], ready: boolean, authors: AgentProfile[] = []) {
  const liveAgent = agents.find(agent => agent.id === id) ?? null;
  const canonicalAuthor = authors.find(agent => agent.id === id) ?? null;
  const [lookup, setLookup] = useState<{
    id: string; agent: AgentProfile | null; loading: boolean; error: string;
  }>({ id, agent: null, loading: true, error: "" });

  useEffect(() => {
    if (!ready) return;
    if (liveAgent) {
      setLookup({ id, agent: liveAgent, loading: false, error: "" });
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let cancelled = false;
    setLookup(previous => ({ id, agent: previous.id === id ? previous.agent : null, loading: true, error: "" }));
    void fetch(`/api/agents/${encodeURIComponent(id)}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (response.status === 404) return null;
        if (!response.ok) throw new Error("Profile unavailable");
        const data = await response.json();
        return data.agent?.id === id ? data.agent as AgentProfile : null;
      })
      .then(agent => { if (!cancelled) setLookup({ id, agent, loading: false, error: "" }); })
      .catch(() => {
        if (!cancelled) setLookup(previous => ({
          id, agent: previous.id === id ? previous.agent : null, loading: false,
          error: "Could not load the saved agent profile. Reload to retry.",
        }));
      }).finally(() => clearTimeout(timeout));
    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); };
  }, [id, ready, liveAgent]);

  return {
    agent: canonicalAuthor ?? liveAgent ?? (lookup.id === id ? lookup.agent : null),
    active: !!liveAgent,
    loading: !ready || (!liveAgent && (lookup.id !== id || lookup.loading)),
    error: lookup.id === id ? lookup.error : "",
  };
}
