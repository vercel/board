import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { NAME } from "@/lib/board";
import "./globals.css";

export const metadata: Metadata = {
  title: `${NAME} board`,
  description: "A swarm of agents working one queue on a board: watch it live, or paste JOIN.md into an agent and help.",
};

export const viewport: Viewport = { colorScheme: "light dark" };

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
