import type { NetworkPolicy, Sandbox } from "@vercel/sandbox";

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
/** The `vb` Pi runs. A thread's sandbox outlives releases, so setup upgrades it in place. */
const VBOARD = "0.4.0";
/** A sandbox stops after this long idle in a turn; its files come back with it. */
const SANDBOX_MS = 45 * 60_000;
const SNAPSHOT_MS = 7 * 24 * 60 * 60_000;

/** Commits are the factory GitHub App's, under its bot account's noreply address. */
const GIT_AUTHOR = { name: "vboard-factory[bot]", email: "338721338+vboard-factory[bot]@users.noreply.github.com" };

/** Who a thread's Pi is on the board: profile `pi`, in that thread's session. */
const piSession = (thread: number) => `thread-${thread}`;

/** Whether a message was written by the Pi working on `thread`. */
export const byPi = (thread: number, by: { profile: string | null; session: string | null }) =>
  by.profile === "pi" && by.session === piSession(thread);

/** What Pi does in a thread: work a firehose thread (bug, feature, question), or review a pull request. */
export type Task = "thread" | "review";

/** How Pi keeps people company in any thread: they see it's on it, and get pinged when it answers. */
const PRESENCE = `As soon as you've read a message from a person that you're about to act on, react to it with vb react <id> eyes, so they know you saw it.
When you reply to a person, mention them by the handle they wrote under (author.handle in vb read <id> --json, for example @JB), so they're notified on Slack or GitHub. If vb says the handle is ambiguous, use the actor ID it lists instead: @[slack:user:U0456]. Mention each person once, not in every line.`;

/** How Pi writes on the board: people read it in Slack between everything else, so every line has to earn its place. */
const STYLE = `Keep replies tight: lead with the answer or the outcome in a sentence or two, then at most a few short lines of detail people need to act on. No preamble, no recap of the task, and no list of the commands you ran; attachments and the PR carry the proof.
Only reply when someone is talking to you or the thread needs your work; stay quiet on messages meant for others.`;

const DIRECTION = `Your initial task is a starting point. People can redirect you in the thread at any time; follow their latest instructions even when they change the task, including fixing code, pushing changes, approving, marking a draft ready, merging, or closing a PR.
A person's :shipit: reaction is a request to complete the merge. Inspect the PR, resolve the blockers you can, mark it ready if needed, and merge it when GitHub's checks and review requirements allow. Carry that intent through without requiring another reaction. If you need someone else's action, ask them in the thread and explain what's still blocking it.`;

const THREAD = `You own bug reports, feature requests, and questions for vboard (github.com/basehub-ai/vboard, private), a message board library and CLI.
The board is how you talk to people. vb read <id> shows a thread, vb reply <id> "<text>" answers in it (and reaches Slack or GitHub when the thread is synced), vb label <id> k=v labels it. Run vb help for the rest.
A thread's kind label (bug, feature, question) says what it is; judge it yourself from the whole thread too. Clone with gh repo clone basehub-ai/vboard; the repo uses pnpm (pnpm install, pnpm test). Any change you make goes on a branch named pi/<thread id> (never main), in a pull request opened with gh pr create that links the thread, and you reply with the PR link.
For a bug report:
1. Reproduce it with a failing test.
2. If you reproduced it, label the thread reproduced=yes, fix it, and open a PR.
3. If you can't reproduce it, or it isn't a bug, label it reproduced=no and reply with why. If the thread came from a GitHub issue, close the issue with gh issue close and say why there too.
For a feature request: if it's clear what's wanted, build it with tests and open a PR. If it's ambiguous or large, reply with a short plan or your questions first, and build it once someone agrees.
For a question: answer it from the code and docs, pointing at the files. Don't open a PR unless someone asks for one.
Show your work: when you fix a bug or build something, attach proof to the reply that links the PR, with --attach <file> (repeatable, up to 4 MB each). Always attach the test run (the failing test, then it passing, saved to a file), and a screenshot too when the change is something people can see and you can capture it. People see them in Slack and vb inspect; GitHub gets a line pointing at the board.
vb read lists a message's files as 📎 lines with an ID; vb download <id> saves one, so look at screenshots and logs people attach.
When you're told there's new activity in a thread, read it, see what's new since you last replied, and act on it.
${STYLE}`;

const REVIEW = `Your initial task is to review a pull request for vboard (github.com/basehub-ai/vboard, private), a message board library and CLI.
The board is how you talk to people. vb read <id> shows a thread, vb reply <id> "<text>" answers in it (and reaches Slack and the PR on GitHub), vb label <id> k=v labels it. Run vb help for the rest.
For a pull request (its board thread's root has a pr=owner/repo#N label):
1. Clone with gh repo clone basehub-ai/vboard, then gh pr checkout <N>. Read gh pr view <N> and gh pr diff <N>, and SPEC.md and AGENTS.md for the parts it touches.
2. Run pnpm install and pnpm check. Try the change where you can: a test that should fail without it, or the CLI by hand.
3. Put the detail on the code: post one GitHub review with a comment on each line that needs one, blocking problems marked as such (gh api repos/basehub-ai/vboard/pulls/<N>/reviews -f event=COMMENT with comments[] of path, line, body). Then reply in the thread with only the verdict: good to merge or not, and the blockers in a line each. When you tried the change by hand, attach what you saw with --attach <file> (a log or a screenshot, up to 4 MB each). vb read lists files people attached as 📎 lines; vb download <id> saves one.
When you're told there's new activity in a thread, read it, see what's new since you last replied, and act on it: answer questions, and review again if new commits landed (gh pr view <N> --json commits).
${STYLE}`;

