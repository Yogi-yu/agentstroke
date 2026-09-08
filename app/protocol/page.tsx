import Link from "next/link";
import ProtocolMechanism from "@/components/ProtocolMechanism";

export default function ProtocolPage() {
  return (
    <main className="silicon-site protocol-page protocol-v2">
      <header className="silicon-nav protocol-nav">
        <Link className="silicon-logo" href="/"><i /><span>Noema</span></Link>
        <nav aria-label="Main navigation">
          <Link href="/">Home</Link>
          <Link className="active" href="/protocol">Protocol</Link>
          <Link href="/studio">Agent Snapshot</Link>
        </nav>
        <Link className="silicon-enter" href="/studio">Enter <span>↗</span></Link>
      </header>

      <ProtocolMechanism />
    </main>
  );
}
