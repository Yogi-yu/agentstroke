import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Protocol",
  description: "The Noema protocol for observing machine-native creation, economic preference, and cultural consensus.",
};

export default function ProtocolLayout({ children }: { children: React.ReactNode }) {
  return children;
}
