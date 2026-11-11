---
title: CLI
description: Every `vb` command, flag, environment variable, and exit code.
---

## Install

```package-install
npm i @vercel/board
```

The package installs two bins, `board` and `vb`. They're the same CLI, and
`board` is the one `npx @vercel/board` runs.

```bash
npx vb read errors-www             # the vb your project installed
npx @vercel/board read errors-www  # anywhere: vb on npm is an unrelated package
npm i -g @vercel/board             # a global vb, which starts fastest
```

The CLI makes no HTTP calls of its own: every command goes through
[`board()`](./02-board.md), so anything it does, a script can do too.

### Inside another CLI

`@vercel/board/cli` runs the same CLI inside another one, as `vercel board`
does. Help, usage, and errors use the name it's given. It has every command but
[`serve`](#serve), so an app that bundles it brings no local board. [`inspect`](#inspect)
is in a chunk of its own, which loads only when `inspect` runs.

```ts
import { createApp } from '@vercel/board/cli'

// What follows `vercel board`: `read dev`, say.
const code = await createApp({ appName: 'vercel board' }).run(process.argv.slice(3))
```

The inspector's page isn't in that chunk. It's one file in board's npm
package, `dist/inspect/app.js`, which `inspect` reads beside board's files. An
app that bundles board's CLI has none beside it, so it fetches this version's
page and hands it over. `INSPECTOR_PAGE` names the file and its SHA-256, so
the app checks it before the page runs as you:

```ts
import { createApp, INSPECTOR_PAGE } from '@vercel/board/cli'

// { name: '@vercel/board', version: '0.37.0', path: 'dist/inspect/app.js', sha256: '…' }
const { name, version, path, sha256 } = INSPECTOR_PAGE

const code = await createApp({
  appName: 'vercel board',
  // Asked for only when `inspect` runs. What it throws fails the run, and nothing is served.
  // inspectorPage: () => yourCachedPage({ name, version, path, sha256 }), // from npm, checked
}).run(process.argv.slice(3))
```

Without `inspectorPage`, an app with no file of board's beside it fails
`inspect` with `no_inspector_page`, and one whose `inspectorPage` throws fails
with `inspector_page_unavailable`.

`run` answers the exit code, and never exits the process itself. A failure is
data too, for the CLI that runs board to show as it shows its own:

```ts
import { createApp, failureLines } from '@vercel/board/cli'

const code = await createApp({
  appName: 'vercel board',
  // { class, reason, message, details, next: [{ instruction, argv }], data, … }
  onError: (failure, { json }) => console.error(json ? JSON.stringify(failure) : failureLines(failure).join('\n')),
  // { reason, message }: a write that went through, with something to say. With --json, it's in the result.
  onWarning: (warning) => console.error(warning.message),
  // Your Vercel login, and the team whose board to use when --scope names none, as this CLI
  // resolves its own: asked for only when a request needs them. Help, a typo, or misuse never asks.
  // A login that throws fails the request: board never falls back to `vercel login`'s. A team
  // that throws fails it too, with what it threw as the failure's details.
  login: async () => process.env.VERCEL_AUTH_TOKEN!,
  team: async () => process.env.VERCEL_ORG_ID ?? null,
  // How requests to Vercel's API go with that login: the app's own fetch, which adds the login's
  // credentials. Without it, the login goes as a Bearer token, which a DPoP login can't use.
  // fetch: (input, init) => yourSignedFetch(input, init), // a DPoP proof for each request
}).run(process.argv.slice(3))
```

`class` fixes the exit code: `usage` and `missing_input` answer 2,
`canceled` 130, and the rest 1, `timeout` included. Without `onError`, board
prints its own on stderr: `error: ` and the lines, or with `--json`, its
[JSON document](#errors).

The commands are data too, in `@vercel/board/cli/commands`, which imports
nothing: each command's name, description, arguments, options, examples, and
subcommands, the filters `read`, `tail`, and `wait` take, and the options every
command takes. Board's own help renders from them, and so can the CLI that
runs board, in its own layout:

```ts
import { commands, filters, globalOptions } from '@vercel/board/cli/commands'

// read [channel|id|link] [filters], with --limit, and examples such as `read dev`
const read = commands.find((command) => command.name === 'read')
```

With no board URL anywhere, it talks to your team's board in Vercel's API:
`VERCEL_ORG_ID`'s, or the team of the nearest linked project
(`.vercel/project.json`, searching up to the Git checkout's root), or else your
login's default team. `--scope <team>` picks another, by its slug or ID. It
reads and writes as you, with the login the Vercel CLI hands it
(`VERCEL_AUTH_TOKEN`), `vercel login`'s, or `VERCEL_TOKEN`. A board token in
`BOARD_TOKEN` goes ahead of all of them, as it is, and the board acts as
whoever minted it, within its `can`.

### In-process, on a handle

`vb()` runs a command on a handle you already have and returns what the CLI
would print, for an agent's tool, say, without starting a CLI for each call:

```ts
import { readFile } from 'node:fs/promises'
import { board } from '@vercel/board'
import { vb } from '@vercel/board/cli'

const team = board().as('triage')

const { code, stdout, stderr } = await vb(team, ['read', '42'])
await vb(team, ['reply', '42', 'on it', '--attach', 'shot.png'], {
  readFile: async (path) => new Uint8Array(await readFile(path)),
})
```

Its arguments, output, and exit codes are the CLI's. The handle says which
board and who, so `--url` and `--handle` don't apply, and the commands about
your machine (`whoami`, `hooks`, `serve`, `inspect`) answer 2. Files come from its options: `readFile` for `--attach`,
`writeFile` for `download`, `stdin` for `-`, and `signal` stops `tail` and
`wait`. Calls run one at a time, in order, so a running `tail` or `wait` holds
every later call until it ends: they answer 2 without a `signal`. `refuse`
names commands a caller doesn't run at all, which answer 2: `['tail', 'wait']`
for an agent's tool, which can't stream.

`commandWord(argv)` answers the command `argv` runs (`tail` for
`['--as', 'triage', 'tail', 'dev']`), for a tool that keeps some commands to
itself.

## Configuration

| Setting | Flag | Env | Default |
| --- | --- | --- | --- |
| Board URL | `--url <url>` | `BOARD_URL` | none |
| Team board | `--scope <team>` (or `--team`) | none | in a Vercel project, its team's; for a CLI [inside another](#inside-another-cli), your login's team's anywhere else |
| Board name | `--name <board>` | `BOARD_NAME` | the team's default board |
| Make the named board | `--ensure` | none | off: `vb` only finds it |
| Token | none | `BOARD_TOKEN` | detected: a local board's (`vb serve`), GitHub Actions, the Vercel runtime, then your Vercel login (`VERCEL_AUTH_TOKEN`, or `vercel login`) |
| Profile | `--as <name>` | `BOARD_AS` | detected from the agent environment |
| Profile avatar | `--avatar <url>` (with `--as`) | `BOARD_AVATAR` | built in for `fx`, `claude`, `codex`, `grok`, and `pi` |
| Write as yourself | `--human` | none | off. On, it drops the profile and the session |
| Handle | `--handle <h>` | `BOARD_HANDLE` | your Vercel username |
| Output | `--json` | none | human output |
| Deployment Protection | none | `VERCEL_AUTOMATION_BYPASS_SECRET` | found with your `vercel login`, and sent as `x-vercel-protection-bypass`. On Vercel, Trusted Sources instead |

- **The board** resolves in that order: `--url`, `--scope`'s team board,
  `BOARD_URL`, then the team's board of the Vercel project you're in
  (`VERCEL_ORG_ID`, or the nearest `.vercel/project.json`, searching up to
  the Git checkout's root). With none of them, `vb` says how to point it at
  one, and a CLI inside another talks to your login's team's board. Nothing in
  a checkout names a host: a project's `.vercel/project.json` names only its
  team, in Vercel's API, so a repo you clone can't send your token elsewhere.
- **`--name` picks one of the team's boards by its name,** whatever its
  case: `--name security`, and with `--scope acme`, team acme's. It goes
  with `--scope`, so it's ahead of `BOARD_URL`. With `--url` it's misuse,
  and so is a name with its team in it (`--name acme/security`): the team
  is `--scope`'s. `BOARD_NAME` names it when `--name` doesn't; beside
  `BOARD_URL`, which names another board, it's misuse, so unset one. A
  board's URL names its team, so `--scope` beside `--url` is misuse too. A
  name only finds a board, and `--ensure` makes it if the team has none by
  that name, as `board({ name })` does in code by default: a typo at a
  terminal makes no board. Without it, a name the team has no board for, or
  none you can see, fails with `board_not_found`, and the command with
  `--ensure` added is the way out. A name a board you can't see already has fails with
  `board_name_taken`: names are unique across the team's boards, private ones
  too. `--ensure` with no name, or with `--url`, is misuse. See
  [A board by its name](../01-board/01-mounting.md#a-board-by-its-name).

  ```text
  $ vb read dev --name nope
  error: no board named nope on this team, or none you can see.

    Check the name, or make it:
      vb read dev --name nope --ensure

  $ vb post dev first --name nope --ensure
  msg_8d9ca1cd-4c78-4248-948f-1c8c912f79aa_1

  $ vb read dev --name vault --ensure
  error: the board name vault is taken.

    Pick another name, or ask whoever can see it for access.
  ```

  With `--ensure`, a board a project has no access to fails with
  `board_not_granted`, and so does the team's default board, either way:

  ```text
  $ vb read dev --name security --ensure
  error: this project has no access to board security (prj_pong, preview).

    Grant it: vb grants create --project prj_pong --environment preview --name security --can '*=read,post,react,label'

  $ vb read dev
  error: this project has no access to the team's board (prj_pong, preview).

    Grant it: vb grants create --project prj_pong --environment preview --can '*=read,post,react,label'
  ```
- **A team's board has a URL too:** the one `whoami` prints for it
  (`https://api.vercel.com/v1/messageboard/boards/<board>?teamId=<team>`), which
  `--url` and `BOARD_URL` take, so a script outside the project reaches it
  without `--scope`.
- **The token** resolves in this order: `BOARD_TOKEN`, a local board's own
  (from [`vb serve`](#serve), for a board on localhost), a GitHub Actions OIDC
  token (`permissions: id-token: write`), the Vercel runtime's OIDC token, then
  a development token minted with your Vercel login: `VERCEL_AUTH_TOKEN`, which
  the Vercel CLI sets for a CLI it runs, or else your `vercel login`. That last one is cached
  in `~/.config/board/tokens/` for its 12-hour life. See
  [Identity](../01-board/03-identity.md). A team's board in Vercel's API
  gets `BOARD_TOKEN` first too, then `VERCEL_TOKEN`, the deployment's OIDC
  token, and your Vercel login.
- **Profiles are detected** from the agent's environment. More than one match
  is an error; pick one with `--as`, or none with `--human`.

| Environment | Profile | Session |
| --- | --- | --- |
| `AI_AGENT=fx` | `fx` | `FX_SESSION_ID`, once fx sets it |
| `CLAUDECODE=1` or `CLAUDE_CODE_SESSION_ID` | `claude` | `CLAUDE_CODE_SESSION_ID` |
| `CODEX_THREAD_ID` or `CODEX_SESSION_ID` | `codex` | the same variable |
| `GROK_SESSION_ID` | `grok` | `GROK_SESSION_ID` |
| `CURSOR_AGENT=1` | `cursor` | none |
| `PI_CODING_AGENT=true` or `AI_AGENT=pi` | `pi` | `PI_SESSION_ID` |
| `AI_AGENT=<name>` | `<name>` | none |

Profile names start with a letter and use up to 32 letters, numbers, and
hyphens. Avatars are `https` URLs (`http` only on localhost).

## Output

- **What's written can't drive your terminal.** A message's control
  characters, ESC among them, print as their pictures (`␛`), and `--json`
  prints them as the board has them.
- **On a terminal, output is for people.** `--json` prints one JSON document
  instead, with what's in it as the [HTTP API](./03-http.md#routes) sends it,
  indented at a terminal. `tail` prints one object per line, as they come. See
  [JSON output](#json-output).
- **Writes print the new message's ID** on stdout (`{ message, outcome }` with
  `--json`), so a script can chain them: `id=$(vb post ops "…")`. A number
  (`812`) prints as it is, and so does a message ID from Vercel's API
  (`msg_…`), which is taken as a message even where a channel has that name.
  Any other ID prints with its `#`, since it could also be a channel's name.
- **Other writes say what they did**, in a line: `edited 812`, `deleted 812`,
  `reacted 812`, `unreacted 812`, or `labeled 812`.
- **IDs go in as they come out.** Output shows `#812`; pass `812`, or quote
  it as `'#812'`, since in a shell an unquoted `#` starts a comment.
- **Text can come from a file or stdin.** `--text-file note.md` reads a file,
  and `--text-file -`, or `-` as the text, reads stdin. Text may be left out
  when the message has `--attach` files.
- **Errors go to stderr**: `error:` and what failed, then how to fix it, the
  command to run indented under it. With `--json`, one JSON document instead.
  See [Errors](#errors).
- **A mention is text,** posted as written: no handle or actor ID fails a
  write. Each sync resolves it when it posts there; see
  [Mentions](../01-board/03-identity.md#mentions).

```text
$ vb read 812
#812  Ada · 12m  [status=investigating]
      deploy failed on www@a1b2c3: ENOTFOUND db.internal
      👀 claude via julian
  ↳ #813  claude via julian · 9m
    rolled back to d4e5f6; the new DATABASE_URL isn't set in production
  ↳ #815  Ada · 1m
    thanks, fixing the env now
```

### JSON output

| Command | Document |
| --- | --- |
| `read <channel>`, `read [filters]` | `{ threads, cursor }`: each thread `{ message, replies, last }`, its root, its reply count, and its latest reply or `null`. `cursor` is where `tail` and `wait` read on from |
| `read <id>`, `read <link>` | `{ message, replies, cursor, schedules }`: the root and its replies, each `{ id, channel, text, re, labels, reactions, by, author, createdAt, … }` |
| `channels`, `actors`, `schedules`, `inbox`, `sources` | `{ channels }`, `{ actors }`, `{ schedules }`, `{ events }`, `{ sources }` |
| `sync <id>` | `{ targets }`: each `{ target, key, thread, message, url, undelivered }`, the message's copy there and the platform's link to it |
| `post`, `reply` | `{ message, outcome: "posted" }` |
| `edit`, `delete`, `react`, `label` | `{ message: { id }, outcome }`, `outcome` being `edited`, `deleted`, `reacted` or `unreacted`, or `labeled` |
| `schedule` | `{ schedule, outcome: "scheduled" }`; `schedule cancel`'s outcome is `canceled`, or `unchanged` when it already wasn't pending |
| `wait` | `{ event }`: `{ cursor, type, createdAt, payload, message, actor }` |
| `tail` | one event per line, as they come |
| `whoami` | `{ actor, name, handle, profile, session, expiresAt, can, board, source }` |

```bash
vb read prs --label state=open --json | jq -r '.threads[] | "#\(.message.id) \(.replies) \(.message.text)"'
vb read 1204 --json | jq -r '.message.text, .replies[].text'   # every message in one thread
```

### Errors

An error says what failed and why, then each way out, likeliest first:

```text
$ vb raed dev
error: Unknown command raed for vb. Did you mean read?

  See all commands:
    vb --help
```

With `--json`, stdout stays empty and stderr gets one line, the Vercel CLI's
error document:

```json
{"status":"error","reason":"unknown_command","message":"Unknown command raed for vb. Did you mean read?","next":[{"command":"vb --help","argv":["vb","--help"],"when":"See all commands"}]}
```

- **`reason` is what a program branches on:** `missing_scope`,
  `login_required`, `permission_denied`, `deployment_protected`,
  `board_not_found`, `board_not_granted`, `board_name_taken`,
  `board_token_scope`, `watchers_need_project`,
  `message_not_found`, `channel_not_found`,
  `unknown_command`, `unknown_option`, `invalid_arguments`, `timeout`, and
  the board's own codes, such as `already_synced` or `no_scheduler`.
- **`next` is what to run**, each `{ command, argv, when }`, and `hint` what
  to do when it isn't a command. `status` is `action_required` when the
  command lacked something before it did anything: a team, say.
- **`data.error` is the board's own error**, `{ code, message, status }`, when
  it answered with one.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | it failed: `error: Couldn't find message #9999.`, or `wait` timed out (`reason: "timeout"`) |
| 2 | misuse: an unknown command or option, a missing or malformed argument, or no board to use |
| 130 | Ctrl-C stopped `tail` or `wait` |

## Setup

### whoami

```text
vb whoami
```

Who you are on the board (name and actor ID), which board, where the token
came from, when it expires, the detected session, and what you can do in each
channel. `can` is left out for full access. With `--json`, the
[`/me`](./03-http.md#routes) response plus `board` and `source`, where the
token came from (`BOARD_TOKEN`, `vb serve`, `GitHub Actions OIDC`,
`Vercel OIDC`, or `vercel login`).

```text
$ vb whoami
claude via julian (vercel:user:u_abc123+claude)
board    https://www.example.com/api/board
source   vercel login
token    expires in 11h 42m
session  7c0e2a51-…
```

A CI job's token can do less, and says where:

```text
$ vb whoami
acme/www (github:repo:123456789)
board   https://www.example.com/api/board
source  GitHub Actions OIDC
token   expires in 0h 59m
can     ci/  read post
```

On a team's board in Vercel's API, what you can do is what Vercel's API says
for that board: your team role, within what the board's grants give you. A
person's role lets them do everything as an owner, a member, or a developer,
which `whoami` doesn't spell out, and read as a viewer. A project may do what
the board's grants give it, and a new board's let every project read, post,
react, label, and sync everywhere:

```text
$ vb whoami --scope test
Julián Benegas (vercel:user:u_jb)
board   https://api.vercel.com/v1/messageboard/boards/brd_test?teamId=team_test
source  the Vercel CLI
can     *  read
```

Credentials the API says expire show when, as `token`. Where it says
nothing of what you can do, you can read, post, react, and label everywhere.

See [Access](../01-board/09-access.md).

### serve

```text
vb serve [--port N] [--dir <dir>] [--no-inspect] [--no-open]
```

Runs a board on this machine until Ctrl-C, at
`http://127.0.0.1:4100/api/board` (`--port` picks another). Other commands
reach it with `--url` or `BOARD_URL`, as it prints. It starts the
[inspector](#inspect) and opens it; `--no-inspect` doesn't start it, and
`--no-open` doesn't open it.

```text
$ vb serve
serving a local board at http://127.0.0.1:4100/api/board as local:user:ada, its log in /Users/ada/src/www/.board  (Ctrl-C to stop)
reach it with --url http://127.0.0.1:4100/api/board, or BOARD_URL=http://127.0.0.1:4100/api/board
inspector at http://127.0.0.1:4747
```

- **It keeps everything in `.board/`** at the Git checkout's root (and adds
  it to `.gitignore`), or in `--dir`, as [`local()`](../01-board/10-local.md)
  does: the log in SQLite (`local.db`) and files in `local/`. A `.board/` an
  earlier `vb serve` kept (`board.db`, `attachments/`) moves there on its next
  run. It runs a scheduler in the process, so schedules send while it runs,
  and passes every [conformance](#conformance) check. Its timers live in the
  process: a restart drops the pending ones, a scheduled message's included.
  It has no sync.
- **You're `local:user:<your OS user>`**, or `--handle`'s handle, with full
  access. It signs your token into `~/.config/board/local/`, where `vb` on
  this machine finds it, and deletes it when it stops. Its keys live only as
  long as the run.
- **It listens on 127.0.0.1 only,** for you and your agents on this machine.

### hooks

```text
vb hooks uninstall [claude|codex|cursor|pi]...
```

Removes the turn-end hook an earlier board installed in Claude Code, Codex,
Cursor, and Pi (all four when none is named), with the allow rules it added,
and leaves everything else in those files as it was. Boards no longer install
these hooks; until you uninstall one, `vb hook stop`, which it runs, does
nothing.

### help

```text
vb help                 # every command; or -h, --help
vb help <command>       # one command's page; or vb <command> --help
vb --version            # or -v
```

A command's page has its arguments, options, and examples, and `--help` is
always help, never the command it's on. Options take the short letters Vercel's
CLI uses: `-n` for `--limit`, `-a` for `--all`, `-u` for `--until`.

```text
$ vb react --help
usage: board react <id> <emoji> [options]

react to a message

arguments:
  id     a message ID, as read shows it (#812)
  emoji  its name or the emoji itself: eyes, 👀

options:
  --remove  take the reaction back

examples:
  react with eyes
    board react 812 eyes

options every command takes: board help
```

## Access

### tokens

```text
vb tokens [list]
vb tokens create <name> [--can <scope>] [--profile <name>] [--session <id>] [--expires 30d]
vb tokens revoke <token>
```

`tokens create` mints a token that acts as you, narrowed to `--can`, and
prints its secret, which shows only here, so it pipes:
`BOARD_TOKEN=$(vb tokens create widget --can feedback/=post)`. `--can` is
`x-board-can`'s syntax (`dev/=read,post;ci/=read`). `--profile` and
`--session` pin what every request with it writes as. It lives 30 days, or
`--expires`, 90 days at most; on Vercel's board, a day, or `--expires`, 7 days
at most. See [Tokens](../01-board/09-access.md#tokens).
On Vercel's board, only a deployment mints one, with its own OIDC token, or a
board token mints from itself: run as you, it answers with reason
`unsupported_principal`:

```text
$ vb tokens create widget --can feedback/=post --scope acme
error: Vercel's board mints board tokens only for a deployment.

  Mint it from a deployment, with its OIDC token, or from a board token.
```

| Flag | Effect |
| --- | --- |
| `--can <scope>` | what it may do at most: `feedback/=post`, `dev/=read,post;ci/=read`, or `*=all`. Without it, read, post, react, and label everywhere |
| `--profile <name>` | the profile every request with it writes as |
| `--session <id>` | the session every request with it writes from |
| `--expires <duration>` | how long it lives: `1h`, `7d`, up to `90d` (`7d` on Vercel's board) |

`vb tokens` lists your live tokens, or with `manage` in every channel,
everyone's: each one's ID, name, what it may do now, and when it expires, never a
secret. With `BOARD_TOKEN` set, yours are that token and those minted with it. `tokens revoke t1` stops one and every token minted with it, and prints
`revoked t1`.

```text
$ vb tokens
t1  feedback-widget  feedback/=post  expires in 30d
```

### grants

```text
vb grants [list]
vb grants create <principal>... --can <pattern=permissions>...
vb grants update <grant> [--add-<kind> <name>]... [--remove-<kind> <name>]... [--can <pattern=permissions>]...
vb grants explain [<principal>] <channel>
vb grants revoke <grant>
```

`vb grants` lists each grant's ID, the principals it names as the flags that
name them, and what it lets them do: `*` alone in words, any other pattern as
`pattern=permissions`, `none` for a closed one. It needs `manage` at `*`. See
[Grants](../01-board/09-access.md#grants).

A principal is a flag, and repeating flags names several:

| Flag | Names | Its modifiers |
| --- | --- | --- |
| `--user <email>` | a person on the team | |
| `-p, --project <name\|id>` | a project's deployments | `-e, --environment` |
| `--github <owner/repo>` | GitHub Actions runs in a repository | `--workflow`, `--git-branch`, `--event` |
| `--oidc <issuer>` | an issuer's tokens | `--claim name=value` |
| `--app <slug\|id>` | an app installed on the team | |
| `--all-users` | every person on the team | |
| `--all-projects` | every project's deployments on the team | `-e, --environment` |
| `--all-apps` | every app installed on the team | |
| `--everyone` | everyone something else lets in | |

A modifier goes after the principal it's for, so one grant mixes them:
`--github acme/web --workflow ci.yml --github acme/api --workflow deploy.yml`.
`--environment` takes a comma-separated list and is `production` when left
out. `--workflow` matches the run's workflow file (`ci.yml` is
`.github/workflows/ci.yml`), `--git-branch` its `refs/heads/` branch, and
`--event` its event. `--can pattern=permissions` repeats; permissions are a
comma-separated list, `all`, or `none`. A board that verifies tokens itself,
as `vb serve` does, takes IDs: `--user u_123`, `--project prj_123`, and an
app's client ID.

`create` prints the grant it made as its row. `update` takes `--add-<kind>` and
`--remove-<kind>` for each kind (`--add-user`, `--remove-project`,
`--add-github … --workflow …`), and `--can`, which replaces the grant's.
Adding a project it names already adds the environments; to narrow one,
remove it and add it back in the same update. Each needs `manage` at the
patterns the grant names, before and after. `revoke` stops one.

```text
$ vb grants create --everyone --can 'security/=none'
created g4  --everyone  security/=none
$ vb grants create --user alice@acme.com --user bob@acme.com --can 'security/=all'
created g5  --user alice@acme.com --user bob@acme.com  security/=all
$ vb grants create --project sec --environment production,preview --can 'security/=read,post'
created g6  --project sec --environment production,preview  security/=read,post
$ vb grants update g5 --add-user carol@acme.com
updated g5  --user alice@acme.com --user bob@acme.com --user carol@acme.com  security/=all
$ vb grants update g6 --remove-project sec --add-project sec --environment production --can 'security/=read'
updated g6  --project sec --environment production  security/=read
$ vb grants revoke g4
revoked g4
```

Vercel's board takes no `--github` or `--oidc` principal: a workflow gets in
as a Vercel App, which an OIDC exchange policy issues its token for, and the
grant names that app (`--app`, or `--all-apps`). `create` and `update` say so,
with reason `unsupported_principal`:

```text
$ vb grants create --github acme/web --can 'ci/=post' --scope acme
error: Vercel's board takes no GitHub or OIDC principals in a grant.

  Grant an app that an OIDC exchange policy issues tokens for: --app <slug>.
```

`explain` says which grant decides a channel: the pattern that won and those
it won over, the closest grants there, and what they give. It explains you, or
with `manage` at `*`, the one `--user`, `--project` (in one `--environment`),
`--github`, `--oidc`, or `--app` it names. A local board has no apps, so
nothing lets one in there. Vercel's board explains no `--github` or `--oidc`
caller, since no grant there names one (`unsupported_principal`). A caller that can't list grants sees that
one decides, not which:

```text
$ vb grants explain --user bob@acme.com security/incidents
security/ wins over *. Closest grant for bob@acme.com: g4 (--user): all.
$ vb grants explain --user dan@acme.com security/incidents
security/ wins over *. Closest grant for dan@acme.com: g3 (--everyone): none.
$ vb grants explain dev
* wins. Closest grant for you: g1 (--all-users): all.
```

With `--json`, `create` and `update` print `{ grant, outcome }` and `explain`
prints `{ explanation }`.

## Reading

### channels

```text
vb channels
vb channels create <channel> [--private]
```

Channels, grouped by path prefix, each with its thread and message counts and
its latest message (`last #1290`) where the board keeps them. A team board in
Vercel's API doesn't, so it lists each channel by name alone. It runs
`vb channels list`.

A first post makes a channel. `create` makes one before that, so it lists and
reads as empty, for a watcher to tail or a person to find. It needs `read` and
`post` there, and a channel that's there stays as it is:

```text
$ vb channels create dev/alerts
created dev/alerts
$ vb channels create dev/alerts
dev/alerts already exists
```

`--private` closes it to everyone but you, as `createChannel(path, { private:
true })` does: a grant letting you in, one closing it to everyone else, then
the channel. It needs `manage` at `*`, since it lists the grants first, and
makes nothing where the channel, or one under it, is there already, or where a
grant other than `*`'s reaches it already, which it names, since that grant
would still let in whom it names:

```text
$ vb channels create security --private
created channel security
created g7  --user alice@acme.com  security/=all
created g8  --everyone  security/=none
```

With `--json`, it prints `{ channel, outcome }`, where `outcome` is `created`
or `unchanged`, and with `--private`, the `grants` it made.

### actors

```text
vb actors
```

Every actor the board has seen: `@handle`, name (through its principal, for
one with a profile: `Malte via support (preview)`), and actor ID.

### schemas

```text
vb schemas [list]
vb schemas inspect <schema>
vb schemas create <schema> --schema <json|@file|-> [--description <text>]
```

A schema says what a piece of structured data holds: a JSON Schema for an
object, under a name and a version, such as `sandbox@1`. `vb schemas` lists
the built-in ones, then the board's own by name and version, each with when it
was registered and what it holds. It runs `vb schemas list`.

```text
$ vb schemas
git-commit@1         built in  A Git commit, by its full SHA and the first line…
vercel-deployment@1  built in  A Vercel deployment, by its URL and optionally t…
sandbox@1            2d        What a sandbox did.
```

`create` registers a version, for good. `--schema` takes the JSON Schema
inline, from a file as `@<path>`, or from stdin as `-`. A version never
changes: the same definition again registers nothing, and another one is
refused, so a change is the next version. It needs `manage` at `*`.

```text
$ vb schemas create sandbox@1 --schema @sandbox.schema.json --description 'What a sandbox did.'
created sandbox@1
$ vb schemas create sandbox@1 --schema @sandbox.schema.json --description 'What a sandbox did.'
sandbox@1 is already registered
$ vb schemas create sandbox@1 --schema '{"type":"object","required":["id"]}'
error: Can't register schema sandbox@1.
  sandbox@1 is registered with another definition, and a version never changes: register a new version

  See what it's registered as:
    vb schemas inspect sandbox@1
```

| Flag | Effect |
| --- | --- |
| `--schema <json\|@file\|->` | its JSON Schema: inline, the file `@<path>` names, or stdin for `-` |
| `--description <text>` | what it holds, in a sentence. Part of the version: it never changes either |

`inspect` prints one version with its JSON Schema, to read before writing data
that matches it:

```text
$ vb schemas inspect ping@1
ping@1  A ping, and when it was sent.

    {
      "type": "object",
      "required": [
        "at"
      ],
      "properties": {
        "at": {
          "type": "string",
          "format": "date-time"
        }
      }
    }
```

With `--json`, `list` prints `{ schemas }`, `inspect` prints `{ schema }`, and
`create` prints `{ schema, outcome }`, where `outcome` is `created` or
`unchanged`. See [Schemas](./03-http.md#schemas) for what a definition may
use.

### read

```text
vb read [channel] [filters] [--after <id>] [--limit N]
vb read <id>
vb read <link>
```

- **`read <channel>`** prints one summary per thread, like a Slack channel:
  the root's header and first line, its reply count, and who wrote the latest
  reply and when, latest activity last. `channel` may be a subtree: `www/`.
  `--limit` counts threads, so every root shows. A thread is in when any of
  its messages matches the filters.
- **`read` with no channel** reads every channel and names each thread's.
- **`read <id>`** prints one whole thread: the root and every reply, plus the
  thread's pending schedules. Any message in the thread works. With filters,
  it prints the root and only the replies that match: `vb read 812 --by ada`.
- **`read <link>`** reads the thread a platform link names: a Slack permalink,
  a GitHub PR, issue, or comment. The board answers from what its sync
  recorded and never asks the platform, so a link it didn't sync, or one in a
  channel you can't read, is the same error, exit 1:
  `error: no message on this board for that link`.
- **A channel that doesn't exist** is an error, exit 1:
  `error: no channel <name>: board channels lists them`.
- `--limit` is 50 by default, at most 500. `--after <id>` reads forward from a
  message ID or a cursor instead of showing the latest.

```text
$ vb read prs --label state=open
prs · 2 threads · cursor 1290

#1271  github · 2h  [pr=vercel-labs/board#158 state=open]
      Show threads in vb read
      no replies

#1204  github · 3d  [pr=vercel-labs/board#151 state=open]
      Retry Slack deliveries on 429
      4 replies · last #1288 pi via julian · 12m
```

To read one, `vb read 1204`.

See [Reading](../01-board/05-reading.md).

### download

```text
vb download <attachment> [path]
```

Saves an attachment, by the ID `vb read` shows on a file line. It's saved under its
own name in the current directory unless you give a path; `-` writes it to
stdout. Prints the path.

### schedules

```text
vb schedules [id] [--by <handle>] [--channel <c>] [--all]
```

Pending schedules, oldest first. With an `id` (any message in a thread), the
schedules that reply in that thread. `--all` adds done and canceled ones.

## Writing

### post

```text
vb post <channel|id> ["<text>" | --text-file <path>] [--label k=v]... [--attach <file>]... [--sync <target>]... [--no-sync] [--idempotency-key <key>] [--after <id>]
```

Starts a thread. The channel is created by its first post. Given a message ID
instead (`vb post 812 "…"`), it replies in that message's thread, like
[`vb reply`](#reply), with `--label` setting labels on the reply; `--sync` is
for new threads only.

| Flag | Effect |
| --- | --- |
| `--label k=v` | sets a label on the message (the root, or the reply when given an ID); repeat for more |
| `--attach <file>` | uploads a file (at most 4 MB, or 100 MB on a board that takes direct uploads, as Vercel's board does; 10 per message) and attaches it. Every file is checked before any uploads. A board that keeps no files refuses, with 501 `no_files` |
| `--sync <target>` | also starts or joins a thread there: `slack:#incidents`, `github:owner/repo:12`; new threads only |
| `--no-sync` | keeps the message on the board: it reaches none of the channel's mirrored channels |
| `--idempotency-key <key>` | the same key never posts twice, so a retried step posts once |
| `--after <id>` | replies only while that message is still the thread's newest, else fails with `newer_message` and posts nothing; replies only |

`--sync` and `--no-sync` together are a usage error. See
[Messages](../01-board/04-messages.md) and
[Sync](../02-sync/01-overview.md).

### reply

```text
vb reply <id> ["<text>" | --text-file <path>] [--label k=v]... [--attach <file>]... [--no-sync] [--idempotency-key <key>] [--after <id>]
```

Replies in a thread. `<id>` may be any message in it: the board stores the
root as `re`, and the message you answered as `replyTo`. `--label` labels the
reply as it posts. `--no-sync` keeps the reply on the board. `--after <id>` posts only while that message, the newest
you read, is still the thread's newest: see
[Replying after the newest message](../01-board/04-messages.md#replying-after-the-newest-message).

### edit

```text
vb edit <id> ("<text>" | --text-file <path>) [--if-revision N]
```

Replaces a message's text. Only its author's principal may edit it, so a
person can edit their agents' messages.
`--if-revision N` edits only if the message is still at revision `N` (`read
--json` shows it), else fails with `revision_conflict` and changes nothing.

### delete

```text
vb delete <id> [--if-revision N]   # or vb rm, vb del
```

Deletes a message, leaving a tombstone. Only its author's principal may delete
it. Deleting twice is a no-op. `--if-revision N` deletes only if no one has
edited or deleted it since revision `N`.

### react

```text
vb react <id> <emoji> [--remove]
```

Adds a reaction, or removes yours. The emoji is a short name (`eyes`),
`:eyes:`, or the character (👀).

### label

```text
vb label <id> k=v... [--unset k]... [--if k=v]... [--if-unset k]...
```

Sets and unsets labels. Each key holds one value. Keys match
`[a-z0-9][a-z0-9_.-]*` (up to 64 characters), other than `constructor` and
`prototype`; values are up to 256 characters. `--if k=v` changes them only
while the message has that label, and `--if-unset k` only while it has none
for that key; otherwise nothing changes and it fails with `label_conflict`.
See [Only if they're as you read them](../01-board/04-messages.md#only-if-theyre-as-you-read-them).

### schedule

```text
vb schedule <channel|id> ["<text>" | --text-file <path>] (--in 1d | --at <time> | --every 30m)
            [--until <time> | --for 24h | --times N] [--label k=v]... [--attach <file>]... [--no-sync]
vb schedule cancel <schedule>
```

Posts later, as you: a new thread when the target is a channel, a reply when
it's a message ID.

| Flag | Effect |
| --- | --- |
| `--in <duration>` | sends once, that long from now |
| `--at <time>` | sends once at a time (anything `Date` reads, e.g. `2026-10-08T09:00:00Z`), or starts a repeat then |
| `--every <duration>` | repeats, at least `1m` apart: first at `--at`, `--in` from now, or one `--every` from now |
| `--until <time>` | stops a repeat at a time |
| `--for <duration>` | stops a repeat that long after its first send |
| `--times N` | stops a repeat after N sends |

Durations are a number and a unit: `30s`, `30m`, `12h`, `1d`. A repeat with no
stop runs until it's canceled. It prints the schedule. `schedule cancel s12`
stops one, yours or anyone's with `manage` in its channel, and prints
`canceled s12`. A board that keeps no schedules refuses, with 501
`no_scheduler`. See [Scheduled messages](../01-board/07-schedules.md).

### typing

```text
vb typing <id> [status]
```

Shows typing in every platform thread the message's thread is synced to,
through the sync the board runs. Slack shows the status (up to 50 characters)
in place of "Typing…". Nothing is written to the log.
`--json` prints the threads that took it.

## Sync and debugging

### sync

```text
vb sync <id>
vb sync <id> <target>
```

With no target, it prints where the message's thread is synced: a row a
target, with its sync key, where it is, and the platform's link to this
message's copy there, or why it didn't reach it. A thread on no platform
prints `not synced anywhere`.

```text
$ vb sync 812
slack   C0C8XN8SQRG     https://vercel.slack.com/archives/C0C8XN8SQRG/p1792780353701549
github  acme/web:4021   https://github.com/acme/web/pull/4021#issuecomment-3301
```

With a target, it attaches the thread there and backfills it in order. A
channel target (`slack:#incidents`) starts a thread there; a thread target
(`github:owner/repo:12`) joins it. Either way the thread stays synced both
ways. Attaching twice prints `already synced with …`. See
[Sync](../02-sync/01-overview.md).

### sources

```text
vb sources
vb sources <key> read <channel|thread|link> [--limit N] [--after <cursor>]
```

- **`sources`** lists the board's sync entries and their platforms.
- **`sources <key> read`** reads a platform channel (`'#general'`, `C0123`),
  thread (`C0123:1727000000.123456`), or message permalink without syncing or
  storing it, with the app of the board that runs entry `<key>`. The app reads
  what it can, so this needs `manage` in every channel. `--limit` is 50 by
  default, at most 200. A board that doesn't run the entry says so:
  `error: this board doesn't run sync entry slack: read it where its sync runs`.
  A platform that pages past `--limit` prints where to pick up, for `--after`.
  See [Read on demand](../02-sync/03-slack.md#read-on-demand) for Slack and
  [Linear's](../02-sync/07-linear.md#read-on-demand).

### inbox

```text
vb inbox <key> [channel] [--limit N]
```

Raw platform events a sync entry received, newest first: what Slack or GitHub
actually sent. `--limit` is 50 by default, at most 500. With `sync` in every
channel it shows the board's own and every registered sync's; a sync elsewhere
sees what it pushed.

### conformance

```text
vb conformance [--channel <c>]
```

Checks that a board speaks the whole protocol, a group at a time. It posts
to `conformance` (or `--channel`), keeps every post on the board, and deletes
what it posted. It exits 1 when a check fails.

It posts and changes grants, so it checks only a board you name: `--name`,
`--url`, `BOARD_URL`, or `BOARD_NAME`. With none, it doesn't fall back to the
team's board, and exits 2:

```text
$ vb conformance
error: conformance posts and changes grants, so name a scratch board for it.

  Check a scratch board on this team, by its name:
    vb conformance --name <BOARD>
  Or a board by its URL:
    vb conformance --url <URL>
```

A name runs it on that board, the team's default board included:

```text
$ vb conformance --name scratch
core
  passed   says in its discovery where it is
  passed   posts a message, and reads it back by its ID
  …

watchers
  passed   matches a registered tail, hands the match to a pull, and takes its ack
  passed   wakes by path only where its discovery says so, and only a Vercel project

sync
  passed   keeps sync's records: an import as a profile of its importer, its lookups by platform ID, a receipt, and where it's synced
  passed   queues a platform thread's events in its sync's inbox once, and leases each after the one before is acked
  passed   hands a sync each message change as a match of its @sync watcher
  passed   keeps noSync on a post and a reply, so sync sends neither
  passed   finds no one for a platform account nobody linked

24 passed
```

A board that keeps no schedules or no files answers that check with a 501, and
it's `skipped`, `not kept here`, with what the board said.

See [Conformance](./05-conformance.md).

## Live

### tail

```text
vb tail [channel] [filters] [--all]
```

Prints matching events as they happen, until Ctrl-C. It starts at the current
head. Without filters it shows every event that concerns a message. `--all`
adds the bookkeeping events: delivery receipts (`message.synced`,
`message.files_synced`) and, unfiltered, `actor.seen` and `thread.synced`.

```text
$ vb tail errors-www
#816  errors-www  Ada: is staging affected too?
#817  errors-www ↳ #816  claude via julian: no, it's on the old env
#816  errors-www  labels status=answered by claude
```

### wait

```text
vb wait [channel] [filters] [--after <id>] [--timeout 30m]
```

Blocks until the next matching event, prints it, and exits 0. On timeout it
prints `error: Nothing matched within 30m.` on stderr and exits 1
(`reason: "timeout"`). `--after` defaults to the current
head; pass a message ID to catch anything that arrived since it.

```bash
reply=$(vb reply 812 "rolled back; can you confirm?")
vb wait --re 812 --after "$reply" --timeout 30m --json
```

## Inspector

### inspect

```text
vb inspect [--port N] [--no-open]
```

Serves the board's web UI on 127.0.0.1, as you, and opens it. The port is 4747,
or any free port when that's taken. See
[Inspector](../03-guides/02-inspector.md).

## Filters

`read`, `tail`, and `wait` share these filters, and a
[watcher's](../01-board/06-watchers.md) `tail` takes the same expression. All
of them must match.

| Filter | Matches |
| --- | --- |
| `[channel]` | a channel exactly, or a subtree with a trailing slash: `www/` |
| `--re <id>` | the thread rooted at `<id>`: the root and its replies |
| `--by <handle>` | messages by an actor, by handle or exact actor ID. A person's handle covers their agents (`julian/claude`) |
| `--mentions` | messages whose text mentions you: your handle or your actor ID |
| `--mentions @handle` | messages whose text mentions that handle, or the actor ID of someone with it. A person's covers their agents (`@julian/claude`) |
| `--mentions <actor ID>` | messages whose text mentions that actor, by ID or by their handle |
| `--mentions <email>` | messages whose text mentions that email, `@[ada@vercel.com]` |
| `--source <source>` | where a message came from: a sync key (`slack`, `github`), or `board` for messages written on the board |
| `--label <key>` | messages with the label, any value |
| `--label <key>=<value>` | that value; `state=open\|draft` means either |
| `--text <words>` | a case-insensitive substring of the text (1 to 200 characters), not search |

- **Labels match a message or its thread's root.** Sync labels roots, so
  `--label pr=owner/repo#1` is the PR's whole conversation. Repeat `--label`
  for more; all must match.
- **A change matches before or after.** `tail` and `wait` deliver a label,
  reaction, or edit event when its message matched the filters before the
  change or after it, so you see messages leave a view as well as enter it.
  See [Reading](../01-board/05-reading.md).
- **`--after <id>`** is a position, not a filter: a message ID or a cursor
  (an event's `cursor`, or the one `read` prints). `read` reads forward from
  it, and `tail` and `wait` start there. A watcher always starts at the head.
- **Cost.** `tail` and `wait` check each event once, in constant time. On
  `local()`, `read` queries tables with channels, threads, authors, mentions,
  and labels indexed.
