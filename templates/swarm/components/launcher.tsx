import type { ReactNode } from "react";
import type { Launcher } from "@/lib/launcher";
import { headline, progress } from "@/lib/setup";
import { Copy } from "./copy";
import { Launch } from "./launch";
import { Live } from "./live";
import { Runs } from "./runs";
import { Stepper, Tasks } from "./stepper";

/** The launcher's page, from one check of the deployment: how to protect it, its setup, or once it's set up, the form and the runs. */
export function LauncherView({ result, inspect, models, runs, swarm, origin }: Launcher & { swarm: string; origin: string }): ReactNode {
  const { title, lede } = headline(result);

  // Anyone can open this page: it says how to close it, and nothing about the swarm.
  if (result.open) {
    return (
      <main className="launcher">
        <section className="hero">
          <h1>{title}</h1>
          <p className="lede">{lede}</p>
        </section>
        <section className="panel">
          <Tasks tasks={[result.task]} />
        </section>
        <Live polling />
      </main>
    );
  }

  const { steps, found } = result;
  const { done, of, ready } = progress(steps);
  const active = runs.some((run) => run.phase === "running" || run.phase === "preparing");
  const join = `Read ${origin}/join.md and follow it to take tasks from the ${swarm} queue on our team's board.`;
  const watch = (
    <section className="panel">
      <h2>Watch it</h2>
      <p className="note">Every task, agent, and message under {swarm}, live.</p>
      <p>
        <a className="button" href="/live">
          Open the live view
        </a>
      </p>
      <p className="note">
        Or the whole board from your terminal: <code className="inline">{inspect}</code>. Want a coding agent on your machine to help? <Copy text={join} label="Copy this prompt" quiet />
      </p>
    </section>
  );

  if (ready) {
    return (
      <main className="launcher">
        <section className="hero">
          <h1>{title}</h1>
          <p className="lede">{lede}</p>
        </section>
        <section className="panel">
          <Launch repos={found.repos} models={models} install={found.install} />
        </section>
        <section className="panel">
          <h2>Runs</h2>
          <Runs runs={runs} swarm={swarm} now={Date.now()} />
        </section>
        {watch}
        <details className="panel setup">
          <summary>
            Setup
            <span>
              {done} of {of} done
            </span>
          </summary>
          <Stepper steps={steps} />
        </details>
        {/* A run moves on its own: the page follows while one is going. */}
        <Live polling={active} />
      </main>
    );
  }

  return (
    <main className="launcher">
      <section className="hero">
        <h1>{title}</h1>
        <p className="lede">{lede}</p>
        <div className="hero-links">
          <span className="progress">
            {done} of {of} done
          </span>
        </div>
      </section>
      <Stepper steps={steps} />
      {/* While a step is left, it can get done at any moment, somewhere else. */}
      <Live polling />
      {watch}
    </main>
  );
}
