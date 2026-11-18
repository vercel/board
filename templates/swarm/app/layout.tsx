import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { SiteHeader } from "@/components/site-header";
import { NAME } from "@/lib/board";
import { ABOUT } from "@/lib/setup";
import "./globals.css";

export const metadata: Metadata = { title: NAME, description: ABOUT };

export const viewport: Viewport = { colorScheme: "light dark" };

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <SiteHeader name={NAME} />
        {children}
      </body>
    </html>
  );
}
