"use client";

import { useEffect, useMemo, useState } from "react";
import { ask, say, stop, thread } from "@/lib/client";
import type { Line, RunView, Snapshot, Task } from "@/lib/swarm";
import { WebMcp } from "@/components/webmcp";

/** What a task shows as: its state, with a claim split by whether its lease still holds. */
type Shown = "working" | "stalled" | "held" | "ready" | "waiting" | "done" | "failed" | "canceled";
const GROUPS: { key: Shown; title: string }[] = [
  { key: "working", title: "Working" },
  { key: "stalled", title: "Stalled" },
  { key: "held", title: "Held for a person" },
  { key: "ready", title: "Ready" },
  { key: "waiting", title: "Waiting" },
  { key: "done", title: "Done" },
  { key: "failed", title: "Failed" },
  { key: "canceled", title: "Canceled" },
];

/** The states a task has ended in. */
const ENDED = ["completed", "failed", "canceled"];

type History = Awaited<ReturnType<typeof thread>>;

const shown = (task: Task, now: number): Shown =>
  task.state === "claimed"
    ? task.lease && Date.parse(task.lease) < now
      ? "stalled"
      : "working"
    : task.state === "blocked"
      ? "held"
      : task.state === "completed"
        ? "done"
        : task.state;

/** `swarm/perf` is in `swarm/perf`, and in `swarm`'s subtree. */
const within = (channel: string, filter: string | null) => !filter || channel === filter || channel.startsWith(`${filter}/`);

function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}
const ago = (at: string, now: number) => span(now - Date.parse(at));
const firstLine = (text: string) => text.split("\n", 1)[0] || "(empty)";

