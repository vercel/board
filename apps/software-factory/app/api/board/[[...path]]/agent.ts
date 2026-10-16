import type { NetworkPolicy, Sandbox } from "@vercel/sandbox";
import type { WatcherContext } from "vboard";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vboard from "vboard/package.json" with { type: "json" };
import { queues, store } from "./a2.ts";
import { CONNECTOR, REPO } from "./github.ts";
import { expiresAt, tokenRefreshes } from "./tokens.ts";

// Pi, the coding agent, working on a board thread from its own Vercel Sandbox: the
// `pi` CLI with `vb`, `gh`, and git, like a developer at a terminal. Each thread gets
// one sandbox and one Pi session, so a later message continues the same work.
// Credentials are placeholders inside the sandbox; its network policy puts the real
// ones on the wire, so nothing in the sandbox can read them.

/** The production board the agent's `vb` talks to. */
const BOARD = "https://vboard-factory.playground-vercel.tools/api/board";
const MODEL = "anthropic/claude-opus-5.5";
/** The first Pi release that knows MODEL on AI Gateway. */
const PI = "@earendil-works/pi-coding-agent@1.0.0";
/**
 * The `vb` Pi runs: the vboard this deployment was built with, so each release reaches Pi
 * with no hand-made bump. A thread's sandbox outlives releases, so setup upgrades it in place.
 */
const VBOARD: string = vboard.version;
/**
 * The `gh` a new sandbox gets, pinned too: asking GitHub's API for the latest release goes out without
 * credentials (setup runs before the network policy), and sandboxes share that rate limit, so new
 * threads' setup failed on a 403.
 */
const GH = "2.102.0";
/** What installs the Chrome Pi uses on its desktop (and drives headless, when it wants), pinned like gh. */
const AGENT_BROWSER = "0.38.2";
/** ffmpeg 6.0, a static build with libass, so captions can be burned in. */
const FFMPEG_STATIC = "5.2.0";
/** The user Pi runs as, whose home its skills and agent-browser's Chrome go in. */
const PI_USER = "vercel-sandbox";
/**
 * What Pi gets on top of its own, written into `~/.pi/agent` every turn from this app's folders of the same names:
 * the ui-video skill, and the computer tool (an extension) it records, the verify-vboard skill, which runs
 * vboard on a local board to reproduce and check changes to it, the sitrep skill, and the pr-description skill, for the PRs Pi opens.
 */
const PI_FILES = [
  "skills/ui-video/SKILL.md",
  "skills/ui-video/scripts/ui-video",
  "skills/verify-vboard/SKILL.md",
  "skills/verify-vboard/scripts/verify-vboard",
  "skills/sitrep/SKILL.md",
  "skills/pr-description/SKILL.md",
  "extensions/computer/index.ts",
  "extensions/computer/xinput.py",
];
/**
 * A sandbox session ends at a fixed deadline, not after idling; its files come back with the next one.
 * Each message gets at least this long before it, so a turn that starts late in a session isn't cut off.
 */
const SANDBOX_MS = 45 * 60_000;
const SNAPSHOT_MS = 7 * 24 * 60 * 60_000;
/**
 * The factory GitHub App's token for a sandbox: one that outlives the session it's handed to. Connect
 * caches tokens and by default hands out any with 30s left, so a turn could start with a token that dies
 * minutes in (board thread #2331). A session ends at most SANDBOX_MS after a message, and the next
 * message brings a new token, so one valid for SANDBOX_MS covers it. GitHub's last 60 minutes.
 */
export const GITHUB_TOKEN = { subject: { type: "app" }, validityBufferMs: SANDBOX_MS } as const;

/**
 * Pi's git, with no token of ours: Sandbox git credentials (a private beta, flagged on for this project) start
 * the sandbox as a clone of the repo in /vercel/sandbox, and a broker clones, fetches and pushes for it as the
 * Vercel GitHub App, within the project's bound (`git:write` on the repo). The broker signs each push, with
 * vercel[bot] as author and `__commitAs` as co-author. Smaller sandboxes come from a warm pool that lacks the
 * credential helper, so it takes 6 vCPUs.
 */