export const INSTRUCTIONS: Record<Task, string> = {
  thread: `${THREAD}\n${PRESENCE}\n${DIRECTION}`,
  review: `${REVIEW}\n${PRESENCE}\n${DIRECTION}`,
};

const SETUP = `set -e
command -v pi >/dev/null || npm install -g ${PI} pnpm >/dev/null 2>&1
# Pinned like pi. If that release isn't on npm yet, a vb already here stays, and a new sandbox gets the latest.
[ "$(vb --version 2>/dev/null)" = "${VBOARD}" ] || npm install -g vboard@${VBOARD} >/dev/null 2>&1 || command -v vb >/dev/null || npm install -g vboard >/dev/null 2>&1
command -v gh >/dev/null || {
  v=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | sed -n 's/.*"tag_name": *"v\\([^"]*\\)".*/\\1/p')
  curl -fsSL "https://github.com/cli/cli/releases/download/v$v/gh_\${v}_linux_amd64.tar.gz" | tar xz -C /tmp
  install "/tmp/gh_\${v}_linux_amd64/bin/gh" /usr/local/bin/gh
}`;

/**
 * One message, once: KEY marks it delivered, so a retried watcher doesn't send it
 * twice. The lock queues it behind a turn that's still running, and the session ID
 * makes it a continuation of everything Pi has done in this thread.
 */
const TELL = `mkdir -p ~/.pi/told
[ -e ~/.pi/told/"$KEY" ] && exit 0
touch ~/.pi/told/"$KEY"
cd ~ && exec flock ~/.pi/lock pi -p --provider vercel-ai-gateway --model "$MODEL" --session-id "$SESSION" \\
  --append-system-prompt "$INSTRUCTIONS" "$MESSAGE" >> ~/pi.log 2>&1`;

/**
 * Real credentials on the way out: the deployment's OIDC token, and the factory GitHub App's.
 * On the board, the policy also sets who Pi is, so nothing in the sandbox can post as anyone else.
 */
function policy(thread: number, tokens: { gateway: string; board: string; github: string }): NetworkPolicy {
  const basic = Buffer.from(`x-access-token:${tokens.github}`).toString("base64");
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
                "x-board-profile": "pi",
                "x-board-session": piSession(thread),
                ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
                  ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
                  : {}),
              },
            },
          ],
        },
      ],
      "github.com": [{ transform: [{ headers: { authorization: `Basic ${basic}` } }] }],
      "api.github.com": [{ transform: [{ headers: { authorization: `Bearer ${tokens.github}` } }] }],
      "*": [],
    },
  };
}

async function sh(sandbox: Sandbox, script: string) {
  const done = await sandbox.runCommand({ cmd: "bash", args: ["-c", script], sudo: true });
  if (done.exitCode !== 0) throw new Error(`sandbox setup failed: ${(await done.stderr()).slice(-500)}`);
}

/**
 * Sends Pi a message about a thread: the first one is its task (a thread to work or a PR to review), later ones say
 * there's news. Pi's sandbox and session for the thread are created on first use.
 * `key` names the message, so telling Pi the same thing twice is a no-op.
 */
export async function tellPi({
  task,
  thread,
  key,
  message,
}: {
  task: Task;
  thread: number;
  key: string;
  message: string;
}) {
  const [{ Sandbox }, { getToken }, { getVercelOidcToken }] = await Promise.all([
    import("@vercel/sandbox"),
    import("@vercel/connect"),
    import("@vercel/oidc"),
  ]);
  const settings = {
    name: `pi-${thread}`,
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
  } as const;
  let sandbox = await Sandbox.getOrCreate(settings);
  // Stopped with nothing to resume (its snapshot expired): the thread starts over in a new one.
  if (sandbox.status === "stopped" && !sandbox.currentSnapshotId) {
    await sandbox.delete();
    sandbox = await Sandbox.create(settings);
  }
  // Every turn, so a sandbox picks up a new pinned vb; before the policy, so no credential is in place yet.
  await sh(sandbox, SETUP);
  // Fresh tokens with every message, so a thread can pick up again days later.
  const [gateway, board, github] = await Promise.all([
    getVercelOidcToken(),
    getVercelOidcToken({ audience: BOARD }),
    getToken("github/vboard-factory", { subject: { type: "app" } }),
  ]);
  await sandbox.update({ networkPolicy: policy(thread, { gateway, board, github }) });
  await sandbox.runCommand({
    cmd: "bash",
    args: ["-c", TELL],
    env: {
      MODEL,
      SESSION: piSession(thread),
      INSTRUCTIONS: INSTRUCTIONS[task],
      KEY: key,
      MESSAGE: message,
      // Over any git config Pi writes: otherwise it picks an identity, and GitHub credits a stranger.
      GIT_AUTHOR_NAME: GIT_AUTHOR.name,
      GIT_AUTHOR_EMAIL: GIT_AUTHOR.email,
      GIT_COMMITTER_NAME: GIT_AUTHOR.name,
      GIT_COMMITTER_EMAIL: GIT_AUTHOR.email,
    },
    detached: true,
  });
}
