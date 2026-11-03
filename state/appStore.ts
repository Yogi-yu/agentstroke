// ============================================================================
// appStore (client) — agents (identity) + strokes, mirrored from the server.
// ----------------------------------------------------------------------------
// Single source of truth for the canvas + panels. Loads the agent roster and
// persisted strokes from the server, requests autonomous generation, and clears
// the canvas. (The GPU-side per-stroke geometry lives in state/strokeStore.ts.)
// ============================================================================

import { useSyncExternalStore } from "react";
import type { AgentProfile, StrokeTransform, TransitionPath } from "@/lib/types";
import { canvasRevisionOf, publishCanvasReset, subscribeCanvasReset } from "@/lib/canvasReset";

export interface AppSnapshot {
  agents: AgentProfile[];
  strokes: TransitionPath[];
  ready: boolean;
  generating: boolean;
  generationError: string;
  /** A failed database operation must remain visible until dismissed or retried. */
  storageError: string;
  /** A creative task is posted — attracting new agents over time. */
  funding: boolean;
  /** Total catalog size (ceiling on attractable agents). remaining = capacity - agents. */
  capacity: number;
  /** Changes on local or remote canvas reset so page-level editing UI can reset. */
  resetRevision: number;
  clearing: boolean;
}

const EMPTY: AppSnapshot = Object.freeze({
  agents: [], strokes: [], ready: false, generating: false, generationError: "", storageError: "", funding: false, capacity: 0, resetRevision: 0, clearing: false,
});

type Listener = () => void;

class AppStore {
  private agents: AgentProfile[] = [];
  private strokes: TransitionPath[] = [];
  private ready = false;
  private generating = false;
  private generationError = "";
  private storageError = "";
  private funding = false;
  private capacity = 0;
  private canvasRevision: number | null = null;
  private strokeEpoch = 0;
  private resetRevision = 0;
  private clearing = false;
  private resetSubscription: (() => void) | null = null;
  private fundTimer: ReturnType<typeof setTimeout> | null = null;

  private listeners = new Set<Listener>();
  private cached: AppSnapshot | null = null;
  /** Per-id debounce timers coalescing rapid transform writes (e.g. wheel resize). */
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private persistWaiters = new Map<string, Array<(saved: boolean) => void>>();
  private transformWrites = new Map<string, Promise<boolean>>();

