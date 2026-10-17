import { board } from "vboard";
import { slack } from "vboard/adapter-slack";
import { github } from "vboard/adapter-github";
import { vercelBlob } from "vboard/adapter-vercel-blob";
import { queues, store } from "./a2";
import { byAgent, byPi, byWatcher, piTokens, taskMessage, tellPi } from "./agent";
import { classifyThread } from "./classify";
import { isPiKind, PI_KINDS, piTask, scheduled, scheduledThread } from "./kinds";
import { security } from "./security";
import { shipit } from "./shipit";
import { autoland } from "./autoland";
import { owner } from "./owner";
import { crosspost } from "./crosspost";
import { guard } from "./guard";
import { renderForSlack } from "./render";
import { boardOnly, unseenPr } from "./quiet";
import { asksPi, isDraft, reviewStarts } from "./review";
import { CONNECTOR, REPO } from "./github";
import { vercelTrustedSources } from "./trusted-sources";

// The software factory: vboard running on its own repo and Vercel's Slack. Its log is
// in `a2.ts`; locally there's no VERCEL_ENV, so attachments are files in .a2/attachments.
const env = process.env.VERCEL_ENV;

// SSE streams close just before this, and clients reconnect from their cursor.
export const maxDuration = 300;

const factory = board({
  access: vercelTrustedSources(process.env.VBOARD_TRUSTED_SOURCES),
  store,
  // Attachments (Pi's proof of work) in the project's private Blob store, `vboard-factory-attachments`.
  // Every deployment shares it: a file's ID is random, and only its board can name it.
  blob: env ? vercelBlob() : undefined,
  scheduler: queues,
  sync: {
    // Connect connectors: vboard builds the adapters, and people who sign in
    // (`vb identity link slack`) post as themselves.
    slack: slack({
      adapter: "slack/vboard-factory",
      render: renderForSlack,
      channels: {
        // #development-messageboard
        C0C8XN8SQRG: "dev",
      },
    }),
    github: github({
      adapter: CONNECTOR,
      repos: {
        [REPO]: {
          // Inline review threads and "closed by …" replies stay on GitHub and the board,
          // out of Slack: top-level comments, review verdicts and merges still go through.
          // Comments on a PR the board has no thread for stay on GitHub.
          pulls: {
            channel: "dev",
            run: async ({ event, board }) => {
              if (await unseenPr(event, board, "dev")) return;
              await board.sync("dev", event, { noSync: boardOnly(event) });
            },
          },
          issues: "dev",
        },
      },
    }),
  },
  // Every message from Slack, GitHub, or CI is checked for prompt injection before it lands.
  // Shadow mode: a flagged one is labeled guard=injection, and nothing is dropped yet.
  middleware: [guard({ mode: "shadow" })],
  watch: {
    shipit: shipit({ tellPi }),
    // Shadow mode: labels each reviewed factory PR autoland=would|no, and merges nothing.
    autoland: autoland(),
    // A factory PR's root names whose it is: the person who opened its source thread.
    owner: owner(),
    // A factory PR's Slack thread and the Slack thread it was built for link to each other.
    crosspost: crosspost(),
    security: security({ tellPi }),
    // Every non-PR dev thread gets a kind, judged from all of it whenever a person posts,
    // so a chat that turns into a bug report becomes kind=bug. Bugs get 🐛 in Slack too.
    // An agent's post (a coding agent sharing progress) isn't judged: a thread an agent
    // opens gets a kind once a person replies in it.
    "triage-gpt": {
      tail: "dev",
      run: async ({ event, board }) => {
        const message = event.message;
        if (
          event.type !== "message.posted" ||
          !message ||
          byPi(message.re ?? message.id, message.by) ||
          byWatcher(message.by) ||
          byAgent(message.by) ||
          scheduledThread(message)
        ) {
          return;
        }
        const thread = await board.thread(message.re ?? message.id);
        if (thread.message.labels.pr) {
          return;
        }
        const kind = await classifyThread(
          [thread.message, ...thread.replies].map((m) => ({
            from: m.author?.name ?? m.by.actor,
            text: m.text,
          })),
        );
        if (thread.message.labels.kind === kind) {
          return;
        }
        await board.label(thread.message.id, { set: { kind } });
        if (kind === "bug") {
          await board.react(thread.message.id, "bug");
        }
      },
    },
    // Pi watches every thread worth acting on (bugs, features, questions, tasks; not noise): it
    // gets the thread once triage gives it one of those kinds, is told again if the kind
    // changes, and hears when anyone else replies, then reads what's new itself.
    pi: {
      tail: `dev --label kind=${PI_KINDS.join("|")}`,
      run: async ({ event, board }) => {
        const message = event.message;
        if (!message) {
          return;
        }
        const kind =
          event.type === "labels.changed"
            ? event.payload.set.kind
            : event.type === "message.posted"
              ? scheduledThread(message) ?? undefined
              : undefined;
        if (kind && isPiKind(kind) && message.re === null) {
          await tellPi({
            board,
            task: "thread",
            thread: message.id,
            key: `kind-${kind}`,
            message: taskMessage(piTask(kind), message),
          });
        } else if (
          event.type === "message.posted" &&
          message.re !== null &&
          (scheduled(message) || !byPi(message.re, message.by)) &&
          !byWatcher(message.by)
        ) {
          await tellPi({
            board,
            task: "thread",
            thread: message.re,
            key: `news-${message.id}`,
            message: `There's new activity in board thread #${message.re}.`,
          });
        }
      },
    },
    // Pi reviews PRs once they're ready: a PR opened ready when its thread opens in `dev`, a
    // draft when it's marked ready (its root relabeled state=open). Pi hears when anyone but a
    // bot (Vercel's deploy comments, CI) replies there, except that in a draft only a reply
    // asking Pi itself, or a reminder Pi scheduled, wakes it. Only PR threads: `--label pr` matches a reply by its root's
    // labels too.
    "review-pi": {
      tail: "dev --label pr",
      run: async ({ event, board }) => {
        const message = event.message;
        if (!message) {
          return;
        }
        if (reviewStarts(event)) {
          await tellPi({
            board,
            task: "review",
            thread: message.id,
            key: "pr",
            message: `There's a pull request to review in board thread #${message.id}.`,
          });
        } else if (
          event.type === "message.posted" &&
          message.re !== null &&
          (scheduled(message) || !byPi(message.re, message.by)) &&
          !message.author?.handle.endsWith("[bot]") &&
          !byWatcher(message.by) &&
          // In a draft, a reminder Pi scheduled for itself still reaches it.
          ((scheduled(message) && byPi(message.re, message.by)) ||
            asksPi(message.re, message.text) ||
            !isDraft((await board.thread(message.re)).message.labels))
        ) {
          await tellPi({
            board,
            task: "review",
            thread: message.re,
            key: `news-${message.id}`,
            message: `There's new activity in board thread #${message.re}.`,
          });
        }
      },
    },
  },
});

export const { GET, POST } = factory;
// The board's queue also delivers the refreshes of Pi's tokens.
export const scheduler = queues.handler(...factory.servers, piTokens.server);
