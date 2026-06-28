import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Stroke Art Platform",
  description:
    "A living visualization of AI probabilistic cognition as artistic stroke formations.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
