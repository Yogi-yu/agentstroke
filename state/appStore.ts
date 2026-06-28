// ============================================================================
// appStore (client) — agents (identity) + strokes, mirrored from the server.
// ----------------------------------------------------------------------------
// Single source of truth for the canvas + panels. Loads the agent roster and
// persisted strokes from the server, requests A→B stroke generation, and clears
// the canvas. (The GPU-side per-stroke geometry lives in state/strokeStore.ts.)
// ============================================================================

import { useSyncExternalStore } from "react";
import type { AgentProfile, StrokeTransform, TransitionPath } from "@/lib/types";

export interface AppSnapshot {
  agents: AgentProfile[];
  strokes: TransitionPath[];
  ready: boolean;
  generating: boolean;
  /** A creative task is posted — attracting new agents over time. */
  funding: boolean;
  /** Total catalog size (ceiling on attractable agents). remaining = capacity - agents. */
  capacity: number;
}

const EMPTY: AppSnapshot = Object.freeze({
  agents: [], strokes: [], ready: false, generating: false, funding: false, capacity: 0,
});

type Listener = () => void;

class AppStore {
  private agents: AgentProfile[] = [];
  private strokes: TransitionPath[] = [];
  private ready = false;
  private generating = false;
  private funding = false;
  private capacity = 0;
  private fundTimer: ReturnType<typeof setTimeout> | null = null;

