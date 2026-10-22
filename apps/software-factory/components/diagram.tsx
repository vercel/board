"use client";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { ICONS, LOOP, TICK_MS, draw, runs } from "./diagram-grid";

function render(tick: number): ReactNode {
  return draw(tick).map((row, y) => {
    return (
      <span key={y}>
        {runs(row).map((run, i) =>
          "icon" in run ? (
            <span key={i} className={`icon ${run.tone}`}>
              <svg viewBox={ICONS[run.icon].viewBox} fill="currentColor">
                <path d={ICONS[run.icon].d} />
              </svg>
            </span>
          ) : "cell" in run ? (
            <span key={i} className={`cell ${run.tone}`}>
              {run.text}
            </span>
          ) : run.tone === "line" ? (
            run.text
          ) : (
            <span key={i} className={run.tone}>
              {run.text}
            </span>
          ),
        )}
        {"\n"}
      </span>
    );
  });
}

/** One PR's thread, kept in sync between GitHub, a Slack channel, and an agent's terminal. */
export function Diagram(): ReactNode {
  const [tick, setTick] = useState(LOOP - 1);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setTick((current) => (current + 1) % LOOP), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <figure className="diagram">
      <pre aria-hidden>{render(tick)}</pre>
      <figcaption className="sr-only">
        One board thread for pull request 42, synced with GitHub, a Slack channel, and an agent&apos;s terminal.
        Julian opens the PR on GitHub, and it reaches Slack and the agent. Monto asks in Slack whether iOS works too,
        and the question reaches GitHub and the agent. The agent replies that iOS is fixed, and the reply reaches
        Slack and GitHub. Andrew approves and Martin merges on GitHub, and the board&apos;s labels for the PR change
        from state=open to review=approved and state=merged. The board logs every event, with its author, in order.
      </figcaption>
    </figure>
  );
}