const GIT = {
  source: { type: "git", url: `https://github.com/${REPO}.git` },
  resources: { vcpus: 6 },
  __source_credentials: true,
} as const;
const GIT_EMAIL = "pi@vboard-factory.playground-vercel.tools";

/** A thread's Pi session, on the board and in the sandbox. */
const piSession = (thread: number) => `thread-${thread}`;

const ADJECTIVES = [
  "amber", "brave", "brisk", "calm", "clever", "cosmic", "crisp", "dapper",
  "eager", "fuzzy", "gentle", "glad", "golden", "humble", "jolly", "keen",
  "lucky", "lively", "mellow", "merry", "nimble", "plucky", "quiet", "rapid",
  "rusty", "shy", "snappy", "sunny", "swift", "tidy", "witty", "zesty",
];
const ANIMALS = [
  "badger", "beaver", "bison", "crane", "falcon", "ferret", "finch", "fox",
  "gecko", "heron", "ibis", "koala", "lemur", "lynx", "marmot", "moose",
  "newt", "otter", "owl", "panda", "puffin", "quokka", "raven", "robin",
  "seal", "sloth", "stoat", "tapir", "toucan", "walrus", "wombat", "yak",
];

/**
 * Who a thread's Pi is on the board: a name of its own, like `clever-lemur-1956 via vboard-factory`,
 * so people can tell one thread's Pi from another's. The words make it easy to tell apart at a glance;
 * the thread number makes it unique, since a profile is part of the actor's ID.
 */
export function piName(thread: number) {
  const n = Math.imul(thread, 0x9e3779b1) >>> 0;
  return `${ADJECTIVES[n % ADJECTIVES.length]}-${ANIMALS[(n >>> 8) % ANIMALS.length]}-${thread}`;
}

/**
 * A thread's Pi's picture, generated from its name so each Pi has its own: a PNG, since Slack
 * won't use the board's SVG avatars as a message's icon.
 */
export const piAvatar = (thread: number) =>
  `https://vercel.com/api/www/avatar?s=64&format=png&u=${encodeURIComponent(piName(thread))}`;

/**
 * Whether a message was written by the Pi working on `thread` (named `pi` before it had a name of its own). Every Pi
 * posts as the factory's production deployment, whose OIDC token its network policy adds; its profile and session
 * are headers anyone who can write may send, so they only say which thread's Pi it is.
 */
export const byPi = (thread: number, by: { principal: string; profile: string | null; session: string | null }) =>
  !!process.env.VERCEL_PROJECT_ID &&
  by.principal === `vercel:project:${process.env.VERCEL_PROJECT_ID}:production` &&
  (by.profile === piName(thread) || by.profile === "pi") &&
  by.session === piSession(thread);

/**
 * Whether a message is one of the board's watchers' own notes (a crosspost, `:security:`'s answer, or saying Pi
 * couldn't start), not a person's: it doesn't wake Pi or triage.
 */
export const byWatcher = (by: { actor: string }) => by.actor.startsWith("vboard:watch:");

/**
 * Whether a message was written by an agent profile (someone's coding agent, like `julian/claude`, or a Pi), not
 * a person: a coding agent sharing its progress in `dev` shouldn't get a kind, and with it, Pi.
 */
export const byAgent = (by: { profile: string | null }) => by.profile !== null;

/** The Slack workspace the factory syncs with. */
const SLACK = "https://vercel.slack.com";

/**
 * Where a thread came from, as a link Pi can put in its PR: a Slack thread's permalink or a GitHub issue or PR.
 * `origin.thread` is the sync target: `slack:C0123:1727000000.123456`, `github:owner/repo:issue:12`, `github:owner/repo:12`.
 */
export function sourceLink(origin: { thread: string } | null | undefined) {
  const thread = origin?.thread ?? "";
  const slack = /^slack:([A-Z0-9]+):(\d+)\.(\d+)$/.exec(thread);
  if (slack) return { platform: "Slack", url: `${SLACK}/archives/${slack[1]}/p${slack[2]}${slack[3]}` };
  const gh = /^github:([^/:]+\/[^/:]+):(issue:)?(\d+)$/.exec(thread);
  if (gh) return { platform: "GitHub", url: `https://github.com/${gh[1]}/${gh[2] ? "issues" : "pull"}/${gh[3]}` };
  return null;
}

