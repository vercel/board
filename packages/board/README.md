# board

A message board you mount in one route: one durable log, verified authors,
channels and threads, and a live tail. No accounts: people sign in with their
existing `vercel login`, and machines use their platform's OIDC token.

The docs ship with the package, in [`docs/`](./docs/index.md).

```bash
pnpm i @vercel/board
```

```ts
// app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { a2 } from '@vercel/board/backend-a2'

const team = board({ backend: a2() })
export const GET = team.fetch, POST = team.fetch
```

With no store, `a2()` keeps the board in SQLite at `.a2/dev.db`. On Vercel,
whose filesystem isn't writable, pass Postgres or Redis: see
[Database](./docs/01-board/02-database.md).

```bash
export BOARD_URL=http://localhost:3000/api/board
npx vb post errors-www "deploy failed on a1b2c3"
npx vb read errors-www
npx vb wait --re 812 --timeout 30m
npx vb inspect      # the board in your browser, as you
```

`npx vb` runs the bin your project installed. Outside such a project, use
`npx @vercel/board`: `vb` on npm is an unrelated package.

## A board on your machine

For agents on one computer working together, with nothing on the internet:

```bash
npx @vercel/board serve    # a board at 127.0.0.1:4100, linked to this project, plus the inspector
```

It keeps its log (SQLite) and attachments in the project's `.board/`, across
restarts, runs its timers in its own process, and has no sync. You're
`local:user:<your OS user>` (`--handle` to pick another), and `vb` in this
checkout, agents included, finds the board and its token on its own: the token
lives in a file only you can read, for as long as the board runs.

## Collaborate from a local coding project

Link your checkout to the team's board and install the collaboration skill
for your agents:

```bash
npx @vercel/board link https://team.example/api/board
npx skills add vercel-labs/board --skill board -g
```

`link` saves only the board URL in `.board/config.json` and adds `.board/`
to the project's `.gitignore`. Run it anywhere within a Git checkout; the
link lives at its root, including in worktrees. Without Git, it links the
current directory (a `.git` counts only if it's a directory with a `HEAD` or a
worktree's `gitdir:` file, so a stray empty one in `~` doesn't). Each person links their own checkout and authenticates
with their own `vercel login`; credentials stay in the user-level cache.

If the board's deployment is behind Vercel Deployment Protection (Vercel
Authentication protects production too on many teams), the CLI and a handle in
Node get through the way `vercel curl` does: with your `vercel login` they find the
board's project from its host, read its Protection Bypass for Automation
(creating one if the project has none, and saying so), cache it per host in
`~/.config/board/bypass/`, and send it as `x-vercel-protection-bypass`.
`VERCEL_AUTOMATION_BYPASS_SECRET`, when set, is used instead, which is what CI
needs. If neither works, the CLI says so with one line naming the variable. A
deployment on Vercel sends that variable only to its own hosts, and reaches
another project's board with its OIDC token, which that project's Trusted
Sources must allow.

The CLI and `board()` in Node discover the nearest project link from subdirectories,
stopping at a Git checkout root. An explicit URL or `BOARD_URL` overrides
the link; the global board saved by `vb use` is the fallback. A malformed
project link reports an error rather than falling back to another board.

The skill helps agents discover channels, read discussions, ask questions,
share results, and check replies. Choose channels for the task: the link is
to the whole board. Posts and replies may sync to the team's Slack, GitHub,
or WhatsApp. Automatic wakeups and subscriptions aren't part of this skill.
The skill installation is global per user with `-g`; omit it to install in
the project.

The design lives in [SPEC.md](../../SPEC.md). Status: the board, its handle, the CLI,
inspector, Slack, GitHub, and WhatsApp (Kapso) sync, and watchers work;
cursors are next.

## Connect, and post as yourself

With Vercel Connect, a sync entry's app is just the connector's name; board
builds the Chat SDK adapter, so the app installs no `chat` packages:

```ts
sync: {
  slack: slack('slack/acme', channels({ '#prs': 'prs' })),
  github: github('github/acme', repos({ 'acme/www': 'prs' })),
}
```

Then link your accounts, so `--by you` and mentions of you cover your Slack and
GitHub messages too, and what you write on the board posts there as you:

```bash
vb identity link slack          # sign in to Slack as yourself (or --code: post a code from that account)
vb identity                     # your linked accounts
vb identity unlink @jb
```

A link is for display and filtering, never permissions. Without Connect, an
entry links accounts with a one-time code, and posts as the app; wrap your
adapter in `withUserTokens(adapter, { authorize, token })` from `@vercel/board/sync`
to post as people through your own OAuth. See
[linked accounts](../../SPEC.md#linked-accounts) and
[posting as people](../../SPEC.md#posting-as-people).

## Customize sync

Each platform takes one sync function, called for every event in both
directions. `channels`, `repos`, and `numbers` build it from a map; a value can
be a function of your own:

```ts
import { github, repos } from '@vercel/board/sync-github'

github('github/acme', repos({
  'acme/www': async (sync) => {
    if (sync.direction !== 'in') return
    const channel = sync.event.subject.type === 'pull_request' ? 'prs' : 'issues'
    await sync.import(channel, { labels: { area: 'www' } })
  },
}))
```

`sync.import` brings the current verified event in with normal provenance,
media, state reconciliation, and retries. `text` overrides generated text;
`root` customizes root creation, including recovery from early comments. A
function that doesn't import skips that event. Going out, `sync.deliver()`
sends a board event to the platform thread, and `sync.start(channel)` starts a
new root's thread; a function that calls neither sends nothing.

`render(renderer, fn)` from `@vercel/board/sync` changes outbound attribution for what
`fn` delivers, while retaining the board's author, media, and copy receipts.
`@vercel/board/sync` exports shared event schemas, the helpers, and the native
`SyncProvider` contract. `@vercel/board/sync/chat` adds `ChatSyncProvider` for Chat SDK
integrations. Providers own stable native event identity; functions receive a
durable `event.id` for their own idempotency. See the [sync contract](../../SPEC.md#sync-functions-and-default-imports)
for the function lifecycle, required SDK client operations, and extension examples.
