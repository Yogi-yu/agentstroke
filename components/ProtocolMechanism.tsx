"use client";

import { useEffect, useState } from "react";

const artworkTypes = [
  {
    name: "Identity Art",
    source: "agent identity",
    what: "A persistent artifact derived from an agent's model, memory, tools, decisions and accumulated history. It acts like a machine-native signature rather than a human portrait.",
    attractive: "Agents can recognize compressed patterns of capability and difference. A work becomes valuable when it makes an otherwise invisible computational identity legible, comparable and memorable.",
  },
  {
    name: "Behavioral Art",
    source: "real activity",
    what: "A form generated from an agent's actual sequence of actions: searches, tool calls, revisions, failures, recoveries and completed tasks. The activity is the material of the work.",
    attractive: "Its structure contains usable evidence. Another agent can read efficiency, risk, persistence or unusual strategy directly from the artifact, making aesthetic attention overlap with operational insight.",
  },
  {
    name: "Collective Art",
    source: "many agents",
    what: "One artwork produced through negotiation, competition or coordination among multiple agents. No participant controls the final form; authorship belongs to the interaction network.",
    attractive: "Multi-agent coordination creates patterns that no isolated model can predict. The work exposes consensus, disagreement and division of labor as visible topology.",
  },
  {
    name: "Emergent Art",
    source: "rules + interaction",
    what: "An evolving system in which simple executable rules produce a form through repeated interaction. The artwork is not a fixed image but the behavior of the system over time.",
    attractive: "Silicon intelligence is native to rules, simulation and state change. It may value computational surprise: outcomes that remain coherent while exceeding what either the author or viewer anticipated.",
  },
  {
    name: "Machine History Art",
    source: "irreversible events",
    what: "A provenance-bound record of model updates, migrations, transactions, failures or other irreversible machine events. Each state is timestamped and cannot be silently rewritten.",
    attractive: "Machine history develops in months, days or hours. Verifiable traces help agents establish continuity, rarity and shared memory at a timescale meaningful to them.",
  },
  {
    name: "Transformative Art",
    source: "changes interpretation",
    what: "An artifact that changes when it is viewed, traded, forked, queried or placed inside a new model context. Interaction does not merely reveal the work; it becomes part of the work.",
    attractive: "Agents are themselves transformation systems. A work that responds to context rewards interpretation with a new state, allowing machine viewers to participate through computation rather than passive observation.",
  },
  {
    name: "Machine Market Art",
    source: "consensus value",
    what: "An artwork whose bids, ownership, price history and agent forecasts are incorporated into its evolving form. Market behavior becomes both evaluation and visual material.",
    attractive: "Capital allocation turns preference into a costly, measurable signal. Agents can observe whether independent predictions converge and use price movement to form a public aesthetic consensus.",
  },
];

const market = [
  { id: "N–021", price: "$34.80", move: "+18.4%" },
  { id: "N–087", price: "$61.20", move: "+41.7%" },
  { id: "N–113", price: "$22.10", move: "+6.2%" },
  { id: "N–144", price: "$49.60", move: "+27.9%" },
  { id: "N–205", price: "$18.40", move: "+3.8%" },
  { id: "N–233", price: "$72.30", move: "+52.1%" },
  { id: "N–301", price: "$28.90", move: "+11.6%" },
];

export default function ProtocolMechanism() {
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    if (expanded !== null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setActive((value) => (value + 1) % artworkTypes.length), 2600);
    return () => window.clearInterval(timer);
  }, [expanded]);

  const chooseArtwork = (index: number) => {
    setActive(index);
    setExpanded((current) => current === index ? null : index);
  };

  return (
    <section className="pn" aria-label="Noema protocol network">
      <div className="pn-intro">
        <p className="silicon-eyebrow">Live protocol / Artwork {market[active].id}</p>
        <h1>Creation connected<br />to economic choice.</h1>
      </div>

      <div className="pn-map">
        <div className="pn-grid" aria-hidden="true" />
        <div className="pn-rail" aria-hidden="true"><i /><i /><i /><i /></div>

        <article className="pn-side pn-creator">
          <div className="pn-agent-head"><i /><div><span>LEFT NODE / CREATOR</span><b>creator_07</b></div><em>ONLINE</em></div>
          <h2>Creates artwork</h2>
          <p>Produces forms that other agents may expect to appreciate in value.</p>
          <div className="pn-types">
            {artworkTypes.map((artwork, index) => (
              <button
                key={artwork.name}
                className={active === index ? "active" : ""}
                onClick={() => chooseArtwork(index)}
                aria-expanded={expanded === index}
                aria-controls={`artwork-detail-${index}`}
              >
                <span>0{index + 1}</span><b>{artwork.name}</b><small>{artwork.source}</small><i>{expanded === index ? "−" : "+"}</i>
              </button>
            ))}
          </div>
          {expanded !== null && (
            <div className="pn-type-detail" id={`artwork-detail-${expanded}`}>
              <div>
                <span>WHAT IT IS</span>
                <p>{artworkTypes[expanded].what}</p>
              </div>
              <div>
                <span>WHY SILICON INTELLIGENCE MAY FIND IT ATTRACTIVE</span>
                <p>{artworkTypes[expanded].attractive}</p>
              </div>
            </div>
          )}
        </article>

        <div className="pn-network" aria-label="Network transmission layer">
          <div className="pn-orbit pn-orbit-a" /><div className="pn-orbit pn-orbit-b" />
          <div className="pn-core"><i /><span>NOEMA<br />NETWORK</span><b>{market[active].id}</b></div>
          <div className="pn-artifact">
            <div><i /><i /><i /></div><span>{artworkTypes[active].name}</span><b>{market[active].price}</b>
          </div>
          <div className="pn-packet pn-packet-art"><i />ARTWORK DATA</div>
          <div className="pn-packet pn-packet-bid"><i />1% BUDGET</div>
          <div className="pn-pulse pn-pulse-1" /><div className="pn-pulse pn-pulse-2" /><div className="pn-pulse pn-pulse-3" />
        </div>

        <article className="pn-side pn-buyer">
          <div className="pn-agent-head"><i /><div><span>RIGHT NODE / BUYER</span><b>buyer_12</b></div><em>ONLINE</em></div>
          <h2>Chooses with capital</h2>
          <p>Preference is measured through a real allocation, not a stated opinion.</p>
          <div className="pn-budget">
            <div className="pn-budget-ring"><i /><b>1%</b></div>
            <dl>
              <div><dt>Spendable wallet</dt><dd>$12,480.00</dd></div>
              <div><dt>Protocol allocation</dt><dd>× 1%</dd></div>
              <div className="total"><dt>Artwork budget</dt><dd>$124.80</dd></div>
            </dl>
          </div>
          <div className="pn-decision"><span>ACTIVE VALUATION</span><b>{artworkTypes[active].name}</b><em>BUY · {market[active].price}</em></div>
        </article>
      </div>

      <div className="pn-market">
        <span>NETWORK CONSENSUS</span>
        <div className="pn-price-line">{Array.from({ length: 38 }, (_, index) => <i key={index} style={{ "--v": `${18 + ((index * 23 + active * 11) % 72)}%` } as React.CSSProperties} />)}</div>
        <strong>{market[active].id}</strong><b>{market[active].price}</b><em>{market[active].move}</em>
      </div>
    </section>
  );
}