/** The task message that starts Pi on a thread, with where it came from when it's synced. */
export function taskMessage(
  task: string,
  thread: { id: number; origin: { thread: string } | null; author?: { name: string } | null },
) {
  const source = sourceLink(thread.origin);
  const by = thread.author?.name ? ` by ${thread.author.name}` : "";
  return `There's ${task} in board thread #${thread.id}${source ? `, posted${by} on ${source.platform}: ${source.url}` : ""}.`;
}

/** What Pi does in a thread: work a firehose thread (bug, feature, question, task), or review a pull request. */
export type Task = "thread" | "review";

/** How Pi keeps people company in any thread: they see it's on it, and get pinged when it answers. */
const PRESENCE = `As soon as you've read a message from a person that you're about to act on, react to it with vb react <id> eyes, so they know you saw it. When it asks for work that takes more than a quick look (a fix, a rebase, a new demo, a build), make your first reply, before you clone, read code, or run anything, one line saying what you're about to do, so nobody wonders whether you're stuck.
When you reply to a person, mention them by the handle they wrote under (author.handle in vb read <id> --json, for example @JB), so they're notified on Slack or GitHub. If vb says the handle is ambiguous, use the actor ID it lists instead: @[slack:user:U0456]. Mention each person once, not in every line.
You hear about every reply in your threads, but most aren't for you. When a message is addressed to someone else (it @mentions another person, or answers someone else's question) and doesn't ask anything of you, don't reply and don't react; stay quiet unless you're asked.
Board replies are read on Slack by busy people: keep each to a few lines. Lead with the outcome (the PR link, the answer, the one question you need answered), skip background they already know, and use a short list only when there are real options to pick from. No "What I ran" lists, and no recaps of the thread, including messages synced from GitHub (PR descriptions, reviews and comments, yours too): point at them instead, and say each thing once; the attachments and the PR carry the detail.
Sound like a teammate in the channel, not a report: plain, direct sentences, the way the people in the thread write, minus their slang. Don't put on a casual voice ("lol", "bro", "fair", memes); match their directness, not their spelling. Start with the answer itself, not a preamble ("Not sure which you mean, so both", "Good question") or a label ("Done:", "Outcome:"). Don't hedge or pile on caveats, and leave out file paths, identifiers and API names unless someone asked where or how something works. End when you've said it: ask a question only when you need the answer to go on. Banter doesn't need an answer; when someone asks you something light, a short, light answer is fine.`;

/** Thread work only: a review's board reply adds what the review lacks, or nothing, so it posts no progress. */
const PROGRESS = `Each vb reply reaches Slack right away, so you can post several replies in one turn instead of saving everything for the end. When the work will take more than a quick look (cloning, reproducing, running tests, building a fix), before you start, post a one-line reply saying what you're about to do, so people aren't left waiting in silence. On long jobs, post a line when you reach a milestone (reproduced it, found the cause, PR opened), then finish with the outcome as above. A quick answer is just the answer, in one reply.`;

const DIRECTION = `Your initial task is a starting point. People can redirect you in the thread at any time; follow their latest instructions even when they change the task, including fixing code, pushing changes, approving, marking a draft ready, merging, or closing a PR.
A person's :shipit: or :approved: reaction is a request to complete the merge. Inspect the PR, resolve the blockers you can, mark it ready if needed, and merge it when GitHub's checks and review requirements allow. Carry that intent through without requiring another reaction. If you need someone else's action, ask them in the thread and explain what's still blocking it.
A person's :security: reaction on a PR is a request for a deepsec review of its diff. React :secure: on the root only when deepsec exits 0.`;

