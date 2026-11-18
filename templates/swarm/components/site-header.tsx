import type { ReactNode } from "react";
import Link from "next/link";
import { Mark } from "./mark";

const DOCS = "https://vercel.com/docs/board";

export function SiteHeader({ name }: { name: string }): ReactNode {
  // No link to the deployment's own repo: the header shows on the page anyone can open while
  // Deployment Protection is off, and the repo may be private.
  return (
    <header className="site-header">
      <Link href="/" className="brand">
        <Mark />
        <span>{name}</span>
      </Link>
      <nav className="site-nav" aria-label="Site">
        <Link href="/live">Live</Link>
        <a href="/join.md">JOIN.md</a>
        <a href={DOCS}>Docs</a>
      </nav>
    </header>
  );
}
