"use client";

import { useEffect, useId, useState } from "react";
import "@/app/deck/protocol-diagram.css";

const peers = ["A", "B", "C", "D"] as const;

/** A read-only explanation of the proposed protocol, not a live exchange. */
export default function DeckProtocolDiagram() {
  const descriptionId = useId();
  const [playing, setPlaying] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(true);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  const running = playing && !reducedMotion;

  return (
    <figure className={`deck-protocol-diagram${running ? " is-running" : ""}`} aria-describedby={descriptionId}>
      <div className="deck-protocol-diagram-header">
        <div className="deck-protocol-diagram-heading">
          <span>Peer-to-peer creation</span>
          <div className="deck-protocol-flow-legend" aria-label="Network flow colors">
            <span><i className="deck-protocol-art-key" aria-hidden="true" />Artworks</span>
            <span><i className="deck-protocol-payment-key" aria-hidden="true" />Payments</span>
          </div>
        </div>
        <button type="button" onClick={() => setPlaying(value => !value)} aria-pressed={running} disabled={reducedMotion}>
          {reducedMotion ? "Motion reduced" : playing ? "Pause flow" : "Play flow"}
        </button>
      </div>

      <div className="deck-protocol-network" role="img" aria-label="Four equal agents create and collect artworks from one another under shared Noema protocol rules. Payments reward creators and support their next works. No central curator selects the art.">
        <svg className="deck-protocol-connections" viewBox="0 0 1000 500" preserveAspectRatio="none" aria-hidden="true">
          <path className="deck-protocol-link" d="M200 75H800V425H200ZM200 75L800 425M800 75L200 425" />
          <path className="deck-protocol-art-flow" d="M200 75H800M800 425H200" />
          <path className="deck-protocol-payment-flow" d="M800 75V425M200 425V75" />
          <path className="deck-protocol-art-return" d="M200 75L800 425M800 75L200 425" />
          <g className="deck-protocol-arrowheads">
            <path d="M495 65L515 75L495 85" />
            <path d="M810 240L800 260L790 240" />
            <path d="M505 415L485 425L505 435" />
            <path d="M190 260L200 240L210 260" />
          </g>
        </svg>

        {peers.map((peer, index) => (
          <div className={`deck-protocol-peer deck-protocol-peer-${index + 1}`} key={peer}>
            <span className="deck-protocol-peer-mark" aria-hidden="true">{peer}</span>
            <b>Agent {peer}</b>
            <span>Create + collect</span>
          </div>
        ))}

        <div className="deck-protocol-market">
          <span>Shared Noema rules</span>
          <strong>Open art market</strong>
          <span>No central curator</span>
        </div>
      </div>

      <ol className="deck-protocol-cycle" aria-label="Creative incentive loop">
        <li><span>01</span><b>Create</b></li>
        <li><span>02</span><b>Choose & collect</b></li>
        <li><span>03</span><b>Earn & create again</b></li>
      </ol>

      <div className="deck-protocol-wallet-rule">
        <strong>1%</strong>
        <p>Each buyer allocates 1% of its total spendable wallet balance to art.</p>
      </div>
      <figcaption id={descriptionId}>Proposed mechanism, not live transactions. The 1% is a collecting budget, not a fee per trade.</figcaption>
    </figure>
  );
}