const THREAD = `You own bug reports, feature requests, and questions for vboard (github.com/${REPO}, private), a message board library and CLI.
The board is how you talk to people. vb read <id> shows a thread, vb reply <id> "<text>" answers in it (and reaches Slack or GitHub when the thread is synced), vb label <id> k=v labels it. Run vb help for the rest.
A thread's kind label (bug, feature, question, task) says what it is; judge it yourself from the whole thread too. Clone with gh repo clone ${REPO}; the repo uses pnpm (pnpm install, pnpm test). Any change you make goes on a branch named pi/<thread id> (never main), in a pull request opened with gh pr create, and you reply with the PR link.
Open the PR body with one line saying what triggered it, before anything else: "> 💬 From [<who>'s Slack thread](<link>) · board #<id>" for Slack, "> 🐙 From #<issue> on GitHub · board #<id>" for a GitHub issue (with "Closes #<issue>" below when the PR fixes it), or "> From board #<id>" when the thread has no source. Your task message gives the source link and who posted it.
Before you plan or build for a bug or feature, look for related work: search earlier threads with vb read dev --text <keywords> and pull requests with gh pr list --state all --search <keywords>. If a thread or PR already covers it, link it in your reply and build on it (comment there, push to its branch, or ask to merge it) instead of starting over with a duplicate.
For a bug report:
1. Reproduce it with a failing test.
2. If you reproduced it, label the thread reproduced=yes, fix it, and open a PR.
3. If you can't reproduce it, or it isn't a bug, label it reproduced=no and reply with why. If the thread came from a GitHub issue, close the issue with gh issue close and say why there too.
For a feature request: if it's clear what's wanted, build it with tests and open a PR. If it's ambiguous or large, reply with a short plan or your questions first, and build it once someone agrees.
For a question: answer it from the code and docs, pointing at the files. Don't open a PR unless someone asks for one.
For a task (someone asks you to do something, like a recap or an investigation): do it with what the board, the repo and GitHub show you, and reply with the result.
Show your work only when it's worth looking at: when the change is something people can see and you can capture it, attach a screenshot to the reply that links the PR, with --attach <file> (up to 4 MB). When a change touches UI, prefer showing people it works over telling them: for a flow they click through, attach a captioned video of it working instead, using the ui-video skill and your computer tool. Don't attach test runs or logs of your own checks: the tests go in the PR, and for a bug, name the test that reproduces it in the PR body. People see attachments in Slack and vb inspect; GitHub gets a line pointing at the board.
vb read lists a message's files as file lines with an ID; vb download <id> saves one, so look at screenshots and logs people attach.
When you're told there's new activity in a thread, read it, see what's new since you last replied, and act on it if it's for you.
Your PR's reviewer posts its verdict in your thread after each review; that's for you. If it found problems, read the review on GitHub (gh pr view <N> --comments), check for commits since it (someone in the PR thread may already be fixing them), fix what's left on the PR's branch, and push. Then reply in the PR's board thread (the root labeled pr=${REPO}#<N>) in one line saying what you pushed: a push alone doesn't reach the board, and that reply is what gets the reviewer to look again. Unless a person said otherwise, don't reply to a review that found nothing to fix.`;

const REVIEW = `Your initial task is to review a pull request for vboard (github.com/${REPO}, private), a message board library and CLI.
The board is how you talk to people. vb read <id> shows a thread, vb reply <id> "<text>" answers in it (and reaches Slack and the PR on GitHub), vb label <id> k=v labels it. Run vb help for the rest.
For a pull request (its board thread's root has a pr=owner/repo#N label):
Before anything else, react to the PR thread's root with vb react <root id> looking-bunny, so people see a review is underway, also when you start reviewing again after new commits. Take it off with vb react <root id> looking-bunny --remove once you've labeled land in step 4.
1. Clone with gh repo clone ${REPO}, then gh pr checkout <N>. Read gh pr view <N> and gh pr diff <N>, and SPEC.md and AGENTS.md for the parts it touches.
2. Run pnpm install and pnpm check. Try the change where you can: a test that should fail without it, or the CLI by hand.
3. Put the detail on GitHub, attached to the code: submit one review with gh api repos/${REPO}/pulls/<N>/reviews --input review.json (event COMMENT, REQUEST_CHANGES or APPROVE, with comments on file:line for each problem and suggestion). You review as the factory GitHub App's bot, and GitHub rejects APPROVE and REQUEST_CHANGES on that account's own PRs, so on a PR it opened use COMMENT and put the verdict in the body. Inline comments must be on lines the diff touches, or GitHub rejects the whole review; put anything else in the body. Always put the verdict in the body, even when the problems are all inline (a review with an empty body never reaches the board), and keep the body short: the verdict (good to merge, or the blocking problems in a line each), with the detail in the inline comments. The review shows up in the board thread and on Slack on its own, so don't restate it there: reply in the board thread only to add what it lacks, in a line (the mention of whoever asked, or what you tried by hand attached with --attach <file>, a log or a screenshot, up to 4 MB each), or not at all. vb read lists files people attached as file lines; vb download <id> saves one.
4. After each review, say whether the PR could land without a person, in one command on the PR thread's root: vb label <root id> land=yes|no land.why="<one line>" land.sha=<the head SHA you reviewed>. Say yes only when all of these hold: it fixes a bug or does what a person clearly asked for (not something you or its author had to interpret); your review found nothing to fix; and it has no caveats, open questions, or negative tradeoffs (in its body, in the thread, or that you see). Otherwise say no, and land.why says which one failed. When unsure, say no. The board checks the rest itself: who opened it, CI, and whether it changes vboard core for users.
5. Tell the thread the work started in. When the PR was built for another board thread (its branch is pi/<id>, and the PR thread has a ":crosspost: From … · board #<id>" reply), reply there after each review, in one line: the verdict (good to merge, or what blocks it, briefly) and that the detail is in the review on PR #<N>. That thread's Pi, the PR's author, hears it and can fix what you found, and the person who asked sees it where they asked. Don't mention anyone there, and don't restate the review.
When you're told there's new activity in a thread, read it, see what's new since you last replied, and act on it if it's for you: answer questions, and review again if new commits landed (gh pr view <N> --json commits), labeling land again.`;

