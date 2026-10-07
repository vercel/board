import * as a2 from "experimental-a2";
import { idempotentId } from "experimental-a2";
import { createServer, type A2Scheduler, type A2Store } from "experimental-a2/server";
import { getToken } from "@vercel/connect";
import { z } from "zod";
import type { Watcher, WatcherContext } from "vboard";

// PR follow-ups: every PR the factory opens nags its DRI (whoever opened the board thread Pi
// built it for) until someone acts. Pings go 1h after the PR opens, then 2h, 4h, ... 64h later
// (7 in all, about 5 days). With no answer, the PR closes a week after it opened. A message from
// the DRI in the PR's thread or the source thread starts the whole cycle over; a merge or close
// ends it. Timers are A2's, and A2 can't cancel one: each carries the cycle it belongs to, and a
// timer from an older cycle, or for a stopped follow-up, does nothing when it fires.

/** The factory GitHub App's bot account: its PRs are the ones that get followed up. */
export const FACTORY_BOT = "github:user:338721338";
const HOUR = 60 * 60_000;
/** When each ping goes, in hours after the cycle starts: the gap doubles from 1h. */
export const PINGS_H = [1, 3, 7, 15, 31, 63, 127];
/** When an unanswered PR closes, in hours after the cycle starts. */
export const CLOSE_H = 7 * 24;

const contract = a2.contract({
  name: "vboard-factory-followups",
  events: {
    /** A factory PR opened: `source` is the board thread Pi built it for, `dri` the actor who opened it. */
    "followup.armed": z.object({ pr: z.number().int(), thread: z.number().int(), source: z.number().int(), dri: z.string() }),
    /** The DRI said something: the cycle starts over. */
    "followup.reset": z.object({}),
    /** A timer: ping `round` (1-7), or close the PR (round 8), if `cycle` is still the current one. */
    "followup.due": z.object({ cycle: z.string(), start: z.string(), round: z.number().int() }),
    /** Merged, closed, or closed by the follow-up itself: nothing more fires. */
    "followup.stopped": z.object({ reason: z.string() }),
    /** On a source thread's session: a follow-up whose DRI talks here. */
    "followup.linked": z.object({ thread: z.number().int() }),
  },
});

type Armed = z.infer<(typeof contract.events)["followup.armed"]>;
type Status = { armed: Armed | null; cycle: string | null; stopped: boolean };

const prSession = (thread: number) => `pr:${thread}`;
const sourceSession = (thread: number) => `source:${thread}`;

function status(history: { id: string; type: string; payload: unknown }[]): Status {
  const s: Status = { armed: null, cycle: null, stopped: false };
  for (const event of history) {
    if (event.type === "followup.armed") (s.armed ??= event.payload as Armed), (s.cycle ??= event.id);
    else if (event.type === "followup.reset" && !s.stopped) s.cycle = event.id;
    else if (event.type === "followup.stopped") s.stopped = true;
  }
  return s;
}