export function Swarm({ first, channel: firstChannel, task: firstTask }: { first: Snapshot; channel: string | null; task: string | null }) {
  const [snap, setSnap] = useState(first);
  const [live, setLive] = useState<"live" | "reconnecting" | { problem: string }>("live");
  const [channel, setChannel] = useState(firstChannel);
  const [open, setOpen] = useState(firstTask);
  // The server's clock until the page is mounted, so the first render matches the server's.
  const [now, setNow] = useState(() => Date.parse(first.at));

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  // The live feed. EventSource reconnects on its own, and each connection starts with a snapshot,
  // so a dropped one costs nothing but the wait.
  useEffect(() => {
    const source = new EventSource("/api/live");
    source.addEventListener("snapshot", (event) => {
      setSnap(JSON.parse((event as MessageEvent<string>).data) as Snapshot);
      setLive("live");
      setNow(Date.now());
    });
    source.addEventListener("ping", () => setLive("live"));
    source.addEventListener("problem", (event) => setLive({ problem: (JSON.parse((event as MessageEvent<string>).data) as { message: string }).message }));
    source.onerror = () => setLive((state) => (state === "live" ? "reconnecting" : state));
    return () => source.close();
  }, []);

  // The view lives in the link, so a copied one reopens it: ?ch=swarm/perf&task=<id>
  useEffect(() => {
    const query = [channel && `ch=${encodeURIComponent(channel).replaceAll("%2F", "/")}`, open && `task=${encodeURIComponent(open)}`].filter(Boolean);
    window.history.replaceState(null, "", query.length ? `?${query.join("&")}` : window.location.pathname);
  }, [channel, open]);

  // A run is shown by its goal, with its own log (its thread in the runs channel) beside its tasks.
  const run = useMemo(() => snap.runs.find((entry) => entry.channel === channel) ?? null, [snap, channel]);
  const ofRun = (line: Line, of: RunView) => line.channel === snap.runsChannel && (line.id === of.thread || line.re === of.thread);
  const tasks = useMemo(() => snap.tasks.filter((task) => within(task.channel, channel)), [snap, channel]);
  const flow = useMemo(() => snap.flow.filter((line) => within(line.channel, channel) || (run !== null && ofRun(line, run))), [snap, channel, run]);
  const where = (line: Line) => {
    if (line.channel === snap.runsChannel) return snap.runs.find((entry) => entry.thread === (line.re ?? line.id))?.slug ?? "runs";
    return line.channel.slice(snap.swarm.length) || line.channel;
  };

  const groups = useMemo(() => {
    const by = new Map<Shown, Task[]>();
    for (const task of tasks) {
      const key = shown(task, now);
      by.set(key, [...(by.get(key) ?? []), task]);
    }
    return GROUPS.map((group) => ({ ...group, tasks: by.get(group.key) ?? [] })).filter((group) => group.tasks.length > 0);
  }, [tasks, now]);

  const channels = useMemo(() => {
    const open = new Map<string, number>();
    for (const line of snap.flow) open.set(line.channel, open.get(line.channel) ?? 0);
    for (const task of snap.tasks) open.set(task.channel, (open.get(task.channel) ?? 0) + (ENDED.includes(task.state) ? 0 : 1));
    // Runs are listed by their goal, above: what's left are channels agents joined from JOIN.md.
    const runChannels = new Set([snap.runsChannel, ...snap.runs.map((entry) => entry.channel)]);
    return [...open].filter(([path]) => !runChannels.has(path)).sort(([a], [b]) => a.localeCompare(b));
  }, [snap]);

  // Choosing another run or channel closes a task of another one: the panel shows what's selected.
  const pick = (next: string | null) => {
    setChannel(next);
    const shownTask = open ? snap.tasks.find((task) => task.id === open) : null;
    if (shownTask && !within(shownTask.channel, next)) setOpen(null);
  };

  const openIn = (path: string) => snap.tasks.filter((task) => task.channel === path && !ENDED.includes(task.state)).length;

  // Who's here: everyone holding a task, and everyone who wrote lately.
  const agents = useMemo(() => {
    const seen = new Map<string, { holding: number; last: string | null }>();
    for (const line of [...flow].reverse()) seen.set(line.author, { holding: 0, last: line.at });
    for (const task of tasks) {
      if (task.state !== "claimed" || !task.holder) continue;
      const agent = seen.get(task.holder) ?? { holding: 0, last: null };
      seen.set(task.holder, { ...agent, holding: agent.holding + 1 });
    }
    return [...seen].sort(([, a], [, b]) => b.holding - a.holding || (b.last ?? "").localeCompare(a.last ?? ""));
  }, [flow, tasks]);

  // The counts and the agents follow what's selected: one run's, or the whole swarm's.
  const count = (key: Shown) => tasks.filter((task) => shown(task, now) === key).length;
  const selected = open ? snap.tasks.find((task) => task.id === open) ?? null : null;

  return (
    <div className="shell">
      <WebMcp snap={snap} show={setOpen} />
      <header>
        <h1>{snap.name} board</h1>
        <span className="state" data-live={typeof live === "string" ? live : "down"}>
          <i aria-hidden />
          {typeof live === "string" ? live : `down: ${live.problem}`}
        </span>
        <span className="counts">
          <b>{count("working")}</b> working · <b>{count("ready")}</b> ready · <b>{count("held")}</b> held · <b>
            {count("done")}
            {snap.finishedCapped ? "+" : ""}
          </b>{" "}
          done
          {count("stalled") > 0 && (
            <>
              {" · "}
              <b className="bad">{count("stalled")}</b> stalled
            </>
          )}
        </span>
      </header>

      <nav className="pane" aria-label="Channels and agents">
        {snap.runs.length > 0 && (
          <>
            <h2>Runs</h2>
            <ul>
              {snap.runs.map((entry) => (
                <li key={entry.slug}>
                  <button type="button" className="run" aria-pressed={channel === entry.channel} onClick={() => pick(entry.channel)} title={entry.goal}>
                    <span className="text">{entry.title}</span>
                    <span className="faint run-meta">
                      <i data-phase={entry.phase} aria-hidden />
                      {entry.phase} · {openIn(entry.channel)} open · ${entry.cost.toFixed(2)} · {ago(entry.createdAt, now)} ago</span>
                    <span className="faint run-meta">
                      {entry.slug}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <h2>Channels</h2>
        <ul>
          <li>
            <button type="button" aria-pressed={!channel} onClick={() => pick(null)}>
              <span>{snap.swarm}</span>
              <span className="faint">all</span>
            </button>
          </li>
          {channels.map(([path, open]) => (
            <li key={path}>
              <button type="button" aria-pressed={channel === path} onClick={() => pick(path)}>
                <span>{path.slice(snap.swarm.length) || path}</span>
                <span className="faint">{open || ""}</span>
              </button>
            </li>
          ))}
        </ul>
        <h2>Agents</h2>
        <ul>
          {agents.length === 0 && <li className="faint pad">none yet</li>}
          {agents.map(([handle, agent]) => (
            <li key={handle} className="agent">
              <span className="who" title={handle}>
                {handle}
              </span>
              <span className="faint">{agent.holding > 0 ? `${agent.holding} held` : agent.last ? ago(agent.last, now) : ""}</span>
            </li>
          ))}
        </ul>
      </nav>

      <section className="pane" aria-label="Flow">
        {run ? <RunBar run={run} tasks={tasks} now={now} show={setOpen} /> : null}
        <h2>Flow</h2>
        {flow.length === 0 ? (
          <p className="faint pad">
            {run ? "Nothing yet: the run's log shows here as it clones the repo and plans." : "Nothing here yet. Launch a run from the launcher, or have agents join with JOIN.md."}
          </p>
        ) : (
          <ul className="rows">
            {flow.map((line) => (
              <li key={line.id}>
                <button type="button" onClick={() => setOpen(line.re ?? line.id)} title={line.text}>
                  <time>{ago(line.at, now)}</time>
                  <span className="faint ch">{where(line)}</span>
                  <span className="who">{line.author}</span>
                  <span className="text">
                    {line.re && <span className="faint">↳ </span>}
                    {firstLine(line.text)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <aside className="pane" aria-label={open ? "Task" : "Tasks"}>
        {open ? (
          <Panel id={open} task={selected} now={now} onClose={() => setOpen(null)} />
        ) : (
          <>
            <h2>Tasks</h2>
            {groups.length === 0 && (
              <p className="faint pad">
                {run && (run.phase === "preparing" || run.phase === "running")
                  ? run.scenario === "pipeline"
                    ? "No tasks yet. The planner's task shows here once the repo is cloned, and the plan's tasks once it's done."
                    : "No tasks yet. They show here once the repo is cloned and split into areas."
                  : `No tasks in ${run?.title ?? channel ?? snap.swarm}`}
              </p>
            )}
            {groups.map((group) => {
              const finished = group.key === "done" || group.key === "failed" || group.key === "canceled";
              const rows = group.tasks;
              return (
                <div key={group.key} className="group">
                  <h3>
                    <i data-state={group.key} aria-hidden />
                    {group.title} <span className="faint">{group.tasks.length}</span>
                  </h3>
                  <ul className="rows">
                    {rows.map((task) => (
                      <li key={task.id}>
                        <button type="button" onClick={() => setOpen(task.id)} title={task.title}>
                          <span className="text">{task.title}</span>
                          {task.holder && <span className="who">{task.holder}</span>}
                          <span className="faint chip">{chip(task, group.key, now)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {finished && snap.finishedCapped && <p className="faint pad">and older ones</p>}
                </div>
              );
            })}
          </>
        )}
      </aside>
    </div>
  );
}

/** A box to write to the board from the page: Cmd/Ctrl-Enter sends. It clears once the board took it. */
function Composer({ placeholder, action, send, hint }: { placeholder: string; action: string; send: (text: string) => Promise<{ ok: true } | { ok: false; problem: string }>; hint: string }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<{ busy: boolean; said: string | null; bad: boolean }>({ busy: false, said: null, bad: false });
  async function submit() {
    if (!text.trim() || state.busy) return;
    setState({ busy: true, said: null, bad: false });
    const result = await send(text);
    if (result.ok) {
      setText("");
      setState({ busy: false, said: "Sent.", bad: false });
    } else setState({ busy: false, said: result.problem, bad: true });
  }
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        value={text}
        rows={2}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer-foot">
        <span className={state.bad ? "bad" : "faint"}>{state.said ?? hint}</span>
        <button type="submit" disabled={state.busy || !text.trim()}>
          {state.busy ? "Sending" : action}
        </button>
      </div>
    </form>
  );
}

/** A pull request's link as people say it: `acme/web#12`. */
const prName = (url: string) => url.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+).*$/, "$1#$2");

/** The pull requests a task opened on the run's repo: its `pr` label, or links in its result. A link anywhere else isn't one. */
const prsOf = (task: Task, repo: string) => {
  const ours = new RegExp(`^https://github\\.com/${repo.replace(/[.]/g, "\\.")}/pull/\\d+$`);
  return [...new Set([...(task.pr ? [task.pr] : []), ...(task.note?.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/g) ?? [])])].filter((url) => ours.test(url));
};

/** How a task of a run ended, in words a person reads at a glance. */
type Outcome = { kind: "pr" | "none" | "failed" | "canceled" | "done"; line: string };

/** The first sentence or two of what an agent said, without its boilerplate. */
const gist = (text: string | null, max = 220) => {
  const plain = (text ?? "").replace(/https:\/\/github\.com\/\S+/g, "").replace(/\s+/g, " ").trim();
  return plain.length > max ? `${plain.slice(0, max).replace(/\s\S*$/, "")}…` : plain;
};

function outcomeOf(task: Task, review: Task | undefined, repo: string): Outcome {
  const verdict = review && ENDED.includes(review.state) ? (review.state === "completed" ? "review approved" : `review asked for changes${review.note ? `: ${gist(review.note, 120)}` : ""}`) : review ? "review pending" : null;
  if (task.state === "failed") return { kind: "failed", line: `Failed: ${gist(task.note) || "no reason given"}` };
  if (task.state === "canceled") return { kind: "canceled", line: `Canceled${task.note ? `: ${gist(task.note)}` : ""}` };
  const prs = prsOf(task, repo);
  if (prs.length) return { kind: "pr", line: [`Pull request ${prs.map(prName).join(", ")} opened`, verdict].filter(Boolean).join(" · ") };
  if (task.role === "work") return { kind: "none", line: `No change made: ${gist(task.note) || "the agent found nothing to change"}` };
  return { kind: "done", line: gist(task.note) || "Done" };
}

/**
 * What a run came to, in one place: a line that counts how its tasks ended, the pull requests it
 * opened, then each task with how it ended in words (the planner's and the reviews' left out: a
 * review shows as the verdict on the work it reviewed). A review run's report comes first.
 */
function Results({ run, tasks: all, show }: { run: RunView; tasks: Task[]; show: (id: string) => void }) {
  // Only the run's own tasks, the ones the deployment made: anyone who may post in the channel can
  // make a task, or label one a review or a report, and it mustn't read as the run's result.
  const tasks = all.filter((task) => task.own);
  const reviews = new Map(tasks.filter((task) => task.role === "review").map((task) => [task.needs[0], task]));
  const ended = tasks.filter((task) => ENDED.includes(task.state) && task.role !== "plan" && task.role !== "review" && task.role !== "verify");
  const report = ended.find((task) => task.role === "report" && task.state === "completed");
  const outcomes = ended.filter((task) => task !== report).map((task) => ({ task, outcome: outcomeOf(task, reviews.get(task.id), run.repo) }));
  const prs = [...new Set(outcomes.flatMap(({ task }) => prsOf(task, run.repo)))];
  const counts = { pr: 0, none: 0, failed: 0, canceled: 0, done: 0 };
  for (const { outcome } of outcomes) counts[outcome.kind]++;
  const working = tasks.filter((task) => !ENDED.includes(task.state) && task.role !== "review" && task.role !== "verify").length;
  const over = run.phase !== "running" && run.phase !== "preparing";

  const headline = [
    counts.pr && `${counts.pr} ${counts.pr === 1 ? "pull request" : "pull requests"} opened`,
    counts.none && `${counts.none} with no change needed`,
    counts.done && `${counts.done} done`,
    counts.failed && `${counts.failed} failed`,
    counts.canceled && `${counts.canceled} canceled`,
    !over && working && `${working} still going`,
  ].filter(Boolean);

  return (
    <div className="results">
      <h3>{over ? "Result" : "Results so far"}</h3>
      {outcomes.length === 0 && !report ? (
        <p className="faint">{over ? `Nothing came of it: ${run.note ?? "the run ended before it had any tasks."}` : "Nothing finished yet. Each task's outcome shows here as it ends."}</p>
      ) : (
        <p className="headline">{headline.join(" · ")}</p>
      )}
      {report?.note && (
        <button type="button" className="report" onClick={() => show(report.id)}>
          {report.note.slice(0, 1_200)}
        </button>
      )}
      {prs.length > 0 && (
        <p className="prs">
          {prs.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer">
              {prName(url)}
            </a>
          ))}
        </p>
      )}
      <ul>
        {outcomes.map(({ task, outcome }) => (
          <li key={task.id}>
            <button type="button" onClick={() => show(task.id)} title="Open its work log">
              <i data-outcome={outcome.kind} aria-hidden />
              <span className="what">
                <span className="text">{task.title}</span>
                <span className={outcome.kind === "failed" ? "bad" : "faint"}>{outcome.line}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The selected run: what it was asked, where it stands, and a way to stop it. */
function RunBar({ run, tasks, now, show }: { run: RunView; tasks: Task[]; now: number; show: (id: string) => void }) {
  const [stopping, setStopping] = useState<string | null>(null);
  const live = run.phase === "preparing" || run.phase === "running";
  const left = run.deadline && live ? Date.parse(run.deadline) - now : null;
  return (
    <div className="runbar">
      <p className="goal" title={run.goal}>
        {run.goal}
      </p>
      <p className="faint">
        <i data-phase={run.phase} aria-hidden /> {run.phase} · {run.repo} · {run.scenario} · {run.model} · <span title="An agent starts for each task that's ready or being worked, up to the run's number: the plan decides how many work at once.">{live ? `${run.up} of ${run.agents} agents up` : `${run.agents} ${run.agents === 1 ? "agent" : "agents"}`}</span>
      </p>
      <p>
        <span className="faint">spent</span> ${run.cost.toFixed(2)}
        {run.budgetUsd !== null && <span className="faint"> of ${run.budgetUsd}</span>}
        {"  "}
        <span className="faint">tasks</span> {run.settled} of {run.total} settled
        {left !== null && (
          <>
            {"  "}
            <span className="faint">time</span> {left > 0 ? `${span(left)} left` : "up"}
          </>
        )}
        {live && (
          <button
            type="button"
            className="stop"
            disabled={stopping === "…"}
            onClick={async () => {
              if (!window.confirm(`Stop "${run.title}"? Its agents stop and its sandboxes go.`)) return;
              setStopping("…");
              const result = await stop(run.slug);
              setStopping(result.ok ? null : result.problem);
            }}
          >
            {stopping === "…" ? "Stopping" : "Stop"}
          </button>
        )}
      </p>
      {run.note && <p className="faint">{run.note}</p>}
      {stopping && stopping !== "…" && <p className="bad">{stopping}</p>}
      <Results run={run} tasks={tasks} show={show} />
      {run.phase === "running" && (
        <Composer
          placeholder={run.scenario === "pipeline" ? "Ask the swarm for more: add a CHANGELOG entry for each optimization…" : "Ask the swarm to look at something: check the retry logic in lib/fetch.ts…"}
          action="Add task"
          hint={run.scenario === "pipeline" ? "Becomes a task, and a review of it, that the next free agent takes." : "Becomes an area to review, and a check of it."}
          send={(text) => ask(run.slug, text)}
        />
      )}
    </div>
  );
}

/** The one fact that matters for a row in its group. */
function chip(task: Task, key: Shown, now: number): string {
  if (key === "working" && task.lease) return `lease ${span(Date.parse(task.lease) - now)}`;
  if (key === "stalled" && task.lease) return `lease ended ${ago(task.lease, now)} ago`;
  if (key === "waiting" && task.needs.length) return `needs ${task.needs.join(" ")}`;
  return ago(task.last?.at ?? task.createdAt, now);
}

/** One task: its state, its brief, and its work log, read again whenever the thread moves. */
function Panel({ id, task, now, onClose }: { id: string; task: Task | null; now: number; onClose: () => void }) {
  const [history, setHistory] = useState<History | { problem: string } | null>(null);
  // Anything that changes in the thread changes one of these.
  const version = task ? `${task.state}:${task.holder}:${task.replies}:${task.last?.id}` : "";

  useEffect(() => {
    let stale = false;
    thread(id).then(
      (loaded) => !stale && setHistory(loaded),
      (error: unknown) => !stale && setHistory({ problem: (error as Error).message }),
    );
    return () => {
      stale = true;
    };
  }, [id, version]);

  const key = task ? shown(task, now) : null;
  return (
    <>
      <h2 className="head">
        <span>{task ? task.channel : "Thread"}</span>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </h2>
      {history === null ? (
        <p className="faint pad">Loading…</p>
      ) : "problem" in history ? (
        <p className="pad bad">Couldn&apos;t read {id}: {history.problem}</p>
      ) : (
        <div className="thread">
          {task && key && (
            <p className="chips">
              <span className="state-chip">
                <i data-state={key} aria-hidden />
                {key}
              </span>
              {task.holder && <span className="who">{task.holder}</span>}
              {key !== "ready" && <span className="faint">{chip(task, key, now)}</span>}
              <span className="faint">{id}</span>
            </p>
          )}
          {task?.note && <p className="note">{task.note}</p>}
          <Entry line={history.root} now={now} />
          <h3>
            Work log <span className="faint">{history.replies.length}</span>
          </h3>
          {history.replies.length === 0 && <p className="faint">no replies yet</p>}
          {history.replies.map((reply) => (
            <Entry key={reply.id} line={reply} now={now} />
          ))}
          <Composer
            placeholder="Steer this task: use the existing helper in lib/util.ts…"
            action="Reply"
            hint="Agents read people's replies when they take a task."
            send={(text) => say(id, text)}
          />
        </div>
      )}
    </>
  );
}

// Board text is whatever an agent wrote: it's shown as text, never as HTML.
function Entry({ line, now }: { line: Line; now: number }) {
  return (
    <article>
      <p className="by">
        <span className="who">{line.author}</span> <time dateTime={line.at}>{ago(line.at, now)} ago</time>
      </p>
      <p className="body">{line.text}</p>
    </article>
  );
}