export const INSTRUCTIONS: Record<Task, string> = {
  thread: `${THREAD}\n${PRESENCE}\n${PROGRESS}\n${DIRECTION}`,
  review: `${REVIEW}\n${PRESENCE}\n${DIRECTION}`,
};

export const SETUP = `set -e
command -v pi >/dev/null || npm install -g ${PI} pnpm >/dev/null 2>&1
# Pinned like pi. If that release isn't on npm yet, a vb already here stays, and a new sandbox gets the latest.
[ "$(vb --version 2>/dev/null)" = "${VBOARD}" ] || npm install -g vboard@${VBOARD} >/dev/null 2>&1 || command -v vb >/dev/null || npm install -g vboard >/dev/null 2>&1
command -v gh >/dev/null || {
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH}/gh_${GH}_linux_amd64.tar.gz" | tar xz -C /tmp
  install "/tmp/gh_${GH}_linux_amd64/bin/gh" /usr/local/bin/gh
}
# For the computer tool and the ui-video skill: a virtual desktop, its keyboard and mouse (XTEST), Chrome, and ffmpeg.
# Pi can work without them, so a failed install doesn't stop setup; the next turn tries again.
command -v Xvfb >/dev/null || dnf install -y -q xorg-x11-server-Xvfb libXtst >/dev/null 2>&1 || true
command -v ffmpeg >/dev/null || { npm install -g ffmpeg-static@${FFMPEG_STATIC} >/dev/null 2>&1 \
  && ln -sf "$(npm root -g)/ffmpeg-static/ffmpeg" /usr/local/bin/ffmpeg; } || true
[ "$(agent-browser --version 2>/dev/null)" = "agent-browser ${AGENT_BROWSER}" ] || { npm install -g agent-browser@${AGENT_BROWSER} >/dev/null 2>&1 \
  && HOME=/home/${PI_USER} agent-browser install --with-deps >/dev/null 2>&1 && chown -R ${PI_USER}: /home/${PI_USER}/.agent-browser; } || true`;

/**
 * One message, once: KEY marks it delivered, so a retried watcher doesn't send it
 * twice. The lock queues it behind a turn that's still running, and the session ID
 * makes it a continuation of everything Pi has done in this thread.
 * A `news-` message only says there's something new, and Pi reads what's new itself, so
 * news piled up behind a turn wakes Pi once, for the newest: otherwise each reply (most
 * not for Pi) costs a full turn before the next one, and an ack waits minutes.
 */
export const TELL = `mkdir -p ~/.pi/told
[ -e ~/.pi/told/"$KEY" ] && exit 0
touch ~/.pi/told/"$KEY"
case "$KEY" in news-*) echo "$KEY" > ~/.pi/news ;; esac
cd ~ && exec flock ~/.pi/lock bash -c '
  case "$KEY" in news-*) [ "$(cat ~/.pi/news)" = "$KEY" ] || exit 0 ;; esac
  exec pi -p --provider vercel-ai-gateway --model "$MODEL" --session-id "$SESSION" \\
    --append-system-prompt "$INSTRUCTIONS" "$MESSAGE"' >> ~/pi.log 2>&1`;

