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

Tests use A2's memory store and a local test issuer (`test/harness.ts`). Auth
runs real `jose` verification against an injected JWKS; there is no bypass.

## release it

A change people will notice gets a changeset (`pnpm changeset`). On `main`,
`.github/workflows/release.yml` opens a "Version Packages" PR; merging it
publishes `vboard` to npm by trusted publishing (OIDC, no token; no provenance
while the repo is private). The CLI and the API read their version from
`package.json`, so never edit `src/version.ts` to bump it.

## the software factory (`apps/software-factory`)

vboard running on itself: the board for `basehub-ai/vboard` PRs and Vercel's
Slack, on `vercel-internal-playground/vboard-factory`. The app is only wiring:
the board route holds the whole config, and the A2 scheduler route re-exports
the board's `scheduler`. They're separate routes because the queue trigger
makes its function private.

```bash
cd apps/software-factory
vercel link --project vboard-factory --scope vercel-internal-playground
pnpm dev                                       # the board at /api/board
VBOARD_URL=https://vboard-factory.playground-vercel.tools/api/board pnpm exec vb inspect
```

- Every environment syncs with the real Slack and GitHub, so a local or preview
  board posts there too. `VERCEL_ENV` only picks the log: production's Redis keys,
  a preview's own keys in the same Redis, or SQLite at `.a2/dev.db` locally.
  The Redis namespace is `vboard-factory`, separate from the v0 feedback bot.
  Slack channel `C0C6MNT9LLC`, GitHub PRs, and GitHub issues all mirror `dev`.
  Connect uses `slack/vboard-factory` and
  `github/vboard-factory`, with production triggers at
  `/api/board/webhooks/slack` and `/api/board/webhooks/github`.
- Watchers do the work. `triage-gpt` labels each non-PR dev thread's `kind` with
  GPT-6 Luna's decision model (`openai/gpt-6-luna-decisions`),
  judging the whole thread whenever a person posts. `pi` hands `kind=bug`,
  `kind=feature`, and `kind=question` threads (not `noise`) to Pi (`agent.ts`)
  and tells it when someone replies; Pi reads what's new itself. For a bug, Pi
  reproduces it, then opens a PR from a `pi/<thread>` branch, or labels the
  thread `reproduced=no` and says why. It builds clear features the same way
  (asking first when they're not), and answers questions in the thread.
  `review-pi` hands each new `dev --label pr` thread to Pi to review the PR, and tells it when
  someone other than a bot replies. Pi hears every reply in its threads but stays quiet when one is
  addressed to someone else, and keeps board replies to a few lines; a review's detail
  goes in a GitHub review on the code. Review is its initial task; people can redirect
  Pi in the thread to fix, push, approve, mark ready, merge, or close the PR.
  `shipit` lets anyone add `:shipit:` to a PR's Slack root
  to request a merge as the factory GitHub App. Slack delivers that alias as
  `squirrel`, which the watcher also accepts. It reads the current PR, marks it
  ready if it's a draft, and merges with that head SHA and a merge commit,
  honoring GitHub's merge rules;
  a rejected merge tells Pi who requested it and why it failed. Pi resolves
  blockers, marks drafts ready when needed, and completes the requested merge
  when GitHub's requirements allow, without asking for another reaction. It
  mentions reviewers or owners when their action is needed.
  `security` (`security.ts`) lets anyone add `:security:` to a PR's Slack root
  to have Pi run a deepsec review of its diff, in a fresh `git worktree` outside
  its clone (deepsec only fails on net-new findings, so reused state could look
  clean). Pi reacts `:secure:` only when deepsec exits 0. On a thread that isn't
  a PR, the watcher replies itself, and `pi` doesn't wake Pi for that reply.
  `followup` (`followup.ts`) nags the DRI of every PR the factory opens: whoever
  started the board thread on its `pi/<thread>` branch. It pings them in the PR's
  thread 1h after it opens, then at doubling gaps (2h, 4h, … 64h: 7 pings), and
  closes the PR a week after it opened if no one acts. A message from the DRI in
  the PR's thread or the source thread restarts the cycle; merged or closed stops
  it. It's an A2 side contract (`vboard-factory-followups`) on the board's store
  and queue, so the scheduler route serves it too. A2 timers can't be canceled:
  each carries its cycle, and a stale one does nothing.
  Each message to Pi extends its sandbox session to at least 45m, so a long run
  late in a session isn't cut off.
- In Slack a PR root is one line (`render.ts`): its state's emoji (`:pr:`,
  `:pr-draft:`, `:pr-merged:`, `:pr-closed:`) and a link titled with the PR.
  The board edits it when its `state` label changes.
- Pi runs the `pi` CLI (Opus 5.5 on AI Gateway) in one persistent Vercel Sandbox
  per thread, with `vb`, `gh`, and git. Its credentials are placeholders that
  the sandbox's network policy swaps for real ones on the way out, refreshed with
  every message. The policy also pins who Pi is on the board (profile `pi`,
  session `thread-<id>`), so watchers can tell a thread's Pi from everyone else. Its `vb` talks to the production board, the only one a sandbox
  can reach.
- Attachments live in the project's private Blob store, `vboard-factory-attachments`
  (`BLOB_STORE_ID`, authenticated with OIDC), shared by every deployment; locally
  they're files in `.a2/attachments`. Pi attaches proof (test runs, screenshots) to the reply
  that links its PR. Its `vb` is pinned (`VBOARD` in `agent.ts`): bump it with
  each release Pi should use, since setup upgrades sandboxes to exactly that.
- The A2 scheduler route (`app/api/a2/scheduler`) is private to Vercel Queues
  (`vercel.json`), on topic `vboard-factory`. Production is behind Vercel
  Authentication: the CLI needs `VERCEL_AUTOMATION_BYPASS_SECRET`, and Pi's
  network policy injects it when calling the board. Connect forwards webhooks
  through deployment protection.

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

## layering

API → SDK → CLI. The CLI makes no HTTP calls of its own; everything goes
through `createClient`. Request schemas live in `src/api/routes.ts` and are
shared by the server and the client.

## invariants

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
