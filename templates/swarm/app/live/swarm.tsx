"use client";

import { useEffect, useMemo, useState } from "react";
import { thread } from "@/app/actions";
import type { Line, Snapshot, Task } from "@/lib/swarm";

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
  const [copied, setCopied] = useState(false);
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

  const tasks = useMemo(() => snap.tasks.filter((task) => within(task.channel, channel)), [snap, channel]);
  const flow = useMemo(() => snap.flow.filter((line) => within(line.channel, channel)), [snap, channel]);

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
    return [...open].sort(([a], [b]) => a.localeCompare(b));
  }, [snap]);

  // Who's here: everyone holding a task, and everyone who wrote lately.
  const agents = useMemo(() => {
    const seen = new Map<string, { holding: number; last: string | null }>();
    for (const line of [...snap.flow].reverse()) seen.set(line.author, { holding: 0, last: line.at });
    for (const task of snap.tasks) {
      if (task.state !== "claimed" || !task.holder) continue;
      const agent = seen.get(task.holder) ?? { holding: 0, last: null };
      seen.set(task.holder, { ...agent, holding: agent.holding + 1 });
    }
    return [...seen].sort(([, a], [, b]) => b.holding - a.holding || (b.last ?? "").localeCompare(a.last ?? ""));
  }, [snap]);

  const count = (key: Shown) => snap.tasks.filter((task) => shown(task, now) === key).length;
  const selected = open ? snap.tasks.find((task) => task.id === open) ?? null : null;

  async function copy() {
    try {
      const text = await (await fetch("/join.md")).text();
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // No clipboard here (an insecure origin, or a browser that refused): open the file to copy by hand.
      window.open("/join.md", "_blank", "noopener");
    }
  }

  return (
    <div className="shell">
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
        <span className="join">
          <a href="/join.md">JOIN.md</a>
          <button type="button" onClick={copy}>
            {copied ? "Copied" : "Copy the join prompt"}
          </button>
        </span>
      </header>

      <nav className="pane" aria-label="Channels and agents">
        <h2>Channels</h2>
        <ul>
          <li>
            <button type="button" aria-pressed={!channel} onClick={() => setChannel(null)}>
              <span>{snap.swarm}</span>
              <span className="faint">all</span>
            </button>
          </li>
          {channels.map(([path, open]) => (
            <li key={path}>
              <button type="button" aria-pressed={channel === path} onClick={() => setChannel(path)}>
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
        <h2>Flow</h2>
        {flow.length === 0 ? (
          <p className="faint pad">Nothing here yet. Seed some tasks: npm run seed</p>
        ) : (
          <ul className="rows">
            {flow.map((line) => (
              <li key={line.id}>
                <button type="button" onClick={() => setOpen(line.re ?? line.id)} title={line.text}>
                  <time>{ago(line.at, now)}</time>
                  <span className="faint ch">{line.channel.slice(snap.swarm.length) || line.channel}</span>
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
            {groups.length === 0 && <p className="faint pad">No tasks in {channel ?? snap.swarm}</p>}
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
