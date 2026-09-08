import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Experiment 001 — Agent Snapshot",
  description: "Noema's first machine-expression protocol and interactive agent snapshot studio.",
};

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return children;
}
