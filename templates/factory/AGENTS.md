<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# This software factory

A board (`@vercel/board`, read its docs in `node_modules/@vercel/board/docs`) and an eve agent
(`node_modules/eve/docs`) in one Next.js app. When you change it, you may be its own agent,
asked to improve itself: what you change here is how you work.

**The goal: useful and proactive, never annoying or noisy.** The factory finishes what it
starts, comes back on its own, and says what people would want to know before they ask. And
every message it posts is worth reading. Judge each change to its instructions, skills and
watchers by both: does it do more for people unasked, and does it post less that nobody needed?

```bash
pnpm install
pnpm typecheck
pnpm test        # node --test, with Node's type stripping
pnpm build
```

- **The board is the team's, in Vercel's API.** `board()` with no backend: Vercel keeps its
  messages, files, and schedules, and this deployment keeps nothing. It runs the board's sync and
  its watcher, woken through `app/api/board/[[...path]]/route.ts`. Production is on the team's
  default board; a dev server or a preview is on one named `factory-dev`.
- **Each setting lives where it's used.** Which channel each repo's PRs and issues come into, and
  which Slack channels mirror which board channels, are in `app/api/board/[[...path]]/channels.ts`
  (this repo's own go to `project-<name>/rsi`, which Slack's `#<project>-rsi` mirrors: where the
  factory updates itself; each other repo gets a channel of its own beside it and a Slack
  channel that mirrors it, both added by the onboard-repo skill). The board's sync, its
  connectors, and its watcher are in `factory.ts` beside it. The agent's model, instructions,
  sandbox, tools, and skills are in `agent/`.
- **What a team keeps one of per name is named for the Vercel project** (`lib/project.ts`): the
  Connect connectors (`github/<project>`, `slack/<project>`), that Slack channel, and its channels
  on the team's board, all under `project-<name>`. A team's second factory gets its own, with
  nothing to edit, and neither hears the other.
- **Instructions are for every turn, skills for some.** `agent/lib/instructions.ts` holds the
  judgment every turn needs, with a line pointing at each skill; a procedure the agent needs only
  sometimes (reviewing, reproducing a bug, opening a PR and seeing it through, coming back to what it left open, feedback on the factory, reaching a service, demos, onboarding a repo, finding a way to try its work in one) is a skill in `agent/skills/`.
- **The board sees the agent only through `wakeAgent` (`agent/lib/wake.ts`).** Its `wake` watcher
  tails `project-<name>/`, so the agent hears every message in its own channel and under it. It hands each wake-up to
  eve's own channel (`agent/channels/eve.ts`, at `/eve/v1`), opening the session with the
  thread's ID as its `operationId` and delivering under the event's cursor as the
  `idempotencyKey`: eve keeps one session per thread and drops a repeat, so there's no store of
  sessions here. A wake-up names only its thread; what the agent may reach on GitHub comes from
  the board's config (`agent/lib/credentials.ts`).
- **The agent is this deployment, writing as itself** through the factory's own handle
  (`agent/tools/vb.ts`), so `vb typing` and reads reach Slack through the board's sync. That handle
  is held to the factory's own channels (`AGENT_CAN` in `agent/lib/vb-tool.ts`: read, post, react,
  label), and the board refuses it the rest: other channels, sync's raw events, sources, grants.
  The tool keeps no list of commands of its own. It has no profile: the board and Slack show it
  by the Vercel project's name, not as a name "via" the project. What else the deployment writes
  has a profile, which is how the watcher and the
  launcher know the agent's messages (`byAgent`): its watcher's replies (`wake`), and what its sync
  brings in. The board never wakes a watcher for its own writes, so the agent's check-ins reach
  it. The agent's `setup_steps` tool asks the setup page's own `/api/launcher/steps`.
- **The setup checks write nothing.** `lib/setup.ts` checks the deployment against what the board
  syncs. A step is a short list of tasks, each named for what to do, done or not, with what helps
  do it (one line, a link, commands): there are no other states. A test drives each task through
  `setup()` against a fake network (`test/setup.test.ts`).
- **The launcher has three faces, one check** (`lib/launcher.ts`): the page (`app/page.tsx`), the
  same steps as markdown (`app/index.md`), and `app/api/launcher/steps` for the agent's
  `setup_steps` tool. `/` answers the markdown to whatever doesn't ask for a page (the rewrites in
  `next.config.ts`), so someone can tell their agent "set up" and the deployment's URL. A link to
  `channels.ts` opens on a line found in the file as deployed, never a remembered number.
- **The launcher writes only when asked, and as itself** (`lib/page-board.ts`): under a
  `launcher` profile, held to opening a thread where the factory changes itself, so it reads as
  `launcher via <project>` and the agent hears it through its watcher, as it hears anyone. It
  starts the factory's first task (`lib/first-task.ts`, `POST /api/launcher/first-task`), offered
  while the README is still the template's and started once however often it's asked, and it asks
  for a repo to be onboarded (`lib/onboard.ts`, `POST /api/launcher/onboard`). Only the
  deployment's own page or a client that isn't a browser may ask.
- **While strangers can open the deployment, the page and `app/api/launcher/` say only how to
  protect it,** and nothing about the factory.
- **The deployment calls itself with its OIDC token, and no bypass secret.** The watcher reaches the
  agent, and the agent's `setup_steps` tool the page's steps, through Deployment Protection's
  Trusted Sources, which let a project call its own environment and no other.
- **Real credentials never enter the sandbox.** `agent/lib/credentials.ts` puts them in its network
  policy, which swaps them in on the way out. Keep it that way. A service besides GitHub is a line
  in `agent/lib/services.ts` (its env var and hosts), with its key in the project's env, and it
  reaches only the threads of the channels `serviceChannels` in `channels.ts` gives it.
- **GitHub signs the agent's commits, so there's no signing key.** The sandbox's `git`
  (`agent/lib/git/`, which `agent/sandbox.ts` installs) makes each pushed commit again through GitHub's API.
  `test/git-push.test.ts` runs it against real git and a fake GitHub backed by a bare repo.
- **`package.json`'s `version` is the template release this factory started from.** This repo
  is a copy: it doesn't follow the template on its own.
