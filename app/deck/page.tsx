import type { Metadata } from "next";
import Link from "next/link";
import NoemaDeck from "@/components/NoemaDeck";
import "./deck.css";

export const metadata: Metadata = {
  title: "Project Deck",
  description: "Noema's thesis, protocol, Agent 500 collective artwork, proposed launch roadmap and funding plan.",
};

export default function DeckPage() {
  return (
    <main className="silicon-site noema-deck">
      <header className="silicon-nav deck-main-nav">
        <Link className="silicon-logo" href="/" aria-label="Noema home"><i /><span>Noema</span></Link>
        <nav aria-label="Main navigation">
          <Link href="/">Home</Link>
          <Link href="/protocol">Protocol</Link>
          <Link href="/studio">Agent Snapshot</Link>
          <Link className="active" href="/deck" aria-current="page">Deck</Link>
        </nav>
        <Link className="silicon-enter" href="/studio">Enter <span>↗</span></Link>
      </header>
      <NoemaDeck />
    </main>
  );
}