const prNumber = (label: string | undefined) => label?.match(/^basehub-ai\/vboard#([1-9]\d*)$/)?.[1];

const when = (date: Date) =>
  date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC";

export function followups(options: {
  store?: A2Store | undefined;
  scheduler?: A2Scheduler | undefined;
  /** A board client for the follow-up's own posts, idempotent per `key`. */
  client: (key: string) => Pick<WatcherContext["board"], "reply">;
  token?: () => Promise<string>;
  fetch?: typeof fetch;
}) {
  const request = options.fetch ?? globalThis.fetch;
  async function github(path: string, method = "GET", body?: object) {
    const token = await (options.token?.() ?? getToken("github/vboard-factory", { subject: { type: "app" } }));
    const response = await request(`https://api.github.com/repos/basehub-ai/vboard${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2026-03-10",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? `GitHub returned ${response.status}`);
    return data;
  }

  /** Arms round 1 for the cycle `ctx.event` starts. */
  const startCycle = async (ctx: { event: { id: string; createdAt: Date }; session: any }) => {
    const start = ctx.event.createdAt;
    await ctx.session.schedule("round-1", { at: new Date(start.getTime() + PINGS_H[0]! * HOUR) }, {
      type: "followup.due",
      payload: { cycle: ctx.event.id, start: start.toISOString(), round: 1 },
    });
  };

  const server = createServer({
    contract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    handlers: {
      "followup.armed": startCycle,
      "followup.reset": async (ctx) => {
        const s = status(await ctx.session.history());
        if (!s.stopped && s.cycle === ctx.event.id) await startCycle(ctx);
      },
      "followup.due": async (ctx) => {
        const s = status(await ctx.session.history());
        const { cycle, round } = ctx.event.payload;
        if (!s.armed || s.stopped || s.cycle !== cycle) return;
        const { pr, thread, source, dri } = s.armed;
        const start = new Date(ctx.event.payload.start);
        const closes = new Date(start.getTime() + CLOSE_H * HOUR);
        const board = options.client(ctx.event.id);
        if (round <= PINGS_H.length) {
          await board.reply(
            thread,
            `@[${dri}] reminder ${round}/${PINGS_H.length}: PR #${pr} (from #${source}) is waiting on you. Merge it, ask for changes, or close it. A reply from you here or in #${source} restarts these; otherwise it closes ${when(closes)}.`,
          );
          const next = round < PINGS_H.length ? PINGS_H[round]! : CLOSE_H;
          await ctx.session.schedule(`round-${round + 1}`, { at: new Date(start.getTime() + next * HOUR) }, {
            type: "followup.due",
            payload: { cycle, start: ctx.event.payload.start, round: round + 1 },
          });
          return;
        }
        const current = await github(`/pulls/${pr}`);
        if (current.state === "open") {
          await github(`/pulls/${pr}`, "PATCH", { state: "closed" });
          await board.reply(thread, `@[${dri}] closed PR #${pr} after a week with no response. Reopen it on GitHub, or reply in #${source}, to pick it back up.`);
        }
        await ctx.session.append("stopped", { type: "followup.stopped", payload: { reason: current.merged ? "merged" : "closed" } });
      },
    },
  });

  const statusOf = async (thread: number) => status(await server.session(prSession(thread)).history());

  const watcher: Watcher = {
    tail: "dev",
    run: async ({ event, board }) => {
      const message = event.message;
      if (!message) return;
      // A factory PR's thread opens: find the thread it was built for (its pi/<thread> branch) and who opened that.
      if (event.type === "message.posted" && message.re === null && message.by.actor === FACTORY_BOT) {
        const pr = prNumber(message.labels.pr);
        if (!pr) return;
        const source = Number((await github(`/pulls/${pr}`)).head?.ref?.match(/^pi\/([1-9]\d*)$/)?.[1]);
        if (!source) return;
        const root = (await board.thread(source).catch(() => null))?.message;
        if (!root || root.re !== null || root.by.profile !== null || root.by.actor === FACTORY_BOT) return;
        await server.session(sourceSession(source)).append({
          type: "followup.linked",
          id: await idempotentId("followup-linked", String(message.id)),
          payload: { thread: message.id },
        });
        await server.session(prSession(message.id)).append({
          type: "followup.armed",
          id: await idempotentId("followup-armed", String(message.id)),
          payload: { pr: Number(pr), thread: message.id, source, dri: root.by.actor },
        });
        return;
      }
      // Merged or closed (by anyone, the follow-up included): it's over.
      if (event.type === "labels.changed" && message.re === null) {
        const state = event.payload.set.state;
        if (state !== "merged" && state !== "closed") return;
        if (!(await statusOf(message.id)).armed) return;
        await server.session(prSession(message.id)).append({
          type: "followup.stopped",
          id: await idempotentId("followup-stopped", String(event.index)),
          payload: { reason: state },
        });
        return;
      }
      // The DRI wrote in the PR's thread or the thread it came from: start over.
      if (event.type === "message.posted") {
        const thread = message.re ?? message.id;
        const linked = (await server.session(sourceSession(thread)).history())
          .filter((e) => e.type === "followup.linked")
          .map((e) => (e.payload as { thread: number }).thread);
        for (const pr of new Set([thread, ...linked])) {
          const s = await statusOf(pr);
          if (!s.armed || s.stopped || s.armed.dri !== message.by.actor) continue;
          await server.session(prSession(pr)).append({
            type: "followup.reset",
            id: await idempotentId("followup-reset", String(pr), String(event.index)),
            payload: {},
          });
        }
      }
    },
  };

  return { server, watcher };
}