  private listeners = new Set<Listener>();
  private cached: AppSnapshot | null = null;
  /** Per-id debounce timers coalescing rapid transform writes (e.g. wheel resize). */
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  };

  getSnapshot = (): AppSnapshot => {
    if (!this.cached) {
      this.cached = {
        agents: this.agents,
        strokes: this.strokes,
        ready: this.ready,
        generating: this.generating,
        funding: this.funding,
        capacity: this.capacity,
      };
    }
    return this.cached;
  };

  getServerSnapshot = (): AppSnapshot => EMPTY;

  private emit(): void {
    this.cached = null;
    this.listeners.forEach((l) => l());
  }

  async bootstrap(): Promise<void> {
    try {
      const [ar, sr] = await Promise.all([
        fetch("/api/agents", { cache: "no-store" }),
        fetch("/api/strokes", { cache: "no-store" }),
      ]);
      const ad = await ar.json();
      this.agents = ad.agents ?? [];
      this.capacity = ad.capacity ?? this.agents.length;
      this.strokes = (await sr.json()).strokes ?? [];
    } catch {
      /* offline → empty */
    }
    this.ready = true;
    this.emit();
  }

  // ---- agents (server is the source of truth; we mirror its responses) ------

  /**
   * Post a creative task: arm/disarm the incentive that attracts agents over
   * time. While active, attract a new agent every 5–15s until the catalog is
   * exhausted (each attraction is a server POST → we re-sync from its response).
   */
  toggleFunding(): void {
    if (this.funding) this.stopFunding();
    else this.startFunding();
  }

  private startFunding(): void {
    if (this.funding) return;
    if (this.agents.length >= this.capacity) return; // nothing left to attract
    this.funding = true;
    this.emit();
    this.scheduleAttract();
  }

  private stopFunding(): void {
    if (!this.funding && !this.fundTimer) return;
    this.funding = false;
    if (this.fundTimer) { clearTimeout(this.fundTimer); this.fundTimer = null; }
    this.emit();
  }

  private scheduleAttract(): void {
    const delay = 5000 + Math.random() * 10000; // 5–15s
    this.fundTimer = setTimeout(async () => {
      this.fundTimer = null;
      await this.attractAgent();
      if (this.funding && this.agents.length < this.capacity) this.scheduleAttract();
      else if (this.funding) this.stopFunding(); // exhausted → wind down
    }, delay);
  }

  /** Attract one new agent via the server (POST). Re-syncs the list from the response. */
  async attractAgent(): Promise<boolean> {
    try {
      const r = await fetch("/api/agents", { method: "POST" });
      if (!r.ok) return false;
      const d = await r.json();
      if (Array.isArray(d.agents)) this.agents = d.agents;
      if (typeof d.capacity === "number") this.capacity = d.capacity;
      this.emit();
      return !!d.agent;
    } catch {
      return false;
    }
  }

  /**
   * Delete an agent on the server (DELETE /api/agents/:id), then re-sync. The
   * server cascade-removes the agent's strokes; we mirror that locally so the
   * canvas + all dependent UI drop it immediately.
   */
  async deleteAgent(id: string): Promise<void> {
    let agents: AgentProfile[] | null = null;
    let capacity: number | null = null;
    try {
      const r = await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d.agents)) agents = d.agents;
        if (typeof d.capacity === "number") capacity = d.capacity;
      }
    } catch {
      /* fall back to optimistic local removal below */
    }
    this.agents = agents ?? this.agents.filter((a) => a.id !== id);
    if (capacity !== null) this.capacity = capacity;
    // cascade: drop this agent's strokes from the local mirror (server already did)
    this.strokes = this.strokes.filter((s) => s.agent_id !== id);
    this.emit();
  }

  async refresh(): Promise<void> {
    try {
      const sr = await fetch("/api/strokes", { cache: "no-store" });
      this.strokes = (await sr.json()).strokes ?? this.strokes;
      this.emit();
    } catch {
      /* keep last-known */
    }
  }

  /** Generate one A→B stroke (optionally by a specific agent) and append it. */
  async generate(from: string, to: string, agentId?: string): Promise<void> {
    if (!from.trim() || !to.trim() || this.generating) return;
    this.generating = true;
    this.emit();
    try {
      const r = await fetch("/api/generateStroke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: from.trim(), to: to.trim(), agent_id: agentId }),
      });
      const d = await r.json();
      if (r.ok && d.stroke) this.strokes = [...this.strokes, d.stroke as TransitionPath];
    } finally {
      this.generating = false;
      this.emit();
    }
  }

  /**
   * Persist a stroke's edit-mode transform (Issue 2 — write-back). DEBOUNCED per
   * id (200ms) so a rapid gesture — e.g. wheel-resizing a stroke — coalesces into
   * a single strokes-array update + emit + PATCH instead of one per event (which
   * would trigger a full canvas geometry rebuild on every wheel tick). The live
   * visual already comes from the incremental GPU update in the StrokeStore, and
   * the page's `transforms` mirror is updated synchronously by onTransformCommit,
   * so Save & Exit always reads the latest value even before this fires.
   */
  persistTransform(id: string, transform: StrokeTransform): void {
    const prev = this.persistTimers.get(id);
    if (prev) clearTimeout(prev);
    this.persistTimers.set(
      id,
      setTimeout(() => {
        this.persistTimers.delete(id);
        const i = this.strokes.findIndex((s) => s.id === id);
        if (i === -1) return;
        this.strokes = this.strokes.map((s) => (s.id === id ? { ...s, transform } : s));
        this.emit();
        void this.writeTransform(id, transform);
      }, 200),
    );
  }

  private async writeTransform(id: string, transform: StrokeTransform): Promise<void> {
    try {
      await fetch("/api/strokes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, transform }),
      });
    } catch {
      /* keep optimistic local state */
    }
  }

  /**
   * Delete ONE stroke GLOBALLY (Issue 1). Removes it from the client mirror —
   * which cascades into the GPU store, hitmap, transform store, and render
   * pipeline on the next setData — and from server persistence so it stays gone.
   */
  async deleteStroke(id: string): Promise<void> {
    const before = this.strokes;
    this.strokes = before.filter((s) => s.id !== id);
    if (this.strokes === before) return;
    this.emit();
    try {
      await fetch(`/api/strokes?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch {
      /* ignore — local removal already applied */
    }
  }

  /** Clear all strokes (canvas reset). Agent identities persist. */
  async clear(): Promise<void> {
    this.strokes = [];
    this.emit();
    try {
      await fetch("/api/strokes", { method: "DELETE" });
    } catch {
      /* ignore */
    }
  }
}

export const appStore = new AppStore();

export function useApp(): AppSnapshot {
  return useSyncExternalStore(appStore.subscribe, appStore.getSnapshot, appStore.getServerSnapshot);
}