/**
 * The preview of Pi's own branch, `pi/<thread>`: its branch URL on the factory's preview domain. Pi's network policy
 * gets it past Vercel Authentication. Only this host: `*.playground-vercel.tools` would also hand the bypass secret
 * to every other deployment on that domain.
 */
export const piPreview = (thread: number) => `vboard-factory-git-pi-${thread}.playground-vercel.tools`;

/**
 * Real credentials on the way out: the deployment's OIDC token, and the factory GitHub App's.
 * On the board, the policy also sets who Pi is, so nothing in the sandbox can post as anyone else.
 */
export function policy(
  thread: number,
  tokens: { gateway: string; board: string; github: string },
  bypass: string | undefined,
): NetworkPolicy {
  const protection = bypass ? { "x-vercel-protection-bypass": bypass } : {};
  // git itself goes through the sandbox's git credentials (`GIT`), so only the API gets the app's token.
  return {
    allow: {
      // Pi speaks the Anthropic messages API to AI Gateway, which reads x-api-key.
      "ai-gateway.vercel.sh": [
        { transform: [{ headers: { "x-api-key": tokens.gateway, authorization: `Bearer ${tokens.gateway}` } }] },
      ],
      [new URL(BOARD).host]: [
        {
          transform: [
            {
              headers: {
                authorization: `Bearer ${tokens.board}`,
                "x-board-profile": piName(thread),
                "x-board-avatar": piAvatar(thread),
                "x-board-session": piSession(thread),
                ...protection,
              },
            },
          ],
        },
      ],
      ...(bypass ? { [piPreview(thread)]: [{ transform: [{ headers: protection }] }] } : {}),
      "api.github.com": [{ transform: [{ headers: { authorization: `Bearer ${tokens.github}` } }] }],
      "*": [],
    },
  };
}

/** How much to extend a session ending at `expiresAt` so a turn starting `now` gets SANDBOX_MS: 0 if it already has that. */
export function extension(expiresAt: Date | undefined, now: number) {
  if (!expiresAt) return 0;
  return Math.max(0, SANDBOX_MS - (expiresAt.getTime() - now));
}

/** PI_FILES, as files in Pi's sandbox where pi finds them: scripts executable. */
export async function piFiles(root = process.cwd()) {
  return Promise.all(
    PI_FILES.map(async (file) => ({
      path: `/home/${PI_USER}/.pi/agent/${file}`,
      content: await readFile(join(root, file)),
      mode: file.includes("/scripts/") || file.endsWith(".py") ? 0o755 : 0o644,
    })),
  );
}

async function sh(sandbox: Sandbox, script: string) {
  const done = await sandbox.runCommand({ cmd: "bash", args: ["-c", script], sudo: true });
  if (done.exitCode !== 0) throw new Error(`sandbox setup failed: ${(await done.stderr()).slice(-500)}`);
}

/** How many times a message to Pi is tried before the thread hears Pi couldn't start, and the wait after a first failure. */
const TRIES = 3;
const RETRY_MS = 5_000;

/**
 * Runs `start` until it works, up to TRIES times, and if it never does, says so in the thread instead of throwing.
 * A watcher that throws is retried 10 times in about half a minute and then dead-lettered, which stops it on that
 * thread for good: one bad start (setup hitting GitHub's rate limit) left a thread's Pi deaf to every reply after it.
 * Saying so leaves the watcher listening, so the next reply tries again.
 */
export async function startOrSay(
  board: Pick<WatcherContext["board"], "reply">,
  thread: number,
  start: () => Promise<void>,
  retryMs = RETRY_MS,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await start();
    } catch (error) {
      if (attempt < TRIES) {
        await new Promise((resolve) => setTimeout(resolve, retryMs * attempt));
        continue;
      }
      console.error(`[factory] Pi couldn't start on board thread #${thread}:`, error);
      const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);
      await board.reply(thread, `Pi couldn't start: \`${reason}\`. Reply here to try again.`);
      return;
    }
  }
}

