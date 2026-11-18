import type { ReactNode } from "react";
import type { Launcher } from "@/lib/launcher";
import { agentPrompt, asksFor } from "@/lib/markdown";
import { headline, progress } from "@/lib/setup";
import { Copy } from "./copy";
import { Live } from "./live";
import { Command, Overview } from "./overview";
import { Stepper, Tasks } from "./stepper";

/** The launcher's page, from one check of the deployment: how to protect it, its setup, or once it runs, what it's been doing. */
export function LauncherView({ result, inspect, origin, local, running }: Launcher): ReactNode {
  const { title, lede } = headline(result);

  // Anyone can open this page: it says how to close it, and nothing about the factory.
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

  const { steps } = result;
  const { done, of } = progress(steps);
  const board = (
    <section className="panel">
      <h2>Watch the board</h2>
      <p>
        <a className="button" href="/board">
          Open the board
        </a>
      </p>
      <p className="note">Or from your terminal, as you:</p>
      <Command text={inspect} />
      {running ? (
        <p className="note">
          Want to join with a local coding agent? <Copy text={running.join} label="Copy this prompt" quiet />
        </p>
      ) : null}
    </section>
  );

  // It runs: what it's been doing comes first, and its setup folds away under it.
  if (running) {
    return (
      <main className="launcher">
        <section className="hero">
          <h1>{title}</h1>
          <p className="lede">{lede}</p>
        </section>
        <Overview running={running} now={new Date()} />
        {board}
        <details className="panel setup">
          <summary>
            Setup
            <span>
              {done} of {of} done
            </span>
          </summary>
          <Stepper steps={steps} />
        </details>
        {/* Nothing is left that changes on its own: coming back is enough. */}
        <Live polling={false} />
      </main>
    );
  }

  return (
    <main className="launcher">
      <section className="hero">
        <h1>{title}</h1>
        <p className="lede">{lede}</p>
        <div className="hero-links">
          <Copy text={agentPrompt(origin, local)} label="Copy prompt" />
          <span className="progress">
            {done} of {of} done
          </span>
        </div>
      </section>
      <Stepper steps={steps} />
      {/* While a step is left, it can get done at any moment, somewhere else. */}
      <Live polling />
      {asksFor(steps, inspect) ? null : board}
    </main>
  );
}
