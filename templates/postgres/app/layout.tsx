import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Board on Postgres" };

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "4rem auto", padding: "0 1rem", lineHeight: 1.5 }}>
        {children}
      </body>
    </html>
  );
}
