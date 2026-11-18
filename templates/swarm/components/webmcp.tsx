"use client";

import { useEffect, useRef } from "react";
import { runs as swarmRuns, thread } from "@/lib/client";
import type { Snapshot, State } from "@/lib/swarm";

/** The states the board keeps a task in, as lib/swarm.ts has them: repeated so the page doesn't bundle the board's server code. */
const STATES: readonly State[] = ["waiting", "ready", "claimed", "blocked", "completed", "failed", "canceled"];

// The live page's tools for agents, over WebMCP: an agent browsing this page (as whoever opened it,
// past Deployment Protection) asks for the swarm's runs, tasks and work logs as data, instead of
// reading them off the screen. Every tool reads; none writes. A browser without WebMCP gets nothing.

type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>;
};

type ModelContext = {
  registerTool?: (tool: Tool) => unknown;
  unregisterTool?: (name: string) => unknown;
  provideContext?: (context: { tools: Tool[] }) => unknown;
  clearContext?: () => unknown;
};

const answer = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const count = (value: unknown, fallback: number, max: number) => Math.min(max, Math.max(1, Math.trunc(Number(value)) || fallback));

function tools(snap: () => Snapshot, show: (task: string) => void): Tool[] {
  return [
    {
      name: "swarm_overview",
      description:
        "The swarm right now: its name and channels, how many tasks are in each state, the agents holding tasks, and the newest messages. Start here.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      async execute() {
        const now = snap();
        const states = Object.fromEntries(STATES.map((state) => [state, now.tasks.filter((task) => task.state === state).length]));
        const holders = [...new Set(now.tasks.flatMap((task) => (task.state === "claimed" && task.holder ? [task.holder] : [])))];
        return answer({
          name: now.name,
          swarm: now.swarm,
          at: now.at,
          states,
          finishedCapped: now.finishedCapped,
          channels: [...new Set(now.tasks.map((task) => task.channel))],
          working: holders,
          flow: now.flow.slice(0, 20).map(({ channel, author, text: said, at, re }) => ({ channel, author, at, reply: re !== null, text: said.slice(0, 300) })),
        });
      },
    },
    {
      name: "swarm_runs",
      description:
        "The newest runs launched from this page: each one's goal, repo, scenario (pipeline or review), model, agent count, budget and time limit, phase (preparing, running, done, stopped, failed), what it has spent, and how many of its tasks are settled. A run's tasks are in the channel named after its slug.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, description: "How many runs, newest first. Default 20." } } },
      annotations: { readOnlyHint: true },
      async execute(input) {
        return answer(await swarmRuns(count(input.limit, 20, 50)));
      },
    },
    {
      name: "swarm_tasks",
      description:
        "The swarm's tasks: every open one (waiting, ready, claimed, blocked) and the newest finished ones, each with its title, state, channel, holder, lease, what it waits for, and its result or why it failed. Filter by state, by channel (a run's slug works), or by the agent holding it.",
      inputSchema: {
        type: "object",
        properties: {
          state: { type: "string", enum: [...STATES] },
          channel: { type: "string", description: "A channel, or a run's slug: r1a2b3c or swarm/r1a2b3c." },
          holder: { type: "string", description: "An agent's name, like agent-3." },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 50." },
        },
      },
      annotations: { readOnlyHint: true },
      async execute(input) {
        const now = snap();
        const state = STATES.includes(input.state as State) ? (input.state as State) : null;
        const channel = text(input.channel);
        const holder = text(input.holder);
        const found = now.tasks.filter(
          (task) =>
            (!state || task.state === state) &&
            (!channel || task.channel === channel || task.channel === `${now.swarm}${channel}`) &&
            (!holder || task.holder === holder),
        );
        return answer({
          total: found.length,
          tasks: found.slice(0, count(input.limit, 50, 200)).map(({ last, ...task }) => ({ ...task, lastMessage: last ? { author: last.author, at: last.at, text: last.text.slice(0, 300) } : null })),
        });
      },
    },
    {
      name: "swarm_task",
      description: "One task in full: its brief, its labels (role, cost, worker, pull request), and its work log, every reply the agents posted while they worked it.",
      inputSchema: { type: "object", properties: { id: { type: "string", description: "The task's ID, like msg_…_1." } }, required: ["id"] },
      annotations: { readOnlyHint: true },
      async execute(input) {
        const id = text(input.id);
        if (!id) throw new Error("id is required");
        return answer(await thread(id));
      },
    },
    {
      name: "swarm_show_task",
      description: "Opens a task's panel on this page, so the person looking at it sees the task you're talking about.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async execute(input) {
        const id = text(input.id);
        if (!id) throw new Error("id is required");
        show(id);
        return answer({ shown: id });
      },
    },
  ];
}

/** Registers the live page's tools with the browser's WebMCP, reading the snapshot as it is when a tool runs. */
export function WebMcp({ snap, show }: { snap: Snapshot; show: (task: string) => void }) {
  const latest = useRef({ snap, show });
  latest.current = { snap, show };

  useEffect(() => {
    const context = (navigator as Navigator & { modelContext?: ModelContext }).modelContext;
    if (!context) return;
    const list = tools(
      () => latest.current.snap,
      (task) => latest.current.show(task),
    );
    if (context.registerTool) {
      for (const tool of list) context.registerTool(tool);
      return () => {
        for (const tool of list) context.unregisterTool?.(tool.name);
      };
    }
    context.provideContext?.({ tools: list });
    return () => void context.clearContext?.();
  }, []);

  return null;
}