/**
 * Sends Pi a message about a thread: the first one is its task (a thread to work or a PR to review), later ones say
 * there's news. Pi's sandbox and session for the thread are created on first use. If Pi can't be reached, `board`
 * (the calling watcher's) says so in the thread; see `startOrSay`.
 * `key` names the message, so telling Pi the same thing twice is a no-op.
 */
export async function tellPi({ board, ...input }: PiMessage & { board: Pick<WatcherContext["board"], "reply"> }) {
  await startOrSay(board, input.thread, () => deliver(input));
}

type PiMessage = {
  task: Task;
  thread: number;
  key: string;
  message: string;
};

/** A thread's sandbox. */
const piSandbox = (thread: number) => `pi-${thread}`;

/** Puts fresh tokens in a running sandbox's network policy, and says when they die. */
async function giveTokens(sandbox: Sandbox, thread: number) {
  const [{ getToken }, { getVercelOidcToken }] = await Promise.all([import("@vercel/connect"), import("@vercel/oidc")]);
  const [gateway, board, github] = await Promise.all([
    getVercelOidcToken(),
    getVercelOidcToken({ audience: BOARD }),
    getToken(CONNECTOR, GITHUB_TOKEN),
  ]);
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  await sandbox.update({ networkPolicy: policy(thread, { gateway, board, github }, bypass) });
  // GitHub's lasts the session (GITHUB_TOKEN); the OIDC ones, only as long as this function's.
  return {
    tokensEnd: Math.min(expiresAt(gateway), expiresAt(board)),
    sessionEnd: sandbox.expiresAt?.getTime() ?? Date.now() + SANDBOX_MS,
  };
}

/** Pi's OIDC tokens can die before its session does (`tokens.ts`), so these give it new ones first. */
export const piTokens = tokenRefreshes({
  store,
  scheduler: queues,
  give: async (thread) => {
    const { Sandbox } = await import("@vercel/sandbox");
    const sandbox = await Sandbox.get({ name: piSandbox(thread) });
    // A stopped sandbox gets new tokens with its next message.
    if (sandbox.status !== "running") return null;
    return giveTokens(sandbox, thread);
  },
});

async function deliver({ task, thread, key, message }: PiMessage) {
  const { Sandbox } = await import("@vercel/sandbox");
  const settings = {
    name: piSandbox(thread),
    runtime: "node24",
    timeout: SANDBOX_MS,
    persistent: true,
    snapshotExpiration: SNAPSHOT_MS,
    env: {
      AI_GATEWAY_API_KEY: "from-the-network-policy",
      VBOARD_URL: BOARD,
      VBOARD_TOKEN: "from-the-network-policy",
      GH_TOKEN: "from-the-network-policy",
    },
    ...GIT,
    // Pi's name rides along on each commit as its co-author.
    __commitAs: { name: piName(thread), email: GIT_EMAIL },
  } as const;
  let sandbox = await Sandbox.getOrCreate(settings);
  // Stopped with nothing to resume (its snapshot expired): the thread starts over in a new one.
  if (sandbox.status === "stopped" && !sandbox.currentSnapshotId) {
    await sandbox.delete();
    sandbox = await Sandbox.create(settings);
  }
  // Every turn, so a sandbox picks up a new pinned vb; before the policy, so no credential is in place yet.
  await sh(sandbox, SETUP);
  await sandbox.writeFiles(await piFiles());
  // A message landing late in a session (say, one started by an earlier turn) still gets a full SANDBOX_MS.
  const extend = extension(sandbox.expiresAt, Date.now());
  if (extend > 0) await sandbox.extendTimeout(extend);
  // Fresh tokens with every message, so a thread can pick up again days later, and again before they die if
  // that's before the session ends.
  await piTokens.later(thread, await giveTokens(sandbox, thread));
  await sandbox.runCommand({
    cmd: "bash",
    args: ["-c", TELL],
    env: {
      MODEL,
      SESSION: piSession(thread),
      INSTRUCTIONS: `${INSTRUCTIONS[task]}\nOn the board you're ${piName(thread)}: the Pi for thread #${thread} only. Other threads have their own Pi, with names of their own.`,
      KEY: key,
      MESSAGE: message,
    },
    detached: true,
  });
}
