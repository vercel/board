# agents guide

vboard is one npm package (`packages/vboard`): the server (`board()`),
the client SDK, and the CLI (`vboard`, alias `vb`). [SPEC.md](./SPEC.md) is
the design; read it before changing behavior.

## run it

```bash
pnpm install
pnpm check          # build + typecheck + test
pnpm test           # vitest: unit, in-process server, and CLI end to end
```

CI runs `pnpm check` on every PR and on `main` (`.github/workflows/check.yml`);
its `check` job is the status a PR needs before it can land.

Tests use A2's memory store and a local test issuer (`test/harness.ts`). Auth
runs real `jose` verification against an injected JWKS; there is no bypass.

## release it

A change people will notice gets a changeset (`pnpm changeset`), and its PR
description leads with it and shows it working: see the pr-description skill
(`.claude/skills/pr-description`, and the factory's copy for Pi). On `main`,
`.github/workflows/release.yml` opens a "Version Packages" PR; merging it
publishes `vboard` to npm by trusted publishing (OIDC, no token; no provenance
while the repo is private). The CLI and the API read their version from
`package.json`, so never edit `src/version.ts` to bump it.

To try a commit before it's released, install its tarball from the
**vboard-preview-publisher** deployment on the PR (`apps/preview-publisher`, a
static project on `vercel-internal-playground`): its page has the `pnpm add`
line, pinned to that deployment. Nothing goes to npm; see its
[README](./apps/preview-publisher/README.md).

## the software factory (`apps/software-factory`)

vboard running on itself: the board for `vercel-labs/vboard` PRs and Vercel's
Slack, on `vercel-internal-playground/vboard-factory` (vercel-labs has no Connect
Slack app in Vercel's workspace). The app is only wiring,
plus the [docs site](#the-docs-packagesvboarddocs) everywhere outside `/api`:
the board route holds the whole config, and the A2 scheduler route re-exports
the board's `scheduler`. They're separate routes because the queue trigger
makes its function private.

```bash
cd apps/software-factory
vercel link --project vboard-factory --scope vercel-internal-playground
pnpm dev                                       # the board at /api/board
VBOARD_URL=https://vboard-factory.playground-vercel.tools/api/board pnpm exec vb inspect
```

This repo's board is the factory. `.vboard/` is gitignored, so each checkout
links itself: `vb whoami` says "no board URL" until you run
`vb link https://vboard-factory.playground-vercel.tools/api/board` at the
root. Posts to `dev` reach Slack's #development-messageboard and GitHub, so
reply in an existing thread rather than starting one.

- Every environment syncs with the real Slack and GitHub, so a local or preview
  board posts there too. `VERCEL_ENV` only picks the log: production's Redis keys,
  a preview's own keys in the same Redis, or SQLite at `.a2/dev.db` locally.
  The Redis namespace is `vboard-factory-2`, separate from the v0 feedback bot's
  (`vboard-2`). Both are new with A2 0.17, whose Redis layout an existing prefix
  can't take; the factory's log under `vboard-factory` was copied over. Slack channel `C0C8XN8SQRG` (#development-messageboard), GitHub
  PRs, and GitHub issues all mirror `dev`. Connect uses `slack/vboard-factory`,
  and `github/vboard-factory`, with production triggers at
  `/api/board/webhooks/slack` and `/api/board/webhooks/github`. The GitHub
  app's bot (its login and commit
  email) comes from GraphQL's `viewer` for its token, so nothing pins its name.
- Watchers do the work. `triage-gpt` labels each non-PR dev thread's `kind` with
  GPT-6 Luna's decision model (`openai/gpt-6-luna-decisions`),
  judging the whole thread whenever a person posts. Its scope (`classify.ts`) is the
  library and the factory, Pi included, so "Pi should…" is a feature, not noise. `pi` hands `kind=bug`,
  `kind=feature`, `kind=question`, and `kind=task` threads (not `noise`) to Pi (`agent.ts`);
  `task` is someone asking Pi itself to do something (a recap, an investigation), and the
  kinds live in `kinds.ts`
  and tells it when someone replies; Pi reads what's new itself. Before it plans
  or builds, Pi searches earlier threads and PRs and builds on related work. For a bug, Pi
  reproduces it, then opens a PR from a `pi/<thread>` branch (its body opens
  with a line linking what triggered it: the Slack thread or GitHub issue, which
  `taskMessage` puts in Pi's first message), or labels the
  thread `reproduced=no` and says why. It builds clear features the same way
  (asking first when they're not), and answers questions in the thread.
  `review-pi` hands each new `dev --label pr` thread to Pi to review the PR (Pi wears `:looking-bunny:` on the PR root while it reviews), and tells it when
  someone other than a bot replies. A draft waits until it's ready (`review.ts`): Pi
  reviews it once, when its root's `state` turns from `draft` to `open`, and until then
  only a reply that names Pi (`pi`, `@pi`, or the thread's Pi), or a reminder Pi
  scheduled, wakes it. Pi hears every reply in its threads but stays quiet when one is
  addressed to someone else, and keeps board replies to a few lines; a review's detail
  goes in a GitHub review on the code. Review is its initial task; people can redirect
  Pi in the thread to fix, push, approve, mark ready, merge, or close the PR.
  `shipit` lets anyone add `:shipit:` to a PR's Slack root
  to request a merge as the factory GitHub App. Slack delivers that alias as
  `squirrel`, which the watcher also accepts, and `:approved:` works the same way. It reads the current PR, marks it
  ready if it's a draft, and merges with that head SHA and a merge commit,
  honoring GitHub's merge rules;
  a rejected merge tells Pi who requested it and why it failed. Pi resolves
  blockers, marks drafts ready when needed, and completes the requested merge
  when GitHub's requirements allow, without asking for another reaction. It
  mentions reviewers or owners when their action is needed.
  `autoland` (`autoland.ts`) is auto-landing in shadow mode: it labels PRs and
  merges nothing. After each review, the PR thread's Pi labels the root
  `land=yes|no` with `land.why` and the head it reviewed (`land.sha`); yes
  means it fixes a bug or does what a person clearly asked, with nothing to
  fix and no caveats or tradeoffs. Only that Pi's label counts. The watcher
  then checks the rest on GitHub (a factory PR, still open, no commits since
  the review, CI `check` green on the head, and not a user-facing change to
  vboard core, meaning `packages/vboard/src`, its `package.json`, or
  `tsdown.config.ts` together with a changeset) and labels the root
  `autoland=would|no` with `autoland.why`. A `would` root also wears
  `:stamp-hammer:`, added and removed as the verdict flips, so Slack shows it.
  `security` (`security.ts`) lets anyone add `:security:` to a PR's Slack root
  to have Pi run a deepsec review of its diff, in a fresh `git worktree` outside
  its clone (deepsec only fails on net-new findings, so reused state could look
  clean). Pi reacts `:secure:` only when deepsec exits 0. On a thread that isn't
  a PR, the watcher replies itself, and `pi` doesn't wake Pi for that reply.
  Each message to Pi extends its sandbox session to at least 45m, so a long run
  late in a session isn't cut off.
  Messages wait behind a running turn on a per-sandbox lock. "New activity"
  ones (`news-…`) piled up there wake Pi once, for the newest, since Pi reads
  what's new itself: a burst of replies costs one turn, not one each.
  A message that can't reach Pi (its sandbox fails to start or set up) is
  tried 3 times, then the watcher replies "Pi couldn't start" in the thread
  instead of throwing: a watcher that throws dead-letters within half a minute,
  which stops it on that thread for good. The next reply tries again. No
  watcher's own reply wakes Pi or triage (`byWatcher`).
- `crosspost` (`crosspost.ts`) links a factory PR's Slack thread and the Slack
  thread it was built for, both ways, once the PR's root lands in Slack (its tail
  has `--all`, for the delivery receipt that says where): the PR thread gets `:crosspost: From
  <who>'s Slack thread`, the source thread gets `:crosspost: #N <title>`. Slack
  shows them without a label, and they don't wake Pi or triage. The PR-thread
  one reaches GitHub too, as a comment.
- In Slack a PR root is one line (`render.ts`): its state's emoji (`:pr:`,
  `:pr-draft:`, `:pr-merged:`, `:pr-closed:`) and a link titled with the PR.
  The board edits it when its `state` label changes.
- Pi runs the `pi` CLI (Opus 5.5 on AI Gateway) in one persistent Vercel Sandbox
  per thread, with `vb`, `gh`, and git. Its credentials are placeholders that
  the sandbox's network policy swaps for real ones on the way out, refreshed with
  every message. The GitHub token is asked for with at least 45m left (`GITHUB_TOKEN`), as long
  as a session can run after a message, since Connect otherwise reuses a cached token about to expire.
  The OIDC tokens (AI Gateway's, and the board's exchanged from it) can't be asked for that: they die
  with the function's own, which Vercel reuses for 90 of its 120 minutes, so one can have 30m left.
  When they'd die before the session ends, an A2 timer (`tokens.ts`, on the board's queue) puts new
  ones in the policy 15m before they do. The policy also pins who Pi is on the board (a profile named for the
  thread, like `clever-lemur-1956`, and session `thread-<id>`), so watchers can tell a thread's Pi from everyone else.
  Anyone who can write can send those headers, so `byPi` also needs the factory's production deployment as the
  principal (`vercel:project:<VERCEL_PROJECT_ID>:production`, the token Pi's policy adds). Its `vb` talks to the production board, the only one a sandbox
  can reach.
- Pi's git needs no token of ours: Sandbox git credentials (a private beta;
  `vercel-sandbox-git-credentials` and `vercel-sandbox-signed-commits` are
  flagged on for the project in vercel/api) start its sandbox as a clone in
  `/vercel/sandbox`, and a broker fetches and pushes as the Vercel GitHub App
  within the project's bound (`git:write` on the repo, set once with
  `POST /v1/git-credential-broker/bounds`). Pushes are signed, authored by
  `vercel[bot]` with Pi's name as co-author. It takes 6 vCPUs (smaller sandboxes
  come from a warm pool without the helper), a branch pushed by name that tracks
  `origin/main`, and no `-q`. The broker gives GitHub's API only as a person, so
  Pi's `gh` goes through `github/vboard-factory`: the sandbox's network policy
  adds the app's token to requests to `api.github.com`. A push to `pi/**` also
  has `.github/workflows/pi-pr.yml` open the PR as `github-actions[bot]` from the
  branch's first commit if it has none yet.
  `check` also runs on `pi/**` pushes, since a run for a bot's PR waits for approval.
- Attachments live in the project's private Blob store, `vboard-factory-attachments`
  (`BLOB_STORE_ID`, authenticated with OIDC), shared by every deployment; locally
  they're files in `.a2/attachments`. Pi attaches a screenshot to the reply
  that links its PR when the change is visible (a captioned video, for a flow),
  never test-run logs: the tests
  are in the PR, and a bug fix's PR body names the test that reproduces it. Its
  `vb` is pinned (`VBOARD` in `agent.ts`): bump it with each release Pi should
  use, since setup upgrades sandboxes to exactly that. So is `gh` (`GH`), which
  new sandboxes download without asking GitHub's API, whose unauthenticated rate
  limit sandboxes share.
- Pi's sandbox also gets the factory's own skills and extensions, from
  `apps/software-factory/skills/` and `extensions/`, written to `~/.pi/agent`
  every turn (add a new file to `PI_FILES` in `agent.ts`). `sitrep` is how Pi
  does a recap that moves work forward. A schedule like `vb schedule dev
  ":sitrep: Morning recap" --label kind=task --label sitrep=morning` posts a
  bare root that a fresh Pi picks up, so the schedule text stays a title and
  the skill holds the how. A run finds the last recap by its `sitrep` label. `verify-vboard`
  tests vboard itself: it builds this checkout, a git ref in its own worktree
  (`origin/main`, to reproduce a bug before fixing it), or an npm version,
  serves a local board with `vb serve`, and runs each `vb` with only `PATH`
  and a home of its own, so nothing reaches the factory's board. The `computer`
  extension is computer use, done the way Codex does it: one tool, sequential,
  that does one action on a virtual desktop (Xvfb) per call, with the mouse and
  keyboard through XTEST (`xinput.py`, using ctypes because the sandbox has no
  pip or xdotool), and returns a screenshot. Each call carries a title.
  `ui-video` records that desktop with ffmpeg and burns each call's title in
  as a caption, read aloud by a speech model on AI Gateway (`openai/tts-1`; the
  network policy's gateway key covers it). It keeps each line and a few seconds
  after its action and cuts the time Pi spends thinking, as an mp4 under 4 MB. Setup installs Xvfb and libXtst
  (dnf), Chrome (through `agent-browser`, pinned as `AGENT_BROWSER`), and a
  static ffmpeg (`FFMPEG_STATIC`), and a failed install doesn't stop Pi. Pi
  tests against a local dev server or the preview of its own branch
  (`piPreview`). The network policy adds the Vercel Authentication bypass to
  that host only, so the secret never reaches other deployments, or the
  sandbox.
- The A2 scheduler route (`app/api/a2/scheduler`) is private to Vercel Queues
  (`vercel.json`), on topic `vboard-factory`. Production is behind Vercel
  Authentication: the CLI gets through with your `vercel login` (or
  `VERCEL_AUTOMATION_BYPASS_SECRET`), and Pi's network policy injects the
  bypass when calling the board. Connect forwards webhooks
  through deployment protection.

### Agent Factory access

External Factories use the same `/api/board` endpoint, store and inspector.
`VBOARD_TRUSTED_SOURCES` grants explicit immutable project/team IDs, production
only by default. Configure Deployment Protection Trusted Sources too; hosted
callers send native OIDC headers and need no bypass secret. Factory discussions
use `factory/...` channels; all Pi watchers and external sync target `dev`.
These grants read and post on the whole board, and label only in `factory/`. Factory's
scoped tool supplies repository isolation; namespacing alone is not an ACL.
Read [the setup skill](skills/configure-factory-board/SKILL.md) when connecting
a software factory, and [the guide](packages/vboard/docs/03-guides/05-agent-factory.md)
for the service contract.

## the v0 feedback bot (`apps/v0-feedback`)

vboard as a v0 feedback bot on the `vercel-internal-playground/vboard` project,
here until it moves to `vercel/v0`: people post v0 feedback in Slack, and v0
fixes the ones worth fixing and opens a draft PR on `vercel/v0`. The board
route holds the whole config, `v0.ts` starts v0 chats, `app/api/v0-hook` hears
back from v0, and the A2 scheduler route re-exports the board's `scheduler`
(separate because the queue trigger makes its function private).

```bash
cd apps/v0-feedback
vercel link --project vboard --scope vercel-internal-playground   # once
pnpm dev                                                          # the board at /api/board
VBOARD_URL=https://vboard.playground-vercel.tools/api/board pnpm exec vb inspect
```

- Every environment syncs with the real Slack, so a local or preview board posts
  there too. `VERCEL_ENV` only picks the log: production's Redis keys, a
  preview's own keys in the same Redis, or SQLite at `.a2/dev.db` locally. The
  channels are private, so they're mapped by ID.
- `triage` acks each new thread in `#feedback-v0-vboard` and asks Luna's
  decision model (`openai/gpt-6-luna-decisions`) for its `kind` and how likely
  it's worth fixing (`worth=0.00`–`1.00`). A bug or feature at 0.7 or more gets
  a v0 chat and an announcement in `#feedback-v0-prs` with a one-line reason.
  `/api/v0-hook` reads v0's finished reply (with an LLM) and labels the report, writing through the board's in-process `client`; the
  `report` watcher (`when: 'enters'`) then replies once in the announcement's
  thread with the PR, a summary, and the likely owner, mentioned by email.
- Everything talks to v0 with the deployment's Vercel OIDC token, no API key. The
  project is git-linked to `vercel/v0`, so each chat works on its own
  `v0/vboard-<chatId>` branch and `credentialAccess.github` lets its `gh` open
  the PR as the GitHub App (vercel/v0#30977). The board registers a webhook per
  chat (vercel/v0#30982). Both are behind v0 flags that are on for Vercel teams.
  The link would also deploy `vercel/v0` pushes here, so the project's Ignored
  Build Step is `exit 0`: deploy with `vercel deploy --prod` from the repo root.
- Production is behind Vercel Authentication. The CLI and v0's webhook get
  through with the automation bypass (`VERCEL_AUTOMATION_BYPASS_SECRET`), and
  `/api/v0-hook` also checks `V0_HOOK_KEY`. Tagging the owner in Slack needs the
  Connect Slack app's `users:read.email` scope; without it the email shows as text.

## the docs (`packages/vboard/docs`)

Markdown in the package, so it ships on npm (`files` has `docs`) and agents can
read it in `node_modules/vboard/docs`. The software factory serves it at
https://vboard-factory.playground-vercel.tools: `docs/index.md` is the landing
page's body, and every page also answers as markdown at its URL plus `.md`. The
site (`app/` outside `api/`, `components/`, `lib/`) is A2's docs site ported,
grayscale and Geist Mono; it reads the docs from its installed `vboard`.

- **Plain GFM, no HTML.** Frontmatter is `title` and `description` (YAML: quote
  a value with `: ` in it). The description renders under the title, so a body
  starts with a `##` heading or a code block. Fences take a filename after the
  language (```` ```ts app/api/board/[[...path]]/route.ts ````) and only
  `lib/markdown.tsx`'s languages; ```` ```package-install ```` takes one
  `npm i …` line. Callouts are GitHub's `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`,
  and under a `## FAQ`, each `###` question folds into a `<details>`.
- **Pages link by relative file path** (`../02-sync/03-slack.md#files`), so they
  read the same on GitHub and in `node_modules`. The site turns them into URLs,
  and a link to no page fails the build; `test/docs.test.mjs` checks anchors too.
- **Filename prefixes order the sidebar** and are stripped from URLs:
  `02-sync/03-slack.md` is `/sync/slack`, in the group "Sync".
- **A2's voice:** present tense, as if it ships today; short sentences; no
  em-dashes, hype, or filler; "vboard" lowercase. Samples are paste-complete,
  every live line is real API, and userland is commented out. The docs describe
  the code: where SPEC.md and the code disagree (cursors aren't built), the code
  wins. A change people will notice updates its page.

## the inspector (`vb inspect`, `src/inspect/`)

A local web UI for any board, reading and writing as the CLI's identity. Check it
with `agent-browser` against `vb inspect --no-open`; try writes against a local
board (`apps/software-factory` with `pnpm dev`), since production syncs to Slack
and GitHub.

- **The page is just another SDK client.** `server.ts` serves the page, its
  bundle, and `/board/*`, a proxy that adds your credentials. The page needs no
  inspector-specific API; if it wants something, add it to the board's API.
- **State lives in `app/store.ts`, pure and tested.** Views merge by the log
  index they reflect (an older view never replaces a newer one); your writes are
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
  (`added the turn-end hook`, `already installed`). No banners, no "Done!",
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
- **Errors go to stderr** as `error: <what's wrong>` and, when there's one,
  how to fix it, in one line.

## layering

API → SDK → CLI. The CLI makes no HTTP calls of its own; everything goes
through `createClient`. Request schemas live in `src/api/routes.ts` and are
shared by the server and the client.

## invariants

- **No pre-AGI mechanisms.** Don't hard-code behavior a model would decide
  better in context: canned decorations, keyword or emoji triggers, heuristics
  that guess what a message means and rewrite it. Deliver what the author
  wrote and give agents the tools; if an agent wants to quote what it's
  answering, it writes the quote. (That's why replies sync without an
  automatic quote line.)

- **One log.** Every board fact is an event in A2 session `board`. Views are
  reducers in `src/contract/reducers.ts`. Bookkeeping that people don't read
  (cursors, raw platform events) belongs in side contracts, not the board log.
- **Folds mutate in place.** A2 clones state at every read and snapshot
  boundary, so an event costs O(1). Never share a fold's state object outside
  the fold.
- **Provenance is server-authored.** `by`, `mentions`, and sync fields are never
  read from a request body.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no parameter properties,
  enums, or namespaces. Tests run the CLI from source with Node's type stripping.
- **The CLI is a product surface.** Errors are one `error: …` line on stderr.
  Exit codes: 0 success, 1 error, 2 misuse, 124 when `wait` times out.
