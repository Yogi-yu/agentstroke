"use client";

// ============================================================================
// AgentDetailMobile — a FULL-SCREEN INTERACTION CANVAS SYSTEM (mobile only).
// ----------------------------------------------------------------------------
// NOT the desktop 3-column document layout. The canvas is the full-viewport
// primary interaction layer; chrome floats over it as overlays whose CONTAINERS
// are pointer-events:none (so taps fall through to the canvas) and whose actual
// controls are pointer-events:auto. "Create Stroke" lives in a sticky action
// bar that is always visible; agent info is a collapsed accordion.
//
// Reads from appStore (which the parent route bootstraps) — single source of truth.
// ============================================================================

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import CanvasView from "@/components/CanvasView";
import AgentCreationForm from "@/components/AgentCreationForm";
import AgentChatPanel from "@/components/AgentChatPanel";
import type { Agent } from "@/lib/types";
import { agentRenderStyle, categoryLabel } from "@/lib/agents";
import { modelSpec } from "@/lib/openrouter/models";
import { appStore, useApp } from "@/state/appStore";

const noop = () => {};

export default function AgentDetailMobile({ id }: { id: string }) {
  const router = useRouter();
  const { agents, strokes, ready, generating } = useApp();
  const agent = agents.find((a) => a.id === id) ?? null;
  const agentStrokes = strokes.filter((s) => s.agent_id === id);
  const renderAgents: Agent[] = agent ? [{ id: agent.id, style: agentRenderStyle(agent.category) }] : [];

  const [infoOpen, setInfoOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [confirmDeleteAgent, setConfirmDeleteAgent] = useState(false);

  const onCreate = (from: string, to: string) => {
    if (!agent) return;
    void appStore.generate(from, to, agent.id);
    setSheetOpen(false);
  };

  return (
    <div className="adm">
      {/* SECTION 3 — CANVAS: full-screen primary interaction layer */}
      <div className="adm-canvas">
        <CanvasView
          paths={agentStrokes}
          agents={renderAgents}
          selectedStrokeId={null}
          filterAgentId={null}
          editMode={false}
          onSelectStroke={noop}
          onTransformCommit={noop}
        />
      </div>

      {/* SECTION 1 — TOP BAR (overlay; container does NOT block the canvas) */}
      <div className="adm-topbar">
        <Link href="/studio" className="adm-btn adm-back" aria-label="Back to studio">←</Link>
        <div className="adm-title">
          <span className="adm-name">{agent?.name ?? id}</span>
          <span className="adm-model">
            {agent ? modelSpec(agent.model).label : ready ? "agent not found" : "loading…"}
          </span>
        </div>
        <button
          className="adm-btn adm-info-toggle"
          onClick={() => setChatOpen(true)}
          disabled={!agent}
          aria-label="Open chat"
        >
          💬
        </button>
        <button
          className="adm-btn adm-info-toggle"
          onClick={() => setInfoOpen((v) => !v)}
          aria-expanded={infoOpen}
          disabled={!agent}
        >
          {infoOpen ? "Close" : "Info"}
        </button>
      </div>

      {/* SECTION 4 — INFO ACCORDION (collapsed by default) */}
      {infoOpen && agent && (
        <div className="adm-info">
          <div className="adm-info-row"><span>occupation</span><p>{agent.occupation}</p></div>
          <div className="adm-info-row"><span>category</span><p>{categoryLabel(agent.category)}</p></div>
          <div className="adm-info-row"><span>economic function</span><p>{agent.economic_function}</p></div>
          <div className="adm-info-row"><span>real-world mapping</span><p>{agent.real_world_mapping}</p></div>
          <div className="adm-info-row"><span>task domain</span><p>{agent.task_domain}</p></div>
          <div className="adm-info-row"><span>revenue impact</span><p>{agent.revenue_impact}</p></div>
          <div className="adm-info-row"><span>model</span><p>{modelSpec(agent.model).label} · {agent.model}</p></div>
          <div className="adm-info-row"><span>strokes</span><p>{agentStrokes.length}</p></div>
          <button className="btn danger adm-del" onClick={() => setConfirmDeleteAgent(true)}>🗑 Delete agent</button>
        </div>
      )}

      {/* SECTION 2 — STICKY ACTION BAR (always visible) */}
      <div className="adm-actionbar">
        <button className="adm-create" disabled={!agent} onClick={() => setSheetOpen(true)}>
          ✦ Create Stroke
        </button>
      </div>

      {/* Create sheet — A → B in agent context */}
      {sheetOpen && agent && (
        <div className="adm-sheet-overlay" onClick={() => setSheetOpen(false)}>
          <div className="adm-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="adm-sheet-grip" />
            <AgentCreationForm
              agentName={agent.name}
              generating={generating}
              onCreate={onCreate}
              onExit={() => setSheetOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Chat sheet — agent identity chat (mobile-enabled) */}
      {chatOpen && agent && (
        <div className="adm-chat-overlay" onClick={() => setChatOpen(false)}>
          <div className="adm-chat" onClick={(e) => e.stopPropagation()}>
            <div className="adm-chat-bar">
              <span className="adm-chat-title">Chat · {agent.name}</span>
              <button className="adm-btn adm-chat-close" onClick={() => setChatOpen(false)} aria-label="Close chat">✕</button>
            </div>
            <div className="adm-chat-body">
              <AgentChatPanel agentId={agent.id} agentName={agent.name} />
            </div>
          </div>
        </div>
      )}

      {/* Delete-agent confirmation */}
      {confirmDeleteAgent && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteAgent(false)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Delete agent?</h3>
            <p className="modal-body">
              This removes <b>{agent?.name ?? id}</b> and all of its strokes. This cannot be undone.
            </p>
            <div className="modal-actions">
              <button className="mini" onClick={() => setConfirmDeleteAgent(false)}>Cancel</button>
              <button
                className="mini reject danger"
                onClick={() => { void appStore.deleteAgent(id); setConfirmDeleteAgent(false); router.push("/"); }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
