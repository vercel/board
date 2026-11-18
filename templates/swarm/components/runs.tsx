"use client";

import type { ReactNode } from "react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { stop } from "@/app/actions";
import { ABOUT_SCENARIO } from "@/lib/config";
import type { Run } from "@/lib/runs";

/** Dollars as the page shows them: cents under $100, and a whole budget as it was typed. */
const money = (dollars: number) => `$${Number.isInteger(dollars) ? dollars : dollars < 100 ? dollars.toFixed(2) : dollars.toFixed(0)}`;

/** How long until a run's time limit, in words, from when it was made: the launch adds a minute or two. */
function left(run: Run, now: number): string | null {
  if (run.phase !== "running" && run.phase !== "preparing") return null;
  const deadline = run.prepared?.deadline ?? Date.parse(run.createdAt) + (run.config.minutes ?? 240) * 60_000;
  const minutes = Math.max(0, Math.round((deadline - now) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m left` : `${minutes}m left`;
}

function StopButton({ slug }: { slug: string }): ReactNode {
  const router = useRouter();
  const [pending, begin] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="link"
        disabled={pending}
        onClick={() =>
          begin(async () => {
            const result = await stop(slug);
            setProblem(result.ok ? null : result.problem);
            router.refresh();
          })
        }
      >
        {pending ? "Stopping" : "Stop"}
      </button>
      {problem ? <span className="bad">{problem}</span> : null}
    </>
  );
}

/** The latest runs: where each stands, what it has spent against its budget, and how to watch it or stop it. */
export function Runs({ runs, swarm, now }: { runs: Run[]; swarm: string; now: number }): ReactNode {
  if (runs.length === 0) return <p className="note">No runs yet. The first one shows here as soon as it&apos;s launched.</p>;
  return (
    <ul className="runs">
      {runs.map((run) => {
        const remaining = left(run, now);
        const budget = run.config.budgetUsd;
        return (
          <li key={run.slug} className="run" data-phase={run.phase}>
            <div className="run-head">
              <span className="phase">{run.phase}</span>
              <strong>{run.title}</strong>
            </div>
            <p className="run-meta">
              {run.config.repo} · {ABOUT_SCENARIO[run.config.scenario].label.toLowerCase()} · {run.config.model} · {run.config.agents} {run.config.agents === 1 ? "agent" : "agents"}
            </p>
            <dl className="run-stats">
              <div>
                <dt>spent</dt>
                <dd>
                  {money(run.cost)}
                  {budget !== null ? <span> of {money(budget)}</span> : null}
                </dd>
              </div>
              <div>
                <dt>tasks</dt>
                <dd>{run.total ? `${run.settled} of ${run.total} settled` : "none yet"}</dd>
              </div>
              {remaining ? (
                <div>
                  <dt>time</dt>
                  <dd>{remaining}</dd>
                </div>
              ) : null}
            </dl>
            {budget !== null ? (
              <div className="meter" aria-hidden>
                <span style={{ width: `${Math.min(100, (run.cost / budget) * 100)}%` }} />
              </div>
            ) : null}
            {run.note ? <p className="note">{run.note}</p> : null}
            <p className="run-links">
              <a href={`/live?ch=${encodeURIComponent(`${swarm}${run.slug}`)}`}>Watch</a>
              {run.phase === "running" || run.phase === "preparing" ? <StopButton slug={run.slug} /> : null}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
