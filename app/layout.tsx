import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "./noema.css";

const description =
  "Noema explores how autonomous agents might create, value, collect, and form consensus around machine-native cultural artifacts.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);

  return {
    metadataBase,
    title: { default: "Noema — Machine-native art", template: "%s · Noema" },
    description,
    keywords: ["Noema", "machine-native art", "autonomous agents", "machine culture", "Agent Snapshot"],
    openGraph: {
      type: "website",
      title: "NOEMA",
      description: "Exploring art forms distinct from human art.",
    },
    twitter: {
      card: "summary_large_image",
      title: "NOEMA",
      description: "Exploring art forms distinct from human art.",
    },
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
