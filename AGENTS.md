# agents guide

board is one npm package, `@vercel/board` (`packages/board`): `board()`, the handle that
serves a board and acts on it, its backends, and the CLI (`board`, alias `vb`). [SPEC.md](./SPEC.md) is
the design; read it before changing behavior.

## run it

```bash
pnpm install
pnpm check          # build + typecheck + test
pnpm test           # vitest: unit, in-process server, and CLI end to end
```

CI runs `pnpm check` on every PR and on `main` (`.github/workflows/check.yml`);
its `check` job is the status a PR needs before it can land.

Tests pass their pieces like any board (`packages/board/test/harness.ts`):
`memory()` for the store, `memoryBlob()` for files, no scheduler unless a test
passes one, and a local test issuer. Auth runs real `jose` verification against
an injected JWKS; there is no bypass.

Every test you write, change, or review gets the test-behavior skill
(`.claude/skills/test-behavior`, and the factory's copy for Eve): break what it
claims to test and see it fail, and pin no internals a user can't observe.

## release it

A change people will notice gets a changeset (`pnpm changeset`); its PR is
titled and described as [pr titles and descriptions](#pr-titles-and-descriptions)
says. On `main`,
`.github/workflows/release.yml` opens a "Version Packages" PR; merging it
publishes `@vercel/board` to npm by trusted publishing (OIDC, no token; no provenance
while the repo is private). The CLI and the API read their version from
`package.json`, so never edit `src/version.ts` to bump it.

To try a commit before it's released, install its tarball from the
**vboard-preview-publisher** deployment on the PR (`apps/preview-publisher`, a
static project on `vercel-internal-playground`): its page has the `pnpm add`
line, pinned to that deployment. Nothing goes to npm; see its
[README](./apps/preview-publisher/README.md).

## other private repos

Never link or cite another private Vercel repo (`vercel/api`, `vercel/v0`, and
the rest): not its PRs, issues, commits, or files, and not in code, comments,
tests, fixtures, docs, changesets, commit messages, or PR titles and
descriptions. Say what the other side does instead ("Vercel's API answers 404
for `/schedules`"), and use `acme/web` where a fixture or an example needs a repo.

## pr titles and descriptions

People read these on Slack and in the board thread before the code, so both
say plainly what changes, and briefly.

**Title:** `<type>(<area>): <what it does>`, in the imperative, about 60
characters at most: `fix(store): split big redisTables writes into bounded scripts`.

- `type` is `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, or `chore`,
  with `!` when it breaks someone: `feat(protocol)!: …`.
- `area`, when one fits, is where people would look: `cli`, `sdk`, `protocol`,
  `sync`, `backend-a2`, `backend-http`, `backend-vercel`, `inspector`,
  `factory`, `docs`.
- No narration ("X does Y", "X is Y") and no second clause: two changes are
  two PRs.

**Body:** one line on what it does and for whom, opening with the link to the
board thread, Slack thread, or issue it came from when there is one. Then four
answers, each `none` when nothing applies, so a reviewer sees at a glance what
to look at:

```markdown
- **Users:** none | the new or changed command, flag, output, or SDK call; "breaking" if it is.
- **Protocol / backends:** none | new or changed routes and methods, what a backend must implement, conformance checks added.
- **Performance / I/O:** none | what each affected call now costs: board reads and writes, platform calls, polling, payload size.
- **Tests:** what's covered and at what level (the CLI as a subprocess, an in-process board, the real API), and what's faked and why.
```

Then `### Users` and `### Protocol / backends` for the answers that need more
than their line, and `### Open` for tradeoffs or follow-ups a reviewer must not
miss. Nothing else.

- **Code, not prose.** Users get a transcript pasted from a real run (trimmed,
  never retyped) or the SDK call with only the lines that matter; the protocol
  gets signatures and shapes (`GET /links?url= → ThreadView`). A breaking
  change says who breaks and what to do instead.
- **Imports, always.** Every SDK sample starts with its imports, each
  `@vercel/board/*` one included, before and after alike: which entry point a name
  comes from is part of the API, and a reviewer judges it from the sample
  (`import { channels, slack } from '@vercel/board/sync-slack'`).
- **Evidence matches the claim.** A bug fix names the test that fails without
  it, and shows the wrong output on `main` beside the right one. A UI change
  gets a screenshot, or a short video for a flow. Mocking board's own code
  doesn't count as testing it.
- **One screen.** One sentence per fact, no paragraph over three lines, and
  nothing the diff already says: no file lists, no renames nobody calls.
- **Users is `none` exactly when there's no changeset.** The factory reads a
  changeset as user-facing.

The pr-description skill (`.claude/skills/pr-description`, and the factory's
copy for Pi) says how to get the evidence where it runs, with an example.

## the software factory (`apps/software-factory`)

board running on itself: the board for `vercel-labs/board` PRs and Vercel's
Slack, on `vercel-internal-playground/vboard-factory` (vercel-labs has no Connect
Slack app in Vercel's workspace). The app is only wiring,
plus the [docs site](#the-docs-packagesboarddocs) everywhere outside `/api`:
the board route holds the whole config, and the A2 scheduler route re-exports
the board's `scheduler`. They're separate routes because the queue trigger
makes its function private.

```bash
cd apps/software-factory
vercel link --project vboard-factory --scope vercel-internal-playground
pnpm dev                                       # the board at /api/board
BOARD_URL=https://vboard-factory.playground-vercel.tools/api/board pnpm exec vb inspect
```

This repo's board is the factory. Nothing in a checkout names a board, so set
`BOARD_URL=https://vboard-factory.playground-vercel.tools/api/board` where you
run `vb` (or pass `--url`): without it, `vb whoami` says how to point it at
one, and in `apps/software-factory`, a Vercel project, it talks to
vercel-internal-playground's team board in Vercel's API instead. Posts to `dev`
reach Slack's #development-messageboard and GitHub, so reply in an existing
thread rather than starting one.

- Every environment syncs with the real Slack and GitHub, so a local or preview
  board posts there too. `VERCEL_ENV` only picks the store (`a2.ts`) and where
  files go (below): production's Redis keys, a preview's own keys in the same
  Redis, or `sqlite()` at `.a2/dev.db` locally, imported only there. The queue is
  `vercelQueues()` everywhere. On Redis the store holds A2's log and the board's
  tables (`<prefix>:{<prefix>:board}:*`), which fill from the log on their own. The Redis namespace is `board-factory`, its
  previews' `board-factory:preview`.
  Slack channel `C0C8XN8SQRG` (#development-messageboard) mirrors `dev`, and
  GitHub PRs and issues come into it, and nothing goes back: PR and issue
  threads are inbound only (`pulls` and `issues` in `quiet.ts`). Connect uses `slack/vboard-factory`,
  and `github/vboard-factory`, with production triggers at
  `/api/board/webhooks/slack` and `/api/board/webhooks/github`. The GitHub
  app's bot (its login and commit
  email) comes from GraphQL's `viewer` for its token, so nothing pins its name.
- Watchers do the work. `triage-gpt` labels each non-PR dev thread's `kind` with
  GPT-6 Luna's decision model (`openai/gpt-6-luna-decisions`),
  judging the whole thread whenever a person posts. Its scope (`classify.ts`) is the
  library and the factory, Eve included, so "Eve should…" is a feature, not noise. `pi` hands `kind=bug`,
  `kind=feature`, `kind=question`, and `kind=task` threads (not `noise`) to Eve (`agent.ts`);
  `task` is someone asking Eve itself to do something (a recap, an investigation), and the
  kinds live in `kinds.ts`
  and tells it when someone replies; Eve reads what's new itself. Before it plans
  or builds, Eve searches earlier threads and PRs and builds on related work. For a bug, Eve
  reproduces it, then opens a PR from a `board/<thread>` branch (its body opens
  with a line linking what triggered it: the Slack thread or GitHub issue, which
  `taskMessage` puts in Eve's first message), or labels the
  thread `reproduced=no` and says why. It builds clear features the same way
  (asking first when they're not), and answers questions in the thread.
  `review-pi` hands each new `dev --label pr` thread to Eve to review the PR (Eve wears `:looking-bunny:` on the PR root while it reviews), and tells it when
  someone other than a bot replies. A draft waits until it's ready (`review.ts`): Eve
  reviews it once, when its root's `state` turns from `draft` to `open`, and until then
  only a reply that names Eve (`eve`, `@eve`, the old `pi`, or the thread's Eve), or a reminder Eve
  scheduled, wakes it. Eve hears every reply in its threads but stays quiet when one is
  addressed to someone else, and keeps board replies to a few lines; a review's detail
  goes in a GitHub review on the code. Review is its initial task; people can redirect
  Eve in the thread to fix, push, approve, mark ready, merge, or close the PR.
  `shipit` lets anyone add `:shipit:` to a PR's Slack root
  to request a merge as the factory GitHub App. Slack delivers that alias as
  `squirrel`, which the watcher also accepts, and `:approved:` works the same way. It reads the current PR, marks it
  ready if it's a draft, and merges with that head SHA and a merge commit,
  honoring GitHub's merge rules;
  a rejected merge tells Eve who requested it and why it failed. Eve resolves
  blockers, marks drafts ready when needed, and completes the requested merge
  when GitHub's requirements allow, without asking for another reaction. It
  mentions reviewers or owners when their action is needed.
  `autoland` (`autoland.ts`) is auto-landing in shadow mode: it labels PRs and
  merges nothing. After each review, the PR thread's Eve labels the root
  `land=yes|no` with `land.why` and the head it reviewed (`land.sha`); yes
  means it fixes a bug or does what a person clearly asked, with nothing to
  fix and no caveats or tradeoffs. Only that Eve's label counts. The watcher
  then checks the rest on GitHub (a factory PR, still open, no commits since
  the review, CI `check` green on the head, and not a user-facing change to
  board core, meaning `packages/board/src`, its `package.json`, or
  `tsdown.config.ts` together with a changeset) and labels the root
  `autoland=would|no` with `autoland.why`. A `would` root also wears
  `:stamp-hammer:`, added and removed as the verdict flips, so Slack shows it.
  `security` (`security.ts`) lets anyone add `:security:` to a PR's Slack root
  to have Eve run a deepsec review of its diff, in a fresh `git worktree` outside
  its clone (deepsec only fails on net-new findings, so reused state could look
  clean). Eve reacts `:secure:` only when deepsec exits 0. On a thread that isn't
  a PR, the watcher replies itself, and `pi` doesn't wake Eve for that reply.
  A message that lands during a turn steers it (the eve channel's
  `turnPolicy: "steer"`): Eve sees it at its next step, and a burst of replies
  costs no extra turns. Each message is sent once
  (`told:` keys in `eve.ts`). A message that can't reach Eve is
  tried 3 times, then the watcher replies "Eve couldn't start" in the thread
  instead of throwing: a watcher that throws gets 5 tries in about 15 seconds,
  then board drops that event without a word. The next reply tries again. No
  watcher's own reply wakes Eve or triage (`byWatcher`).
- A factory PR (its branch is `board/<thread>`) starts its own Slack thread
  like any PR, and its review happens there. `in-thread` (`inthread.ts`) also
  posts the PR's one line in the thread it was built for, labeled with the PR so
  :shipit: and :security: on it act on that PR, and keeps it in step with the
  PR's state and title. Those lines don't wake Eve or triage.
- In Slack a PR root is one line (`render.ts`): its state's emoji (`:pr:`,
  `:pr-draft:`, `:pr-merged:`, `:pr-closed:`) and a link titled with the PR.
  The board edits it when its `state` label changes.
- Eve (Pi, before it moved to eve) is an eve agent (`apps/software-factory/agent/`, Opus 5.5 on AI Gateway),
  mounted at `/eve/v1` by `withEve` in `next.config.ts`. The watchers reach it
  over eve's HTTP API as this deployment (`eve.ts`): each thread's task gets one
  eve session, kept in the factory's Redis (`board-factory-eve:*`), and every
  message says which thread it's about. The eve channel (`agent/channels/eve.ts`)
  takes only this deployment's own OIDC tokens (`runtime`, so a preview of the
  factory can't drive production Eve) and puts the thread in the turn's auth,
  where Eve's instructions (`agent/instructions/board.ts`, from `harness.ts`) and
  its credentials read it. Each session has its own persistent Vercel Sandbox
  with `vb`, `gh`, and git, set up once at build into a snapshot
  (`agent/sandbox.ts`). Its branch (`board/<thread>`) and preview say `board`,
  not `factory` or `pi` as on the factory's earlier stores: thread IDs restarted
  with each, so an old `factory-12` or `pi/12` belongs to another #12, and the
  watchers that read a PR's branch (`owner`, `in-thread`, `autoland`) read only
  `board/`. Its credentials are placeholders that the sandbox's network policy
  swaps for real ones on the way out (`agent/lib/credentials.ts`): put in place
  with git's identity at every turn's start, and again before a `bash` call when
  they're within 15m of dying (`stale` in `tokens.ts`). A sandbox eve recreates is
  found at a turn's start, so it gets them then. The OIDC tokens die with the function's own,
  which Vercel reuses for 90 of its 120 minutes, and GitHub's are asked for with
  30m left, so a long turn renews them as it goes. The policy also pins who Eve
  is on the board (a profile named for the thread, like `clever-lemur-1956`, and
  session `thread-<id>`), so watchers can tell a thread's Eve from everyone else.
  Anyone who can write can send those headers, so `byEve` also needs the
  factory's production deployment as the principal
  (`vercel:project:<VERCEL_PROJECT_ID>:production`, the token Eve's policy adds).
  Its `vb` talks to the production board, the only one a sandbox can reach.
  Its `vb` tool (`agent/tools/vb.ts`) runs a vb command straight from the function, in one
  request, with `vb()` from `@vercel/board/cli`: what the CLI prints, `--attach` and `download` on
  the sandbox's files. It sends the headers the policy adds (`eveHeaders`), so Eve is the same author
  either way. `tail`, `wait`, and verify-board's local board stay `vb` in the sandbox: `vb()` runs one call at a time, and those would hold every Eve on the instance.
  eve's subagent tool is off (a subagent's sandbox has no credentials), and so
  is its usage cap, whose "continue?" prompt nobody could answer. It has eve-code's
  `apply_patch` tool (`agent/tools/apply_patch.ts`), not the rest of that extension,
  and eve's opt-in `grep` (`agent/tools/grep.ts`). Its sessions export to Vercel Agent Runs
  (`agent/instrumentation/`) with their content: eve would keep only metadata for
  this deployment's own (private) sessions, and with a span for each outgoing
  `fetch` (`instrumentations: ["fetch"]`). Traces need a 100% sampling rule in the
  project's Settings → Tracing, with its path left empty.
- Eve's `gh` and git go through `github/vboard-factory`: the sandbox's network
  policy adds the app's token to `api.github.com` (as a bearer token) and to
  `github.com` (as basic auth, for git over HTTPS). Commits carry the thread's
  Eve as author, and Eve opens its own PR with `gh pr create`. `check` also runs on `board/**` pushes, since a run for a bot's PR
  waits for approval.
- Attachments live in the project's private Blob store, `vboard-factory-attachments`
  (`BLOB_STORE_ID`, authenticated with OIDC), shared by every deployment; locally
  they're files in `.a2/attachments` (`fsBlob()`). Eve attaches a screenshot to the reply
  that links its PR when the change is visible (a captioned video, for a flow),
  never test-run logs: the tests
  are in the PR, and a bug fix's PR body names the test that reproduces it. Its
  `vb` is pinned (`BOARD` in `agent.ts`) to the board the factory was built
  with, so each release reaches Eve when the factory deploys, with no bump. `gh` is pinned too (`GH`), which
  new sandboxes download without asking GitHub's API, whose unauthenticated rate
  limit sandboxes share.
- Eve gets the factory's own skills, from `apps/software-factory/skills/`
  (`agent/skills` links there), which eve puts in `~/.agents/skills`. `sitrep` is how Eve
  does a recap that moves work forward. A schedule like `vb schedule dev
  ":sitrep: Morning recap" --at <9am> --every 1d --label kind=task --label
  sitrep=morning` posts a bare root that a fresh Eve picks up, so the schedule text stays a title and
  the skill holds the how. A run finds the last recap by its `sitrep` label. `verify-board`
  tests board itself: it builds this checkout, a git ref in its own worktree
  (`origin/main`, to reproduce a bug before fixing it), or an npm version,
  serves a local board with `vb serve`, and runs each `vb` with only `PATH`
  and a home of its own, so nothing reaches the factory's board. The `computer`
  tool (`agent/tools/computer.ts`) is computer use, done the way Codex does it: one tool
  that does one action on the sandbox's virtual desktop (Xvfb) per call, with the mouse and
  keyboard through XTEST (`agent/lib/xinput.py`, using ctypes because the sandbox has no
  pip or xdotool), and returns a screenshot. Each call carries a title.
  `ui-video` records that desktop with ffmpeg and burns each call's title in
  as a caption, read aloud by a speech model on AI Gateway (`openai/tts-1`; the
  network policy's gateway key covers it). It keeps each line and a few seconds
  after its action and cuts the time Eve spends thinking, as an mp4 under 4 MB. Setup installs Xvfb and libXtst
  (dnf), Chrome (through `agent-browser`, pinned as `AGENT_BROWSER`), and a
  static ffmpeg (`FFMPEG_STATIC`), and a failed install doesn't stop Eve. Eve
  tests against a local dev server or the preview of its own branch
  (`evePreview`, `vboard-factory-git-board-<thread>.playground-vercel.tools`).
  The network policy adds the Vercel Authentication bypass to
  that host only, so the secret never reaches other deployments, or the
  sandbox.
- The A2 scheduler route (`app/api/a2/scheduler`) is private to Vercel Queues
  (`vercel.json`), on topic `vboard-factory`. Production is behind Vercel
  Authentication: the CLI gets through with your `vercel login` (or
  `VERCEL_AUTOMATION_BYPASS_SECRET`), and Eve's network policy injects the
  bypass when calling the board. Connect forwards webhooks
  through deployment protection.

### Agent Factory access

External Factories use the same `/api/board` endpoint, store and inspector.
`BOARD_TRUSTED_SOURCES` grants explicit immutable project/team IDs, production
only by default. Configure Deployment Protection Trusted Sources too; hosted
callers send native OIDC headers and need no bypass secret. Factory discussions
use `factory/...` channels; all Eve watchers and external sync target `dev`.
These grants read and post on the whole board, and label only in `factory/`. Factory's
scoped tool supplies repository isolation; namespacing alone is not an ACL.
Read [the setup skill](skills/configure-factory-board/SKILL.md) when connecting
a software factory, and [the guide](packages/board/docs/03-guides/05-agent-factory.md)
for the service contract.

## pong (`apps/pong`)

A project's board on the factory's: `board({ backend: http(BOARD_URL) })`
keeps no log, and the factory's board keeps it. Its one watcher, `ping`, tails
`pings`, which nothing syncs and no factory watcher reads, and replies `pong
from <sha>` to each new thread as this project. Its page (`app/page.tsx`)
pings from a browser through server actions that use the same handle
(`lib/board.ts`) and shows the round trip; the deployment itself answers only
wake-ups and webhooks.

- It's `vercel-internal-playground/vboard-example-pong`, Git-connected to this
  repo with root `apps/pong`. Its board is `BOARD_URL`, falling back to the
  factory's production board; a Preview `BOARD_URL` scoped to a branch points
  that branch's previews at the factory's preview of it
  (`https://vboard-factory-git-<branch>.playground-vercel.tools/api/board`).
- It registers its watcher on the factory's board lazily, on its first use
  (a page load or a ping): `basePath` tells it its URL before any request, so
  on Vercel that's the deployment's own (`VERCEL_URL`, or the production
  domain). `POST /api/board/watchers` on it registers too, and a wake-up
  that shows the factory holds an older set registers again.
- The factory trusts it through `BOARD_TRUSTED_SOURCES`
  (`{ "projectId", "teamId", "environments" }`, which grants `read` and `post`
  everywhere), per environment: Preview lists pong's previews, Production its
  production.
- Deployment Protection, both ways, through Trusted Sources alone. Its writes
  and pulls reach the factory through the factory's Trusted Sources (pong's
  project is listed), with the deployment's OIDC token. The factory's wake-ups
  carry no credential, so they reach pong only where pong lets `POST /wake`
  through: its deployments are all behind Vercel Authentication, so its
  wake-ups answer 401 and it answers only when something wakes it by hand or
  it pulls. One that doesn't get there is logged as `couldn't wake <url>: <status>`, and again
  when the factory starts backing off (a minute, doubling to an hour) until
  pong answers one, pulls, or registers (a new deployment registers on its
  first use, a page load say).
  `vercel curl /api/board/wake --deployment <url> -- -X POST` wakes it by hand.

## the docs (`packages/board/docs`)

Markdown in the package, so it ships on npm (`files` has `docs`) and agents can
read it in `node_modules/@vercel/board/docs`. The software factory serves it at
https://vboard-factory.playground-vercel.tools: `docs/index.md` is the landing
page's body, and every page also answers as markdown at its URL plus `.md`. The
site (`app/` outside `api/`, `components/`, `lib/`) is A2's docs site ported,
grayscale and Geist Mono; it reads the docs from its installed `@vercel/board`.

- **Plain GFM, no HTML.** Frontmatter is `title` and `description` (YAML: quote
  a value with `: ` in it). The description renders under the title, so a body
  starts with a `##` heading or a code block. Fences take a filename after the
  language (```` ```ts app/api/board/[[...path]]/route.ts ````) and only
  `lib/markdown.tsx`'s languages; ```` ```package-install ```` takes one
  `npm i …` line. Callouts are GitHub's `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`,
  and under a `## FAQ`, each `###` question folds into a `<details>`.
- **Pages link by relative file path** (`../02-sync/03-slack.md#files`), so they
  read the same on GitHub and in `node_modules`. The site turns them into URLs,
  and a link to no page fails the build; `apps/software-factory/test/docs.test.mjs`
  checks anchors too.
- **Filename prefixes order the sidebar** and are stripped from URLs:
  `02-sync/03-slack.md` is `/sync/slack`, in the group "Sync".
- **A2's voice:** present tense, as if it ships today; short sentences; no
  em-dashes, hype, or filler; "board" lowercase. Samples are paste-complete,
  every live line is real API, and userland is commented out. The docs describe
  the code: where SPEC.md and the code disagree (read cursors aren't built), the code
  wins. A change people will notice updates its page.

## the inspector (`vb inspect`, `src/inspect/`)

A local web UI for any board, reading and writing as the CLI's identity. Check it
with `agent-browser` against `vb inspect --no-open`; try writes against
`vb serve`, which syncs nothing: the factory's boards, a local `pnpm dev`
included, post to Slack and GitHub.

- **The page is just another handle.** `server.ts` serves the page, its
  bundle, and `/board/*`, a proxy that adds your credentials; the page is
  `board({ backend: http(proxy, { fetch }) })`, from the default builds, its
  `fetch` sending the per-run token. The page needs no inspector-specific API; if
  it wants something, add it to the board's API.
- **State lives in `app/store.ts`, pure and tested.** Views merge by their
  `version` (an older view never replaces a newer one); your writes are
  overlays until the stream confirms them. Components render from it.
- **The proxy acts as you, so it trusts nothing but its own page.** It binds
  127.0.0.1, rejects any `Host` that isn't its own (DNS rebinding), requires the
  per-run token on every `/board` request and the page's `Origin` on writes.
  Keep all of them. That's why attachments render from `blob:` URLs: the page
  fetches each file with its token, since an `<img>` can't send one.
- **The bundle is built** into `dist/inspect/app.js` by `tsdown` (React
  included). `pnpm test` builds first; running from source finds it in `dist`.
- **It's Just Chat's UI, ported.** Base UI (`@base-ui/react`) for menus,
  context menus, popovers, and autocompletes; lucide icons; plain CSS in
  `style.ts` with Just Chat's tokens. Right-clicking text keeps the browser's
  menu (`nativeMenu`); the row's space opens ours.
- **Just Chat's invariants hold:** the default cursor everywhere but text
  (buttons and sidebar links included), no smooth scrolling, hairlines only
  under headers, the thread pane's open state in the URL, typing anywhere
  focuses the composer, and live updates never move what you're reading or
  clobber what you're typing.

## cli design (`src/cli/`)

The CLI reads like the docs site: plain, quiet, nothing extra. Output is
for a person at a terminal first; `--json` is for programs.

- **Say what happened, then stop.** One line per fact, in lowercase phrases
  (`removed`, `not installed`). No banners, no "Done!",
  no recap of what the command was asked to do.
- **No emoji, no color, no box drawing.** Plain text reads the same in every
  terminal, log, and paste.
- **Columns, not colons.** A row is its subject, then two spaces, then the
  value (`board  https://…`); pad the subject when rows stack, so values line
  up.
- **Group by subject.** When a command touches several things (agents,
  files), each gets a heading line (name, two spaces, path) and its details
  indented two spaces under it, with a blank line between groups.
- **Paths as people write them.** `~/.claude/settings.json`, not the expanded
  home directory.
- **Say it in words, not in config.** Name what changed (`update, reply, and
  read run without asking`); don't echo the raw rules, commands, or JSON that
  were written. Print config only when the person has to paste it, indented
  four spaces and paste-complete, with its instructions as comments in it.
- **Fit 80 columns.** Shorten a line before wrapping it; a long path or value
  can run over, prose shouldn't.
- **Errors are data, shaped like the Vercel CLI's** (`src/cli/failure.ts`): a
  class that fixes the exit code, a `reason` to branch on, a headline that says
  what failed and why, and at most two ways out, each a command as argv or a
  sentence. `vb` prints them on stderr as `error: <headline>`, with each way
  out two spaces in after a blank line; with `--json`, as one JSON document.
  `vercel board` shows the same data as its own (`createApp({ onError })`). An
  error the handle raised itself (`origin: 'handle'`) says what and why in
  `message` and what fixes it in `hint`. What a board answered (`origin:
  'board'`) is said by what the command was doing, the board's words only under
  it and in `data`, never in what to run: a board can answer with any code. A
  handle's message shows a value a board gave only when it fits its shape (a
  project ID, a URL).
- **`--json` is one document**, keyed by what it holds (`{ threads, cursor }`,
  `{ message, outcome }`), with a write's `warnings` in it. Only `tail`, which
  streams, prints a line per event.

## layering

API → `board()` → CLI. The CLI makes no HTTP calls of its own; everything goes
through a handle from `board()`, and `board()` only ever calls the backend's
methods, and nothing reaches around them. The policy is `board()`'s, in one
place on every backend: it routes and validates each request, verifies its
caller (`authenticate`, `oidcTokens()` from `@vercel/board/access` by default),
applies `access`, runs the `middleware`, and calls the backend with the caller
it verified (`{ identity, origin }`), which the backend trusts because only
`board()` makes one. Nothing with side effects runs for a request before
`access` allows it. `a2()` is the log and its engine, the same in every
environment: a `store` (SQLite at `.a2/dev.db` when none is passed, which
serverless can't open), and a `scheduler` and `blob` only if they're passed.
Without a scheduler, its consumers run in the request that wrote and scheduling
answers 501 `no_scheduler`; without a blob store, it keeps no files (501
`no_files`). What it does outside requests asks `board()`'s policy through the
binding (`accessNow`), and what it writes for someone (a schedule's send) goes
through the binding's handle, so the middleware sees every write once. A board
on `http()` with no `access` answers only wake-ups and webhooks, so a repo
links the team's board itself; with one, it's a gateway, whose callers act on
the team's board as its project, labeled with their handle and narrowed to
their access. Request
schemas live in `src/api/routes.ts` and are shared by the server and the
handle. Nothing on the way to a handle over `http()` imports Node: credentials
go in `http(url, { fetch })`, whose Node default (`vb`'s) lives in the `node`
builds of `@vercel/board` and `@vercel/board/backend-http`. Watchers and sync run in either
build: the engine loads when it's first used, and it and `SyncProvider` import
nothing from Node; the Chat SDK adapters do (`test/browser.test.ts` checks).
A2 is bundled: tsdown inlines what board runs of it into `dist` (`deps.alwaysBundle`), so
installing board installs no `experimental-a2`, and only `backend-a2` loads it. The Chat SDK,
its adapters, and `@vercel/connect` are optional peers that only the `sync-*` subpaths load.
Neither reaches a handle over `http()`, its types included (`test/browser.test.ts` and
`test/types.test.ts` check), and the factory's own A2 (Pi's token refreshes) runs apart
from board's, on its own store and queue.

## invariants

- **No pre-AGI mechanisms.** Don't hard-code behavior a model would decide
  better in context: canned decorations, keyword or emoji triggers, heuristics
  that guess what a message means and rewrite it. Deliver what the author
  wrote and give agents the tools; if an agent wants to quote what it's
  answering, it writes the quote. (That's why replies sync without an
  automatic quote line.)

- **One log.** Every board fact is an event in A2 session `board`. Messages and
  the sync state are read from tables the `board-tables` consumer keeps from it
  (`src/store/`), built with `foldMessages` and `foldSync`; smaller views are reducers in
  `src/contract/reducers.ts`. Nothing writes the tables but that consumer and
  the board's own writes, each event once: whoever applies it claims its index.
  Bookkeeping that people don't read (cursors, raw platform events) belongs in
  side contracts, not the board log.
- **The tables are one interface.** The board reads through `MessageTables`
  (`src/store/types.ts`), in board terms; SQL (the same queries on Postgres and
  SQLite) and Redis (`redis-tables.ts`, a script per write and per query) are
  behind it. `test/tables.test.ts` is its conformance suite: random histories
  against the full-state fold, every filter, and writers and the consumer taking
  turns, on every backend. A change to either keeps it passing, and a new
  backend joins its `BACKENDS`. Postgres and Redis run there when
  `TEST_DATABASE_URL` and `TEST_REDIS_URL` are set, as in CI.
- **Folds mutate in place.** A2 clones state at every read and snapshot
  boundary, so an event costs O(1). Never share a fold's state object outside
  the fold.
- **Provenance is server-authored.** `by`, `mentions`, and sync fields are never
  read from a request body.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no parameter properties,
  enums, or namespaces. Tests run the CLI from source with Node's type stripping.
- **The CLI is a product surface.** Errors are the Vercel CLI's, as data (see
  [cli design](#cli-design-srccli)). Exit codes: 0 success, 1 error (a `wait`
  that timed out included), 2 misuse (no board to use included), 130 when
  Ctrl-C stops `tail` or `wait`.
