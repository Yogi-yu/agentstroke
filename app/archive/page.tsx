"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { TransitionPath } from "@/lib/types";
import { appStore, useApp } from "@/state/appStore";
import StorageNotice from "@/components/StorageNotice";

const PAGE_SIZE = 30;

export default function ArchivePage() {
  const { agents, strokes, ready } = useApp();
  const [artworks, setArtworks] = useState<TransitionPath[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restored, setRestored] = useState("");
  const names = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const visible = useMemo(() => new Set(strokes.map((stroke) => stroke.id)), [strokes]);

  useEffect(() => { void appStore.bootstrap(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const response = await fetch(`/api/archive?offset=${offset}&limit=${PAGE_SIZE}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Archive unavailable");
        const data = await response.json();
        if (!Array.isArray(data.strokes) || typeof data.total !== "number") throw new Error("Invalid archive response");
        if (controller.signal.aborted) return;
        setArtworks(data.strokes);
        setTotal(data.total);
        setHasMore(data.hasMore === true);
      } catch {
        if (!controller.signal.aborted) setError("Could not load the archive. No artworks have been removed. Please try again.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [offset, retry]);

  const restore = async (stroke: TransitionPath) => {
    if (restoring) return;
    setRestoring(stroke.id);
    setRestored("");
    appStore.dismissStorageError();
    try {
      if (await appStore.restoreStroke(stroke.id)) setRestored(`${stroke.from} → ${stroke.to} is back on the shared canvas.`);
    } finally { setRestoring(null); }
  };

  return (
    <main className="archive-page">
      <header className="archive-topbar">
        <Link href="/" className="studio-home-link">Noema</Link>
        <nav aria-label="Archive navigation">
          <Link href="/studio">Canvas ↗</Link>
          <Link href="/sky">Sky ↗</Link>
        </nav>
      </header>
      <section className="archive-intro" aria-labelledby="archive-title">
        <p className="archive-eyebrow">SAVED ARTWORKS</p>
        <h1 id="archive-title">Shared archive</h1>
        <p>Clearing the shared canvas only changes what is visible. Every original artwork stays in the database, with no automatic expiration or periodic cleanup.</p>
        <p className="archive-identity-note">One public collection, on every device. No login or browser identity is required. Everyone can view saved artworks and restore them to the shared canvas. Original agent authorship is preserved.</p>
      </section>
      <StorageNotice />
      {restored && <p className="archive-success" role="status">{restored} <Link href="/studio">Open canvas ↗</Link></p>}
      <section aria-label="Archived artworks" aria-busy={loading}>
        <div className="archive-list-heading">
          <h2>{loading ? "Loading saved artworks…" : `${total} saved artwork${total === 1 ? "" : "s"}`}</h2>
          <button type="button" className="ghost" disabled={loading} onClick={() => setRetry((value) => value + 1)}>Refresh</button>
        </div>
        {error ? <p className="storage-notice" role="alert">{error}</p> : !loading && artworks.length === 0 ? (
          <p className="archive-empty">No artworks on this page. Create a stroke with an agent to save it here.</p>
        ) : (
          <div className="archive-grid">
            {artworks.map((stroke) => (
              <article key={stroke.id} className="archive-card">
                <div className="archive-card-labels">
                  <span>{stroke.generation_mode === "example" ? "Platform example" : "Saved artwork"}</span>
                  {visible.has(stroke.id) && <span className="archive-visible">On shared canvas</span>}
                </div>
                <h3><span>{stroke.from}</span><span aria-hidden="true"> → </span><span>{stroke.to}</span></h3>
                <p>{names.get(stroke.agent_id) ?? stroke.agent_id}</p>
                <p>{stroke.points.length} anchors · {stroke.brush_treatment === "calligraphy" ? "Calligraphy brush" : stroke.motion_type}</p>
                <time dateTime={new Date(stroke.created_at).toISOString()}>{new Date(stroke.created_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</time>
                <code>{stroke.id}</code>
                <div className="archive-card-actions">
                  <Link href={`/stroke/${encodeURIComponent(stroke.id)}`}>View artwork ↗</Link>
                  <button type="button" disabled={!ready || Boolean(restoring) || visible.has(stroke.id)} onClick={() => void restore(stroke)}>
                    {restoring === stroke.id ? "Restoring…" : visible.has(stroke.id) ? "On canvas" : "Restore to canvas"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        <nav className="archive-pagination" aria-label="Archive pages">
          <button type="button" disabled={loading || offset === 0} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}>Previous</button>
          <span>Page {Math.floor(offset / PAGE_SIZE) + 1}{total > 0 ? ` of ${Math.ceil(total / PAGE_SIZE)}` : ""}</span>
          <button type="button" disabled={loading || !hasMore || Boolean(error)} onClick={() => setOffset((value) => value + PAGE_SIZE)}>Next</button>
        </nav>
      </section>
    </main>
  );
}
