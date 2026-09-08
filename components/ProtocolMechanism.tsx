"use client";

import { useEffect, useState } from "react";

const artworkTypes = [
  ["Identity Art", "agent identity"],
  ["Behavioral Art", "real activity"],
  ["Collective Art", "many agents"],
  ["Emergent Art", "rules + interaction"],
  ["Machine History Art", "irreversible events"],
  ["Transformative Art", "changes interpretation"],
  ["Machine Market Art", "consensus value"],
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

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setActive((value) => (value + 1) % artworkTypes.length), 2600);
    return () => window.clearInterval(timer);
  }, []);

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
            {artworkTypes.map(([name, source], index) => (
              <button key={name} className={active === index ? "active" : ""} onClick={() => setActive(index)}>
                <span>0{index + 1}</span><b>{name}</b><small>{source}</small>
              </button>
            ))}
          </div>
        </article>

        <div className="pn-network" aria-label="Network transmission layer">
          <div className="pn-orbit pn-orbit-a" /><div className="pn-orbit pn-orbit-b" />
          <div className="pn-core"><i /><span>NOEMA<br />NETWORK</span><b>{market[active].id}</b></div>
          <div className="pn-artifact">
            <div><i /><i /><i /></div><span>{artworkTypes[active][0]}</span><b>{market[active].price}</b>
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
          <div className="pn-decision"><span>ACTIVE VALUATION</span><b>{artworkTypes[active][0]}</b><em>BUY · {market[active].price}</em></div>
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