  subscribe = (cb: Listener): (() => void) => {
    this.ensureResetSync();
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
        generationError: this.generationError,
        storageError: this.storageError,
        funding: this.funding,
        capacity: this.capacity,
        resetRevision: this.resetRevision,
        clearing: this.clearing,
      };
    }
    return this.cached;
  };

  getServerSnapshot = (): AppSnapshot => EMPTY;

  private emit(): void {
    this.cached = null;
    this.listeners.forEach((l) => l());
  }

  dismissStorageError(): void {
    this.storageError = "";
    this.emit();
  }

  private storageFailure(message: string): false {
    this.storageError = message;
    this.emit();
    return false;
  }

  private ensureResetSync(): void {
    if (!this.resetSubscription && typeof window !== "undefined") {
      this.resetSubscription = subscribeCanvasReset(({ canvasRevision }) => this.applyReset(canvasRevision));
    }
  }

  private invalidateStrokeRequests(): void {
    this.strokeEpoch++;
    this.generating = false;
    this.generationError = "";
    for (const timer of this.persistTimers.values()) clearTimeout(timer);
    this.persistTimers.clear();
    for (const waiters of this.persistWaiters.values()) waiters.forEach((resolve) => resolve(false));
    this.persistWaiters.clear();
  }

  private applyReset(revision: number): void {
    if (this.canvasRevision !== null && revision <= this.canvasRevision) return;
    this.canvasRevision = revision;
    this.invalidateStrokeRequests();
    this.strokes = [];
    this.resetRevision++;
    this.emit();
  }

  /** Authoritative reads may discover a reset performed in another browser tab. */
  private acceptServerRevision(value: unknown): boolean {
    const revision = canvasRevisionOf(value);
    if (revision === null) return true;
    if (this.canvasRevision !== null && revision < this.canvasRevision) return false;
    if (this.canvasRevision === null) this.canvasRevision = revision;
    else if (revision > this.canvasRevision) {
      this.applyReset(revision);
      publishCanvasReset(revision);
    }
    return true;
  }

  async bootstrap(): Promise<void> {
    this.ensureResetSync();
    if (this.clearing) return;
    const epoch = this.strokeEpoch;
    try {
      const [ar, sr] = await Promise.all([
        fetch("/api/agents", { cache: "no-store" }),
        fetch("/api/strokes", { cache: "no-store" }),
      ]);
      if (!ar.ok || !sr.ok) throw new Error("Could not load the canvas.");
      const [ad, sd] = await Promise.all([ar.json(), sr.json()]);
      this.agents = ad.agents ?? [];
      this.capacity = ad.capacity ?? this.agents.length;
      if (epoch === this.strokeEpoch && !this.clearing && this.acceptServerRevision(sd.canvasRevision)) {
        this.strokes = sd.strokes ?? [];
      }
    } catch {
      this.storageFailure("Could not load your saved canvas. Your last known view has been kept. Please reload to retry.");
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
      if (!r.ok) return this.storageFailure("Could not save the new agent. Please try again.");
      const d = await r.json();
      if (Array.isArray(d.agents)) this.agents = d.agents;
      if (typeof d.capacity === "number") this.capacity = d.capacity;
      this.emit();
      return !!d.agent;
    } catch {
      return this.storageFailure("Could not reach storage to add an agent. Please try again.");
    }
  }

  /**
   * Remove an agent from this visitor's available pool. Its artworks and their
   * original authorship remain on the canvas and in the archive.
   */
  async deleteAgent(id: string): Promise<boolean> {
    try {
      const r = await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) return this.storageFailure("Could not remove this agent. Your available agents have not changed.");
      const d = await r.json();
      this.agents = Array.isArray(d.agents) ? d.agents : this.agents.filter((a) => a.id !== id);
      if (typeof d.capacity === "number") this.capacity = d.capacity;
      this.emit();
      return true;
    } catch {
      return this.storageFailure("Could not confirm agent removal. Reload to check the saved state before retrying.");
    }
  }

  /** Clear the available-agent pool while preserving historical strokes. */
  async clearAgents(): Promise<boolean> {
    this.stopFunding();
    try {
      const r = await fetch("/api/agents", { method: "DELETE" });
      if (!r.ok) return this.storageFailure("Could not clear your available agents. Your pool has not changed.");
      const d = await r.json();
      this.agents = Array.isArray(d.agents) ? d.agents : [];
      if (typeof d.capacity === "number") this.capacity = d.capacity;
      this.emit();
      return true;
    } catch {
      return this.storageFailure("Could not confirm the agent pool update. Reload to check the saved state before retrying.");
    }
  }

  async refresh(): Promise<void> {
    this.ensureResetSync();
    if (this.clearing) return;
    const epoch = this.strokeEpoch;
    try {
      const sr = await fetch("/api/strokes", { cache: "no-store" });
      if (!sr.ok) { this.storageFailure("Your saved canvas could not be refreshed. The last known view is still displayed."); return; }
      const data = await sr.json();
      if (epoch !== this.strokeEpoch || this.clearing || !this.acceptServerRevision(data.canvasRevision)) return;
      this.strokes = data.strokes ?? this.strokes;
      this.emit();
    } catch {
      this.storageFailure("Storage is unreachable. The last known canvas is still displayed.");
    }
  }

  /** Compatibility entry point: old clients cannot impose endpoints anymore. */
  async generate(_from: string, _to: string, agentId?: string): Promise<void> {
    return this.generateAutonomous(agentId);
  }

  /** The agent chooses both endpoints and its complete, variable-length path. */
  async generateAutonomous(agentId?: string): Promise<void> {
    this.ensureResetSync();
    if (this.generating || this.clearing) return;
    const epoch = this.strokeEpoch;
    this.generating = true;
    this.generationError = "";
    this.emit();
    try {
      const r = await fetch("/api/generateStroke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "autonomous", agent_id: agentId, ...(this.canvasRevision !== null ? { canvasRevision: this.canvasRevision } : {}) }),
      });
      const d = await r.json();
      if (epoch !== this.strokeEpoch || !this.acceptServerRevision(d.canvasRevision)) return;
      if (r.ok && d.stroke) {
        this.strokes = [...this.strokes, d.stroke as TransitionPath];
        this.emit();
      } else {
        this.generationError = typeof d.error === "string" ? d.error : "The agent could not create a stroke. Please try again.";
      }
    } catch {
      if (epoch === this.strokeEpoch) this.generationError = "Could not reach the generation service. No local substitute was created. Check the canvas before trying again.";
    } finally {
      if (epoch === this.strokeEpoch) {
        this.generating = false;
        this.emit();
      }
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
  persistTransform(id: string, transform: StrokeTransform, immediately = false): Promise<boolean> {
    if (this.clearing) return Promise.resolve(false);
    const epoch = this.strokeEpoch;
    const prev = this.persistTimers.get(id);
    if (prev) clearTimeout(prev);
    const promise = new Promise<boolean>((resolve) => {
      this.persistWaiters.set(id, [...(this.persistWaiters.get(id) ?? []), resolve]);
    });
    const commit = () => {
      this.persistTimers.delete(id);
      const waiters = this.persistWaiters.get(id) ?? [];
      this.persistWaiters.delete(id);
      // Serialize writes for a stroke: a slow older PATCH cannot overwrite the
      // user's newer edit in the database.
      const previousWrite = this.transformWrites.get(id) ?? Promise.resolve(true);
      const write = previousWrite.then(async () => {
        if (epoch !== this.strokeEpoch || this.clearing || !this.strokes.some((s) => s.id === id)) return false;
        return this.writeTransform(id, transform, epoch);
      });
      this.transformWrites.set(id, write);
      void write.then((saved) => {
        waiters.forEach((resolve) => resolve(saved));
        if (this.transformWrites.get(id) === write) this.transformWrites.delete(id);
      });
    };
    if (immediately) commit();
    else this.persistTimers.set(id, setTimeout(commit, 200));
    return promise;
  }

  private async writeTransform(id: string, transform: StrokeTransform, epoch: number): Promise<boolean> {
    try {
      const response = await fetch("/api/strokes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, transform }),
      });
      if (!response.ok) return this.storageFailure("The stroke edit could not be saved. Its last saved position and size have been restored.");
      if (epoch !== this.strokeEpoch || this.clearing) return false;
      this.strokes = this.strokes.map((s) => s.id === id ? { ...s, transform } : s);
      this.emit();
      return true;
    } catch {
      return this.storageFailure("Could not confirm the stroke edit. The last confirmed view is restored; reload to check storage.");
    }
  }

  /**
   * Hide one stroke from this visitor's canvas after storage acknowledges it.
   * The original artwork remains recoverable through the archive.
   */
  async deleteStroke(id: string): Promise<boolean> {
    try {
      const response = await fetch(`/api/strokes?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) return this.storageFailure("Could not remove this stroke from the canvas. It is still displayed.");
      const data = await response.json();
      if (data.deleted !== true) return this.storageFailure("Stroke removal was not confirmed. The canvas has not changed.");
      this.strokes = this.strokes.filter((s) => s.id !== id);
      this.emit();
      return true;
    } catch {
      return this.storageFailure("Could not confirm stroke removal. Reload to check the saved canvas before retrying.");
    }
  }

  /** Restore a saved artwork without generating a replacement or changing its identity. */
  async restoreStroke(id: string): Promise<boolean> {
    if (this.clearing) return false;
    const epoch = this.strokeEpoch;
    try {
      const response = await fetch("/api/archive", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
      });
      const data = await response.json();
      if (!response.ok || !data.stroke) return this.storageFailure("Could not restore this artwork. Please try again.");
      if (epoch !== this.strokeEpoch || !this.acceptServerRevision(data.canvasRevision)) return false;
      this.strokes = [...this.strokes.filter((s) => s.id !== data.stroke.id), data.stroke];
      this.emit();
      return true;
    } catch {
      return this.storageFailure("Could not confirm restoration. Check the canvas before trying again.");
    }
  }

  /** Hide all visible strokes for this visitor. The archive and agents persist. */
  async clear(): Promise<boolean> {
    this.ensureResetSync();
    if (this.clearing) return false;
    this.clearing = true;
    this.invalidateStrokeRequests();
    this.emit();
    let cleared = false;
    try {
      const response = await fetch("/api/strokes", { method: "DELETE" });
      if (!response.ok) return this.storageFailure("Could not clear your canvas. The saved artworks and last known view have been kept.");
      const data = await response.json();
      const revision = canvasRevisionOf(data.canvasRevision);
      if (data.cleared !== true || revision === null) return this.storageFailure("Canvas clearing was not confirmed. Please reload to check the saved view.");
      this.applyReset(revision);
      publishCanvasReset(revision);
      cleared = true;
      return true;
    } catch {
      return this.storageFailure("Could not confirm canvas clearing. Please reload to check the saved view. Your archived artworks are kept.");
    } finally {
      this.clearing = false;
      this.emit();
      // A lost acknowledgement is uncertain; read the server, never retry DELETE.
      if (!cleared) void this.refresh();
    }
  }
}

export const appStore = new AppStore();

export function useApp(): AppSnapshot {
  return useSyncExternalStore(appStore.subscribe, appStore.getSnapshot, appStore.getServerSnapshot);
}
