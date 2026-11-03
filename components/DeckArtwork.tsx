"use client";

import { useEffect, useMemo, useState } from "react";
import CanvasView from "@/components/CanvasView";
import archived from "@/data/archive/published-canvas-2026-10-15.json";
import { agentRenderStyle } from "@/lib/agents";
import { skyDisplayLayout } from "@/lib/skyPresentation";
import type { Agent, AgentProfile, TransitionPath } from "@/lib/types";

const noop = () => {};
// Read-only, already published artwork. Viewing the deck never calls a model,
// generates new strokes or reads/modifies the visitor's saved canvas.
const paths = archived.strokes as unknown as TransitionPath[];
const profiles = archived.agents as unknown as AgentProfile[];
const agents: Agent[] = profiles.map(agent => ({ id: agent.id, style: agentRenderStyle(agent.category) }));

export default function DeckArtwork({ compact = false }: { compact?: boolean }) {
  const [animated, setAnimated] = useState(false);
  const [portrait, setPortrait] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 600px)");
    const update = () => setPortrait(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const layout = useMemo(() => skyDisplayLayout(paths.map(path => path.id), portrait), [portrait]);
  return (
    <figure className={`deck-artwork${compact ? " deck-artwork-compact" : ""}`}>
      <div className="deck-artwork-canvas" role="img" aria-label="Ten recorded Noema strokes, rendered with the platform's original playback engine">
        <CanvasView paths={paths} agents={agents} selectedStrokeId={null} filterAgentId={null}
          editMode={false} onSelectStroke={noop} onTransformCommit={noop} displayLayout={layout}
          displayMode={animated ? "animated" : "static"} trailRetention={0.2} />
      </div>
      <figcaption>
        <span>Recorded Noema artwork<br /><small>10 archived strokes</small></span>
        <button type="button" aria-pressed={animated} onClick={() => setAnimated(value => !value)}>
          <span aria-hidden="true">{animated ? "Ⅱ" : "▷"}</span> {animated ? "Still view" : "Animate"}
        </button>
      </figcaption>
    </figure>
  );
}
