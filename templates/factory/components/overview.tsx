import type { ReactNode } from "react";
import { FIRST_TASK_PATH } from "@/lib/first-task";
import type { Running } from "@/lib/launcher";
import { ago, firstTaskLine, shows, waitingLine } from "@/lib/markdown";
import { ONBOARD_PATH } from "@/lib/onboard";
import { duration } from "@/lib/overview";
import { Action } from "./action";
import { Copy } from "./copy";
import { Onboard } from "./onboard";

/** A command, or a line to send, on one line beside its copy button. */
export function Command({ text }: { text: string }): ReactNode {
  return (
    <div className="command">
      <pre>
        <code>{text}</code>
      </pre>
      <Copy text={text} />
    </div>
  );
}

/** One line of a list of numbers: what's counted, then the count. */
function Stat({ value, label }: { value: string; label: string }): ReactNode {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** What the factory has been doing, once it runs: the week in its channels, its pull requests, and its repos. */
export function Overview({ running: { overview, repos, ask, first }, now }: { running: Running; now: Date }): ReactNode {
  const { week, lastReplyAt, pulls } = overview;
  const plus = week.more ? "+" : "";
  return (
    <>
      {first ? (
        <section className="panel">
          <h2>First task</h2>
          <p className="note">{firstTaskLine(first, ask)}</p>
          {first === "offer" ? <Action label="Start" path={FIRST_TASK_PATH} /> : null}
        </section>
      ) : null}
      <section className="panel">
        <h2>This week</h2>
        <dl className="stats">
          <Stat value={`${week.threads}${plus}`} label="threads" />
          <Stat value={`${week.messages}${plus}`} label="messages" />
          <Stat value={String(week.answered)} label="answered" />
          {week.firstReplyMs === null ? null : <Stat value={duration(week.firstReplyMs)} label="first reply in" />}
          {lastReplyAt ? <Stat value={ago(lastReplyAt, now)} label="last reply" /> : null}
        </dl>
      </section>
      {pulls ? (
        <section className="panel">
          <h2>Pull requests</h2>
          <dl className="stats">
            <Stat value={String(pulls.open)} label="open" />
            <Stat value={String(pulls.merged)} label="merged" />
            <Stat value={String(pulls.closed)} label="closed" />
          </dl>
        </section>
      ) : null}
      <section className="panel">
        <h2>Repos</h2>
        <ul className="rows">
          {repos.map((repo) => (
            <li key={repo.repo}>
              {repo.repo}
              <span>{shows(repo)}</span>
            </li>
          ))}
        </ul>
        <Onboard path={ONBOARD_PATH} where={ask.slack ?? ask.channel} suggest={ask.suggest} />
        {ask.install ? (
          <p className="note">
            {waitingLine(ask)}{" "}
            <a href={ask.install} target="_blank" rel="noreferrer">
              Add the app to more repos
            </a>
          </p>
        ) : waitingLine(ask) ? (
          <p className="note">{waitingLine(ask)}</p>
        ) : null}
      </section>
    </>
  );
}
