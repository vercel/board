// What a run is, as the form sends it and the board keeps it: a run's thread carries its config as
// JSON, so anyone reading the board sees exactly what its agents were told.

import { SCENARIOS, type Scenario } from "../sandbox/shared.ts";
import type { Model } from "./models.ts";

export { SCENARIOS, type Scenario };

export type Config = {
  /** What people call it: the run thread's first line. */
  title: string;
  /** The repo it works on: `owner/name` on GitHub, one the GitHub app is installed on. */
  repo: string;
  /** What the swarm should do, in words. Every agent reads it. */
  goal: string;
  scenario: Scenario;
  /** The model every agent runs, by its AI Gateway ID. */
  model: string;
  /** How many agents work the queue, each in a sandbox of its own. */
  agents: number;
  /** What the run may spend on models, in dollars, or null for no cap. */
  budgetUsd: number | null;
  /** How long the run goes at most, or null for no cap (then `MAX_MINUTES`). */
  minutes: number | null;
};

/**
 * The most agents a run has. Agents share 16 board profiles (`profileOf`), so the number isn't held
 * to the board's 20 profiles. What does hold a big run back: every agent writes as this one project,
 * and Vercel's board takes 300 writes a minute from one caller; your team's sandbox concurrency; and
 * AI Gateway's rate limits for the model.
 */
export const MAX_AGENTS = 256;

/** The longest a run goes: a sandbox's own limit, with room to stop. */
export const MAX_MINUTES = 240;

export const DEFAULTS: Config = {
  title: "",
  repo: "",
  goal: "",
  scenario: "pipeline",
  model: "anthropic/claude-sonnet-5.5",
  agents: 4,
  budgetUsd: 10,
  minutes: 30,
};

/** What each scenario is, for the form. */
export const ABOUT_SCENARIO: Record<Scenario, { label: string; about: string }> = {
  pipeline: {
    label: "Pipeline",
    about: "A planner splits the goal into tasks. Agents take one each and open a pull request, and another agent reviews it.",
  },
  review: {
    label: "Review",
    about: "Agents read the repo an area each, a second agent checks what they found, and one writes the report. Nothing is pushed.",
  },
};

/** How many work tasks a pipeline's plan makes, and how many areas a review reads: a couple per agent. */
export const taskCap = (agents: number) => Math.min(TASK_MAX, Math.max(3, agents * 2));

/** The most tasks one plan or one review splits into: a planner writes its plan in one reply, and more than this doesn't fit one. */
export const TASK_MAX = 120;

const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** A whole number in its range, the fallback when there's none, or null when it was left empty and `optional`. */
function whole(value: unknown, fallback: number, min: number, max: number): number;
function whole(value: unknown, fallback: number | null, min: number, max: number, optional: true): number | null;
function whole(value: unknown, fallback: number | null, min: number, max: number, optional = false): number | null {
  if (optional && (value === null || value === "" || value === undefined)) return null;
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

/** `owner/name`, as GitHub writes it, from that or from a GitHub URL. Null for anything else. */
export function githubRepo(repo: string): string | null {
  const match = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(repo.trim());
  return match ? match[1]! : null;
}

/** A model's AI Gateway ID: `creator/model`. */
const MODEL = /^[\w.-]+\/[\w.:-]+$/;

/**
 * A config from whatever the form sent, every number held to its range, or what's wrong with it in
 * words a person can act on. It's the only way a config is made, so a run the board holds was
 * checked here.
 */
export function parseConfig(input: unknown): { config: Config } | { problem: string } {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const repo = githubRepo(text(raw.repo, 200));
  const config: Config = {
    title: text(raw.title, 120),
    repo: repo ?? "",
    goal: text(raw.goal, 6_000),
    scenario: SCENARIOS.includes(raw.scenario as Scenario) ? (raw.scenario as Scenario) : DEFAULTS.scenario,
    model: text(raw.model, 100),
    agents: whole(raw.agents, DEFAULTS.agents, 1, MAX_AGENTS),
    budgetUsd: whole(raw.budgetUsd, null, 1, 10_000, true),
    minutes: whole(raw.minutes, null, 5, MAX_MINUTES, true),
  };
  if (!config.repo) return { problem: "Pick the repo the swarm works on." };
  if (config.goal.length < 15) return { problem: "Say what the swarm should do: its agents read nothing else about it." };
  if (!MODEL.test(config.model)) return { problem: "Pick the model the agents run." };
  if (config.budgetUsd === null && config.minutes === null) return { problem: "Give the run a budget, a time limit, or both, so it stops on its own." };
  if (!config.title) config.title = config.goal.split("\n", 1)[0]!.slice(0, 80);
  return { config };
}

/** A budget holds a run only when its model has a price: without one, what the agents spend reads as nothing. */
export function priced(config: Config, models: Model[]): string | null {
  if (config.budgetUsd === null) return null;
  if (models.some((model) => model.id === config.model)) return null;
  return `AI Gateway lists no price for ${config.model}, so a budget can't hold it. Pick a listed model, or use only a time limit.`;
}

/** When a run started at `start` stops at the latest. */
export const deadlineOf = (config: Config, start: number) => start + (config.minutes ?? MAX_MINUTES) * 60_000;

/** A run thread's text: its title, then its config as the JSON `readConfig` reads back. */
export const runText = (config: Config) => `${config.title}\n\n\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\``;

/** The config a run thread carries, or null for a thread that isn't one. */
export function readConfig(threadText: string): Config | null {
  const match = /```json\n([\s\S]*?)\n```/.exec(threadText);
  if (!match) return null;
  try {
    const parsed = parseConfig(JSON.parse(match[1]!));
    return "config" in parsed ? parsed.config : null;
  } catch {
    return null;
  }
}
