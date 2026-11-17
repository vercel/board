"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { answer, cancel, setAgents, setState, thread } from "@/app/actions";
import type { Line, Snapshot, State, Task } from "@/lib/campaign";
import { MAX_AGENTS } from "@/lib/config";

// A campaign, live: how far along it is, what it has spent, which agent holds which task, and what
// waits for a person. It redraws from the server's snapshots, and holds no credential.

const clock = (iso: string) => iso.slice(11, 19);
/** Dollars, with what a small task costs still showing: $0.004, $1.25, $40. */
const dollars = (amount: number) => `$${amount >= 10 ? amount.toFixed(0) : amount > 0 && amount < 0.1 ? amount.toFixed(3) : amount.toFixed(2)}`;

/** How long until `iso`, in words short enough for a tile. */
function left(ms: number): string {
  if (ms <= 0) return "0m";
  const minutes = Math.ceil(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

const FILTERS: { key: "all" | State; label: string }[] = [
  { key: "all", label: "All" },
  { key: "claimed", label: "Working" },
  { key: "ready", label: "Ready" },
  { key: "blocked", label: "Held" },
  { key: "completed", label: "Done" },
  { key: "failed", label: "Failed" },
];

/** A message's text, with its fenced blocks set apart so a failed verify reads as output. */
function Text({ text }: { text: string }) {
  const parts = text.split(/```[\w ]*\n([\s\S]*?)```/g);
  return (
    <>
      {parts.map((part, at) => (at % 2 ? <pre key={at}>{part.trimEnd()}</pre> : part.trim() && <p key={at}>{part.trim()}</p>))}
    </>
  );
}

function Panel({ slug, task, onClose }: { slug: string; task: Task; onClose: () => void }) {
  const [log, setLog] = useState<{ root: Line; replies: Line[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Read again whenever the task's thread grows, so an open panel follows the agent's work.
  useEffect(() => {
    let stale = false;
    thread(slug, task.id).then(
      (found) => !stale && setLog(found),
      (error: Error) => !stale && setProblem(error.message),
    );
    return () => {
      stale = true;
    };
  }, [slug, task.id, task.replies, task.state]);
  return (
    <aside className="panel">
      <header>
        <h3>{task.title}</h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <p>
        <span className={`chip ${task.state}`}>{task.state}</span>
        {task.holder && <span className="faint"> by {task.holder}</span>}
        {task.cost > 0 && <span className="faint"> · {dollars(task.cost)}</span>}
      </p>
      {task.result && <p style={{ marginTop: 8 }}>{task.result}</p>}
      {problem && <p className="problem">{problem}</p>}
      {log && (
        <>
          <div className="msg">
            <Text text={log.root.text} />
          </div>
          {log.replies.map((reply) => (
            <div className="msg" key={reply.id}>
              <span className="who">{reply.author}</span> <time className="faint">{clock(reply.at)}</time>
              <Text text={reply.text} />
              {reply.files.map((file) => (
                <p key={file.id}>
                  <a href={`/api/file?c=${slug}&task=${encodeURIComponent(task.id)}&id=${encodeURIComponent(file.id)}`}>{file.name}</a>
                </p>
              ))}
            </div>
          ))}
        </>
      )}
    </aside>
  );
}

function Held({ slug, task, readOnly, onDone }: { slug: string; task: Task; readOnly: boolean; onDone: (problem: string | null) => void }) {
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const run = (action: () => Promise<{ ok: true } | { ok: false; problem: string }>) =>
    start(async () => {
      const result = await action();
      onDone(result.ok ? null : result.problem);
    });
  return (
    <li>
      <code>{task.title}</code>
      <p className="why">{task.held?.reason ?? "Held."}</p>
      <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="What should the next agent know?" disabled={readOnly} />
      <div className="row">
        <button type="button" disabled={pending || readOnly} onClick={() => run(() => answer(slug, task.id, note))}>
          Answer and retry
        </button>
        <button type="button" className="danger" disabled={pending || readOnly} onClick={() => run(() => cancel(slug, task.id))}>
          Cancel task
        </button>
      </div>
    </li>
  );
}

export function CampaignView({ first, readOnly }: { first: Snapshot; readOnly: boolean }) {
  const [now, setNow] = useState(first);
  const [problem, setProblem] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | State>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [tick, setTick] = useState(() => Date.now());
  const { campaign, counts, tasks } = now;
  const slug = campaign.slug;

  useEffect(() => {
    const feed = new EventSource(`/api/live?c=${slug}`);
    feed.addEventListener("snapshot", (event) => {
      setNow(JSON.parse((event as MessageEvent<string>).data) as Snapshot);
      setProblem(null);
    });
    feed.addEventListener("problem", (event) => setProblem((JSON.parse((event as MessageEvent<string>).data) as { message: string }).message));
    return () => feed.close();
  }, [slug]);

  // The time left counts down between snapshots.
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const act = (action: () => Promise<{ ok: true } | { ok: false; problem: string }>) =>
    start(async () => {
      const result = await action();
      setProblem(result.ok ? null : result.problem);
    });

  const total = tasks.length;
  const share = (count: number) => `${total ? (count / total) * 100 : 0}%`;
  const working = useMemo(() => tasks.filter((task) => task.state === "claimed"), [tasks]);
  const held = useMemo(() => tasks.filter((task) => task.state === "blocked"), [tasks]);
  const shown = useMemo(() => {
    const matching = filter === "all" ? tasks : tasks.filter((task) => task.state === filter || (filter === "failed" && task.state === "canceled"));
    // What's moving first, then what waits for someone, then the rest, newest activity first.
    const rank = (task: Task) => (task.state === "claimed" ? 0 : task.state === "blocked" ? 1 : 2);
    return [...matching].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 300);
  }, [tasks, filter]);
  const opened = open ? tasks.find((task) => task.id === open) : undefined;
  const live = campaign.phase === "running" || campaign.phase === "paused" || campaign.phase === "preparing";
  const agents = Array.from({ length: campaign.agents }, (_, at) => `worker-${at + 1}`);

  return (
    <>
      <div className="top">
        <h1>{campaign.title}</h1>
        <Link href="/">All campaigns</Link>
      </div>
      <p>
        <span className={`chip ${campaign.phase}`}>{campaign.phase}</span>
        <span className="faint">
          {" "}
          · <code>{campaign.config.repo}</code> · {campaign.config.model}
          {campaign.config.review && ` reviewed by ${campaign.config.reviewModel}`}
        </span>
      </p>
      {campaign.note && campaign.phase !== "running" && <p style={{ marginTop: 6 }}>{campaign.note}</p>}
      {problem && <p className="problem">{problem}</p>}

      <div className="bar" role="img" aria-label={`${counts.completed} of ${total} tasks completed`}>
        <i className="completed" style={{ width: share(counts.completed) }} />
        <i className="claimed" style={{ width: share(counts.claimed) }} />
        <i className="blocked" style={{ width: share(counts.blocked) }} />
        <i className="failed" style={{ width: share(counts.failed + counts.canceled) }} />
      </div>

      <div className="stats">
        <div className="stat">
          <b>
            {counts.completed}/{total}
          </b>
          <span>completed</span>
        </div>
        <div className="stat">
          <b>{counts.claimed}</b>
          <span>being worked</span>
        </div>
        <div className="stat">
          <b>{counts.ready + counts.waiting}</b>
          <span>ready</span>
        </div>
        <div className="stat">
          <b>{counts.blocked}</b>
          <span>held for you</span>
        </div>
        <div className="stat">
          <b>{dollars(now.cost)}</b>
          <span>of {dollars(campaign.config.budgetUsd)}</span>
        </div>
        <div className="stat">
          <b>{campaign.prepared && campaign.phase === "running" ? left(campaign.prepared.deadline - tick) : "–"}</b>
          <span>left of {campaign.config.minutes}m</span>
        </div>
      </div>

      {live && (
        <div className="controls" style={{ marginBottom: 28 }}>
          <span className="stepper">
            <button type="button" aria-label="One agent fewer" disabled={pending || readOnly || campaign.agents <= 1} onClick={() => act(() => setAgents(slug, campaign.agents - 1))}>
              −
            </button>
            <b>{campaign.agents}</b>
            <button type="button" aria-label="One agent more" disabled={pending || readOnly || campaign.agents >= MAX_AGENTS} onClick={() => act(() => setAgents(slug, campaign.agents + 1))}>
              +
            </button>
            <span>{campaign.agents === 1 ? "agent" : "agents"}</span>
          </span>
          {campaign.phase === "running" && (
            <button type="button" disabled={pending || readOnly} onClick={() => act(() => setState(slug, "paused"))}>
              Pause
            </button>
          )}
          {campaign.phase === "paused" && (
            <button type="button" className="primary" disabled={pending || readOnly} onClick={() => act(() => setState(slug, "running"))}>
              Resume
            </button>
          )}
          <button type="button" className="danger" disabled={pending || readOnly} onClick={() => act(() => setState(slug, "stopped"))}>
            Stop
          </button>
        </div>
      )}

      <div className="cols">
        <div>
          <section>
            <h2>Tasks</h2>
            <div className="filters">
              {FILTERS.map(({ key, label }) => (
                <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                  {label}
                </button>
              ))}
            </div>
            {shown.length === 0 ? (
              <p className="empty">{total === 0 ? "No tasks yet: the campaign is cloning the repository and listing its files." : "None."}</p>
            ) : (
              <ul className="tasks">
                {shown.map((task) => (
                  <li key={task.id} aria-current={open === task.id} onClick={() => setOpen(task.id)}>
                    <span className={`chip ${task.state}`}>{task.state === "claimed" ? "working" : task.state === "blocked" ? "held" : task.state}</span>
                    <span className="title">{task.title}</span>
                    <span className="mono faint">{task.cost > 0 ? dollars(task.cost) : task.holder ?? ""}</span>
                    {(task.result ?? task.held?.reason ?? task.last?.text) && <span className="sub">{(task.result ?? task.held?.reason ?? task.last?.text ?? "").split("\n", 1)[0]}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div>
          {held.length > 0 && (
            <section>
              <h2>Held for you</h2>
              <ul className="held">
                {held.map((task) => (
                  <Held key={task.id} slug={slug} task={task} readOnly={readOnly} onDone={setProblem} />
                ))}
              </ul>
            </section>
          )}
          <section>
            <h2>Agents</h2>
            <ul className="agents">
              {agents.map((name) => {
                const on = working.find((task) => task.holder === name);
                return (
                  <li key={name}>
                    <code>{name}</code>
                    {on ? (
                      <button type="button" className="link on" onClick={() => setOpen(on.id)}>
                        {on.title}
                      </button>
                    ) : (
                      <span className="faint">{campaign.phase === "running" ? "idle" : "–"}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
          <section>
            <h2>Log</h2>
            {now.log.length === 0 ? (
              <p className="empty">Starting.</p>
            ) : (
              <ul className="log">
                {[...now.log].reverse().map((entry) => (
                  <li key={entry.id}>
                    <time>{clock(entry.at)}</time>
                    {entry.text}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {opened && <Panel slug={slug} task={opened} onClose={() => setOpen(null)} />}
    </>
  );
}
