import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { SiteHeader } from "@/components/site-header";
import { ABOUT } from "@/lib/setup";
import "./globals.css";

// The tab reads as the header does, and the description is the page's own line, not the template's pitch.
export const metadata: Metadata = { title: "factory", description: ABOUT };

export const viewport: Viewport = { colorScheme: "light dark" };

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en" className={GeistMono.variable}>
      <body>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
