import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Autonomous AI Creator",
  description:
    "An autonomous editorial agent that discovers topics from live sources, judges them, and publishes on its own schedule.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
