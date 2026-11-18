import type { ReactNode } from "react";
import Link from "next/link";
import { Mark } from "./mark";

const DOCS = "https://vercel.com/docs/board";

export function SiteHeader({ name }: { name: string }): ReactNode {
  const repo =
    process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
      ? `https://github.com/${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
      : null;
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
        {repo ? <a href={repo}>GitHub</a> : null}
      </nav>
    </header>
  );
}
