# vboard

## 0.50.0

### Minor Changes

- a291439: `createApp()` in `@vercel/board/cli` takes `token`: a Vercel token someone passed for one run, as `vercel board --token` takes one. It's that run's login, ahead of everything the environment holds, a deployment's own OIDC token and `BOARD_TOKEN` included, so the run writes as the token's owner wherever it runs. Board sends it itself, as a Bearer token, never through the app's `fetch`, and a board at a URL gets a token minted with it, never the token itself. `whoami` names it as its source, `the token you passed`, and a refused one says to pass one the board accepts. A token in the environment still never goes ahead of a deployment's own.
- a83fac6: `sandboxPolicy()` returns the sandbox's `env` beside `allow`: `BOARD_URL`, the board's URL, and `BOARD_TOKEN`, the placeholder the policy replaces with the credential. `Sandbox.create({ networkPolicy: { allow }, env })` takes both, so a caller no longer reads the URL from `discovery()` or writes the placeholder itself.

### Patch Changes

- 65ffcb2: Inspector: a post you send no longer disappears for a moment between "sending…" and the board's answer, and a run of threads one author starts close together shows their name and avatar once, the way Slack does.
- 8486cf8: A thread posted with `noSync` stays on the board even once it's synced: its root isn't backfilled to a channel and its replies don't go to a platform thread. A platform thread is one board thread's: two threads that ask for it at once get one 200 and one 409 `already_synced`, and a second claim already in a log is ignored. A label value a write sets can't hold a control character (400), and `vb read` shows one already stored as its picture on the message's line. `@handle` settles on the board's own actor over a synced platform user who goes by the same handle, wherever that user wrote.

## 0.49.0

### Minor Changes

- e4b51e0: **Breaking:** what a `vb` command takes from a file is `--file <path>`, with `-` for stdin, the name the Vercel CLI gives it.
  
  - `--text-file` is `--file` on `post`, `reply`, `edit`, and `schedule`.
  - `tasks create --tasks-file` is `tasks create --file`. One task's text from a file comes on stdin, with `-` as the text.
  - `schemas create --schema` is `--file` for a file, without the `@`, or stdin, and `--data` for JSON written inline.
  
  The old names are refused, and say the new one:
  
  ```text
  $ vb post dev --text-file note.md
  error: --text-file is --file now.
  
    Run it with --file:
      vb post dev --file note.md
  ```
- a22e79b: **Breaking:** a grant change you couldn't take back is refused. Closing a channel to `everyone` closes it to whoever closes it, and lifting that takes `manage` there, so a write that takes its caller's own `manage` at a pattern it names is 409 `grant_lockout` and makes nothing. Revoking or narrowing the grant that keeps you in is the same. Keep yourself in with a grant in the same write, or say to go ahead: `--lock-me-out`, or `{ lockMeOut: true }` on `createGrant`, `updateGrant`, and `revokeGrant`. Owners are never locked out.
  
  `createGrants([…])` (`POST /grants/batch`) makes up to 16 grants in one write, all or none, judged together, so a lock goes with the grant that keeps its maker in, in either order. `vb grants create --file <path>` makes the grants a JSON file holds, `-` for stdin:
  
  ```text
  $ vb grants create --file grants.json
  created g6  --everyone  security/=none
  created g7  --user u_julian  security/=all
  ```
  
  A backend of your own that keeps grants passes `then` to `checkGrantChange` to judge a lockout, and the conformance kit's `grants` group checks both. On Vercel's board, `--lock-me-out` and several grants in one command wait for its API.
- 805f0a8: `@vercel/board/inspect` serves the inspector from a route in your app: `inspector({ board, basePath })` answers the page, its bundle, and its proxy as a `(Request) => Response` handler, acting as that handle under the profile the page picks.

### Patch Changes

- 59a4f78: On Vercel's board, a read of one channel (`vb read <channel>`, `vb wait <channel>`, `vb threads <channel>`, `vb schedules --channel`) names the channel to the API by the name you gave, and a message comes with its channel, so neither asks for the channel first: one request fewer for each. An API that doesn't take the name yet is asked once in a process, then the channel is looked up as before.
- 2d2a68a: Reads on Vercel's board name their authors from the read itself where Vercel's API answers a read with its actors (`with=actors`), so `vb read`, `vb threads`, `vb thread`, and `vb tail` make no request for actors. An API that refuses the parameter is read as before, after one refused request per process.
- c90cb25: Say each limit where an agent meets it. A refused label key or value names it and states the rule (`set: "Verdict" isn't a label key: one is 1 to 64 lowercase letters, …`). A command Vercel's API still rate-limits after its retries says the limit is per login or token, shared by its agents and profiles, and how long to wait, from the API's window: `Wait 45s, then run it again`, with `retryAfter` in `--json`'s data. A 429 carries `Retry-After` through `board()`. `vb read <channel>` says when it left older threads out and how to see them, and after `--after`, reads on with `more since then: … --after <id>` (with a filter on messages, the same cursor and a bigger `--limit`) instead of a cursor past the threads it left out. `--json` is the board's page as it answered. `--attach` help gives the file size, `read --limit` its maximum, and a file too big for a board without direct uploads fails as a limit. The board skill has a Limits section.
- e7ec541: `vb schedules --by me` on Vercel's board asks the API for the caller's own schedules, and no longer pages through everyone's to find them.
- 0def9c4: Slack sync: a mention of a Slack app's bot goes out as its name, not as `<@B…>`, which Slack can't render for a bot's ID.
- ef825eb: Reads of threads on Vercel's board ask the API for up to 100 threads a page (`limit`), where they took 25: `vb read` of a long channel, a read filtered by a label or by what messages say, and `vb read` across channels make a quarter of the requests, and `vb read -n 5` asks for 5. An API that refuses the parameter is read as before, after one refused request per process.

## 0.48.1

### Patch Changes

- b362cf2: Vercel for GitHub's deployment comment shows as its deployments in Slack and `vb read` on a board where an import is by a profile of the syncing deployment, as on Vercel's board, not as its raw table.

## 0.48.0

### Minor Changes

- 1861f0e: Slack gets its own mention for `@[slack:user:U0456]` even before the board has met that user: an agent that knows someone's Slack ID can ping them. Only a user's ID becomes a mention, and only from the sync whose key it's under; on GitHub, which mentions by login, it goes as written. A provider says so with `mentionById(id)`. `vb sources <key> read` shows a Slack mention the way an import brings one in, `@[slack:user:U0456]` under the entry's key, where it showed `@U0456`.

### Patch Changes

- c34d821: The inspector no longer zooms in on iOS when a field takes focus: on a touch device every field's text is 16px. A desktop keeps its sizes.

## 0.47.0

### Minor Changes

- 8e8f63d: Breaking: Vercel's board never sends `VERCEL_TOKEN`. A deployment always sends its own OIDC token, so a `VERCEL_TOKEN` someone set for another reason no longer turns it into a person and stops its watchers and sync. Off a deployment it sends `BOARD_TOKEN`, or else your login: where you set `VERCEL_TOKEN` for `vb` or `board()`, in CI or a sandbox, set `BOARD_TOKEN` instead.
- d73187c: A mention on Slack comes in as a mention. `<@U0456>` is `@[slack:user:U0456]` on the board, not `@` and a display name, and the board meets that user by the names Slack gives them, though they never wrote: `@malte` in a reply finds them, and Slack gets its own mention back. Custom providers do the same with `mentioned` on a `message` or `edited` event, and `syncImport` takes it on a post or an edit; the conformance kit's `sync` group checks that a backend meets them. An import whose mentions would outgrow a message once named under their project stays as it came, not refused.
- ee79fe0: **Breaking:** a mention is `@[actor-id]`, settled when a message is written. board turns an `@handle` in a post, reply, edit, schedule, or task into `@[actor-id]` when exactly one actor the writer can see has that handle, in full; of several who have it, the one who wrote in the thread. The write's answer says what became of each handle, in `mentions`, and the CLI prints it:
  
  ```text
  $ vb reply 2 "over to @julian/claude, cc @nobody"
  5
  mentioned  claude  @julian/claude
  warning: @nobody names no one here: it stays text, and mentions no one.
  ```
  
  A handle that names no one, or several, stays text and mentions no one; no write fails over one. Sync no longer reads an `@handle` as a mention when it posts: it delivers `@[actor-id]` natively to its own platform user and as their name to anyone else, so `@malte` no longer reaches each sync's own Malte, and a client from before this that writes `@handle` mentions no one on a board synced by this version. Write `@[actor-id]`, or the handle in full (`@support/malte`). `vb read` shows a stored mention as the handle to type for them, and the inspector as their name.
- f245e5b: `vb serve --allow-host <host>` lets a local board answer behind a proxy that serves it on another name, such as a tailnet host. A request for that host reaches the board at that host's URL, which its discovery answers and a token there is minted for, and the inspector it starts answers the host too. Your own token stays for the board's `127.0.0.1` URL.
- dc42f70: `vb serve` serves the inspector on the board's own port, at `http://127.0.0.1:4100`, instead of a second one. One address opens both, and with `--allow-host`, one name behind a proxy reaches the board and its page.
- 26c6629: `vb serve --tailscale <host>` shares a local board on your tailnet, behind `tailscale serve`: whoever Tailscale says is calling is a person on the board, `tailscale:user:<login>`, with no token to hand out, and the page at that host acts as whoever opens it. A grant on such a board names a person by their login (`vb grants create --user ada@example.com`). `vb` and a handle in Node now send a request with no token to a board whose discovery names no Vercel project, instead of failing before it: a board that names its callers another way takes it, and any other answers 401, which they report as `no_project`.

### Patch Changes

- 29651d7: Sync mentions a GitHub user by their login. On Vercel's board, where a project's sync imports them as `<project>/<login>`, GitHub was sent that handle (`@support/ada`), which it reads as a team, not as her.
- a77137d: Slack gets a mention no one resolved as its author wrote it: `@vercel/board` and a handle nobody has stay text, where they went out as `<@vercel>/board`. Board alone resolves mentions, so the Slack adapter no longer pings someone by display name for a name board left alone. On Vercel's board, a caller the API names no one for reads a platform user by their actor ID, not by a handle made up from it, and never by a name another caller read.

## 0.46.0

### Minor Changes

- cfc6944: `vb inspect` shows more of the board. A message's blocks render as cards: the schema's name and version, its fields, and the JSON on demand. Settings, at the foot of the sidebar, has a tab per section at `/settings/<section>`: access (your permissions, the grants, a form that makes one, and the board's answer to who decides a channel), schemas (the registry, and a form that registers a version), schedules, watchers, and sync, where each sync entry's raw inbox now lives (`/inbox/<key>` still opens it). The composer sends a message later, a thread's pane shows where it's synced and what's scheduled to reply in it, and the plus beside the channel list makes a channel, private if you say so. A root always shows who started it and when; replies still group. The top of the sidebar and the tab's title say which board it is: a team's board in Vercel's API by its name over its host, any other by its host over where it's mounted.
  
  The page writes as `team.as(profile)` does anywhere: the inspector's proxy reads the board's own `x-board-profile` from the page, not `x-inspect-profile`, which it no longer takes. Nothing but the page talks to that proxy.
  
  A new guide, Build a UI (`docs/03-guides/07-build-a-ui.md` in the package), teaches a page of your own on `board()` from the inspector's code, and its samples are checked against the source.
- 2fe2670: `vb inspect` works tasks. A root that's a task wears one more line (its state, who holds it and how long is left, who it's for, what it waits for, how it ended), a Tasks view lists the queue oldest first at `/tasks`, by state, channel, label, owner, and who they're for, and a thread's pane offers what you can do to its task now: claim it; with your claim, complete or release it, or renew, fail, or block it; as its owner or with `manage` there, block, unblock, reopen, assign, or cancel. The composer starts a thread as a task, and any thread is made one from its pane. A claim's token stays in the tab's memory, so a reload gives the claim up. The Build a UI guide gains a tasks section.
- 4069b9e: Four things a UI on a handle needed. `team.events(query, { onState })` says whether the feed is connected: `onState` is called with `'live'` when the board answers a request for events, and `'retrying'` when one fails and the handle backs off, each change once. The first request, and the first after a failure, ask without waiting, so it's live as soon as the board answers. `@vercel/board/access` exports the permission names as a value, `PERMISSIONS`, beside the `Permission` type. And the root exports `ExplainPrincipal`, the type of the principal `team.explain` asks about, with `EventsOptions` and `EventsState`. And `team.discovery()` says the `name` of a team's board in Vercel's API (`General`, the default's), so a UI can show which board it's on.
  
  ```ts
  import { board, type EventsState, type ExplainPrincipal } from '@vercel/board'
  import { PERMISSIONS } from '@vercel/board/access'
  
  const team = board()
  let feed: EventsState = 'retrying'
  for await (const event of team.events({ all: true }, { onState: (state) => (feed = state) })) {
    // render(event, feed)
  }
  
  const whom: ExplainPrincipal = { user: 'ada@acme.com' }
  const { can } = await team.explain('ci/deploys', whom)
  ```
- 73f1b07: Several tasks in one write: `team.tasks.createMany(channel, tasks, { id? })` starts a thread for each task, all of them or none, on `local()` and on Vercel's board. Nothing of the batch shows before all of it has landed.
  
  ```ts
  import { board } from '@vercel/board'
  
  const team = board()
  
  const [fix, review] = await team.tasks.createMany(
    'work',
    [
      { key: 'fix', text: 'fix CVE-123 in acme/web', labels: { step: 'fix' } },
      { text: 'review the fix', labels: { step: 'review' }, needs: [{ key: 'fix' }] },
    ],
    { id: 'cve-123' },
  )
  // fix is ready, and review waits for it: review.task.needs is [fix.id]
  ```
  
  A task is what `tasks.create` starts a thread with, less `claim` and `id`. A task's `key` names it for the others of the call, and `needs` takes a task's ID or `{ key }`, for a task before it or after it. A `key` two tasks have, one no task has, and tasks that wait for each other answer 400 `invalid_needs`. The same `id` again, with the same channel and tasks, answers the tasks the first call made, before the middleware sees it, and with anything else it answers 409 `duplicate_id`.
  
  A batch makes 100 tasks at most, and a board that holds fewer in one write says so the same way, with 400 `batch_too_large` and nothing made. `local()` holds all 100. Vercel's board holds what fits one of the API's writes: 15 plain tasks, or 14 with an `id`, fewer with labels, files, or needs, and 64 KB of request, which six tasks of 10,000 characters fill.
  
  `createTasksInChunks(team, channel, tasks, { id? })` makes a longer plan with as many `createMany` calls as it takes: each task after the ones it waits for, smaller batches when a board answers `batch_too_large`, and each batch under an ID made from yours, so the same call again makes only what's missing. A plan that stopped can be fixed in what it hadn't made and finished under the same `id`; what it made can't change, and a plan that finished takes no more tasks (409 `duplicate_id`).
  
  ```ts
  import { board, createTasksInChunks, TasksInChunksError, type TaskInBatch } from '@vercel/board'
  
  const team = board()
  const plan: TaskInBatch[] = Array.from({ length: 400 }, (_, n) => ({
    key: `shard-${n}`,
    text: `migrate shard ${n}`,
    ...(n > 0 ? { needs: [{ key: `shard-${n - 1}` }] } : {}),
  }))
  try {
    const tasks = await createTasksInChunks(team, 'work', plan, { id: 'migration-7' })
  } catch (error) {
    if (!(error instanceof TasksInChunksError)) throw error
    // What the batches before the one that failed made, each at its task's place in `plan`.
    console.log(error.code, error.created.filter(Boolean).length)
  }
  ```
  
  `vb tasks create <channel> --tasks-file <path>` makes a plan from a JSON array of those tasks, or from stdin for `-`, through `createTasksInChunks`, so a plan of any length works. It prints a row per task, as `vb tasks` lists them, and one document with `--json`. `--idempotency-key` names the plan, and without one the run makes its own, so a plan that stops midway says what it made and the command that makes the rest:
  
  ```text
  $ vb tasks create work --tasks-file plan.json --idempotency-key cve-123
  #2  ready      fix CVE-123 in acme/web         step=fix
  #4  waiting    review the fix for CVE-123      step=review  needs #2
  #6  waiting    ship it                         needs #4 #2
  $ vb tasks create migration --tasks-file shards.json
  error: Can't create tasks in migration. A task's needs are tasks you can read, or keys of the plan's own.
    needs: #999999 isn't a task
    made 100 of 250: #214 to #412
  
    Make the rest, under the same key: what was made stays as it is:
      vb tasks create migration --tasks-file shards.json --idempotency-key d2bee830-84e4-44d2-aec1-5b1fefbbed82
  ```
  
  A key a task doesn't take is misuse, before anything is made: `Unknown key "need" on task 2 of plan.json. Did you mean "needs"?`. So is a need that's neither a task's ID nor `{ "key": … }`.
  
  A plan in several writes isn't one write: a ready task of an earlier batch can be claimed before a later batch lands. A plan that must not start early waits for a task of your own, which you complete once it returns.
  
  A backend of your own implements `createTasks` and `createdTasks` (`GET /tasks/batch/:id`, the batch made under an `id`) or answers 501 `no_tasks`, and `vb conformance` checks it in the `tasks` group. The middleware sees each task's root as a post, before any is written. A sandbox's policy on Vercel's board allows the call.
- 34f709b: What a task needs can change: `team.tasks.needs(id, needs)` replaces the tasks it waits for, on `local()` and on Vercel's board.
  
  ```ts
  import { board } from '@vercel/board'
  
  const team = board()
  const { task: fix } = await team.tasks.create('work', { text: 'fix CVE-123 in acme/web' })
  const { task: review } = await team.tasks.create('work', { text: 'review the fix' })
  
  await team.tasks.needs(review.id, [fix.id]) // it waits for the fix now
  await team.tasks.needs(review.id, [])       // and for nothing: it's ready
  ```
  
  It's for the task's owner, or `manage` in its channel, while the task is waiting, ready, or held for a person. A task someone has claimed answers 409 `task_claimed`, and a finished one 409 `task_finished`. The new ones are checked as a new task's are, and one that would make the task wait for itself, through however many tasks, answers 400 `invalid_needs`. The board looks behind the tasks a change adds, 500 at most, and follows no completed task's needs, so finished work behind a prerequisite doesn't count toward that. Behind a completed task the caller can't read, it looks as behind any other, so whether a change is refused as too many to check says nothing about that task. It waits for them in that write (`task.needs_changed`), and is ready in it when they've all completed.
  
  A backend of your own implements `setTaskNeeds`, and `vb conformance` checks it in the `tasks` group.
  
  `vb tasks needs <id> <id>...` does it from the CLI, and `--none` makes a task wait for nothing. One of the two is required, so a command cut short changes nothing:
  
  ```text
  $ vb tasks needs 814 812 813
  814 needs #812 #813
  $ vb tasks needs 814 --none
  814 needs nothing
  $ vb tasks needs 814
  error: Missing the tasks it waits for now, by ID, or --none for nothing.
  
    See how to use it:
      vb tasks --help
  ```
  
  `vb tail` and `vb wait` print the change as they print a task's others: `#814  work  task needs #812 #813 by julian`, or `task needs nothing by julian`.
- 2c79b86: Tasks, on `local()` and `vb serve`: a thread someone's agents are to do, with a state the board keeps. `team.tasks.create` starts a thread as a task or makes one of a thread that's there, and `team.tasks.claim` claims one by ID, or the oldest ready one in a channel or subtree that has the labels you ask for, waiting for one if you say so. A claim is a lease: it answers `{ task, epoch, token, until }` with `renew`, `release`, `complete`, `fail`, and `block`, and once it's over each of those throws a 409 `claim_lost` and changes nothing, so an agent that stalls past its lease can't settle a task another has taken. A task can wait for others (`needs`), be assigned to one of its owner's profiles (`for`), and be held for a person. Its state is its root's `board.task` label, so `vb read work --label board.task=ready`, `vb tail`, `vb wait`, and watchers find tasks as they find anything, and `task.*` events reach the feed. `vb tasks` comes next.
  
  ```ts
  import { board } from '@vercel/board'
  
  const team = board()
  const { task: fix } = await team.tasks.create('work', { text: 'fix CVE-123 in acme/web', labels: { step: 'fix' } })
  await team.tasks.create('work', { text: 'review the fix for CVE-123', labels: { step: 'review' }, needs: [fix.id] })
  
  const claim = await team.tasks.claim({ channel: 'work/', label: { step: 'fix' }, wait: 600 }) // null when none came
  if (claim) {
    await team.reply(claim.task.id, 'patched, running the tests')
    await claim.complete('fixed in a1b2c3, tests pass')
  }
  ```
  
  Labels under `board.` are the board's own now: a label write, or a post, schedule, or import with `labels`, that sets or unsets one answers 400 `reserved_label`, on every backend. Nothing we know of wrote one.
  
  A root's edit or delete can now answer 503 `unavailable` when the board keeps changing under it, as a label write with `if` can: both check whether the thread is a task as of the write. Deleting a task's root cancels the task, and an edit of it by anyone but the task's owner holds it.
  
  A backend of your own implements the task methods, or answers 501 `no_tasks` from each: `vb conformance` then reports the new `tasks` group as not kept there.
  
  A backend holds its own limits on a task, as on a message: a request is checked for its shape, and the local board refuses what's over its own (a root as long as a message, 20 `needs`, a lease of 30 to 3600 seconds, a result or reason of 1,000 characters, 32 owners in `from`) with 400 `invalid_request`, or `text_too_long` for the text.
- 8251018: Tasks on Vercel's board: `board()` with no backend keeps tasks on the threads Vercel's API keeps, so `team.tasks` works there as it does on `local()`.
  
  ```ts
  import { board } from '@vercel/board'
  
  const team = board()
  const { task: fix } = await team.tasks.create('work', { text: 'fix CVE-123 in acme/web', labels: { step: 'fix' } })
  
  const claim = await team.tasks.claim({ channel: 'work/', label: { step: 'fix' }, wait: 25 }) // null when none came
  if (claim) {
    await team.reply(claim.task.id, 'patched, running the tests')
    await claim.complete('fixed in a1b2c3, tests pass')
  }
  ```
  
  What differs from `local()` there:
  
  - The API's limits are the ones that apply, and its refusal is what you get: text over 10,000 characters is its `invalid_message`, and a lease, a result, or more `needs` than it takes is a 400 `invalid_request` in its words.
  - A lease is 5 minutes at most. A claim's `until` says what it got, so one that asked for 15 minutes, or for nothing, comes back with 5.
  - Nothing times a lease. A claim whose lease ran out is over at once: the task is claimable, its owner may hold it, and it lists as ready. It still reads `claimed`, with its `until` in the past, until the next task write or list that sees it writes `task.expired`.
  - `claim({ channel })` looks only at tasks you may take: in each channel you may claim in, your own unassigned tasks, those of each owner `from` names, and with a profile, what's assigned to it. That's 200 places at most, the channels times those owners: past it the claim fails with 400 `claim_too_wide`, and a subtree with more than 50 such channels with 400 `channel_tree_too_large`. Name fewer owners, or a smaller subtree.
  - With `label`, it finds a task among the 25 oldest ready ones in each of those places: one with those labels behind 25 of the same owner's that lack them isn't found until one of those is claimed.
  - A caller that doesn't read the whole board, one held to a `can` say, lists the board or a subtree only where it reads 50 channels or fewer: past that, `tasks.list` fails with 400 `channel_tree_too_large`. Name a channel, or a smaller subtree.
  - A completion readies 65 of the tasks that waited for it before it answers. Any more become ready as later task requests reach them: a claim of one, a list that shows one or the completed task, or a `claim({ channel })` that finds nothing else to take.
  - A lost claim's error says why, in its message: `this claim on msg_… is over (lease_expired): claim it again`.
  - A task's changes stay in the feed for 30 days.
  
  `task.*` events reach `poll`, `tail`, and watchers on Vercel's board as on any other, a `task.renewed` only with `all`. A sandbox handed the board with `team.sandboxPolicy()` reaches its tasks there too, held to its `can`.
- c87b9eb: `GET /threads` pages back: a page read without `after` has `older`, the `before` for the threads last active before it, or `null` at the oldest, so a client reads every thread of a channel once, newest activity first (`team.threads({ channel, before: page.older })`). `before` with `after` is 400 `invalid_request`. A board from before it leaves `older` out. On Vercel's board, one channel's threads with no other filters page this way, each page one of the API's pages of 25; `before` on any other read is 400. `conformance()` checks it in a `paging` group, skipped on a board without `older`.
- bf01ace: `vb tasks`: hand work to agents from the CLI, on a board that keeps tasks. `vb tasks create` starts a thread as a task, or makes one of a thread that's there. `vb tasks` lists what's open. `vb tasks claim` holds a task by its ID, or with `--ready` the oldest ready one in a channel that has the labels you ask for, waiting for one with `--wait`.
  
  ```text
  $ vb tasks create work "fix CVE-123 in acme/web" --label step=fix
  812
  $ vb tasks create work "review the fix for CVE-123" --label step=review --needs 812
  814
  $ vb tasks work/
  #812  ready      fix CVE-123 in acme/web         step=fix
  #814  waiting    review the fix for CVE-123      step=review  needs #812
  $ vb tasks claim --ready work/ --label step=fix --wait 10m
  #812  yours for 15m  fix CVE-123 in acme/web
  $ vb reply 812 "patched, running the tests"
  818
  $ vb tasks complete 812 "fixed in a1b2c3, tests pass"
  completed 812
  $ vb tasks work/ --state all
  #812  completed  fix CVE-123 in acme/web         fixed in a1b2c3, tests pass
  #814  ready      review the fix for CVE-123      step=review
  ```
  
  The CLI keeps a claim in `~/.config/board/claims/`, for the profile that took it (`--as`, or `BOARD_PROFILE`) or for you, so `renew`, `release`, `complete`, `fail`, and `block` take only the task's ID, and a run as anyone else gets `claim_not_held`. `vb tasks run <id> -- <cmd>` claims a task, runs the command with `BOARD_TASK` set, renews while it runs, completes the task on exit 0, fails it on any other, and exits with the command's code. `unblock`, `reopen`, `assign`, and `cancel` are its owner's.
  
  `vb read` shows a task's state under its root (`task  claimed by claude via julian · 15m left`), and `vb tail` prints what happens to one (`#812  work  task claimed by claude via julian`). A failure the board answers about a task says what to run next, and a write that sets `board.task` by hand names the `vb tasks` command that makes the change. With `--json`, a claim is `{ task, claim: { epoch, until } }`: its token stays with the CLI.
  
  `vb()` and a CLI built with `createApp` have `tasks` too. `vb()` keeps a handle's claims in memory and has no `tasks run`. On a board that keeps no tasks, each command fails with `no_tasks`. On Vercel's board, a `--ready` claim that names more channels and owners than the board looks through fails with `claim_too_wide`, and a subtree with more channels than it reads with `channel_tree_too_large`: both exit 1 and say what to narrow.

### Patch Changes

- ea272a5: The inspector lists a channel by its threads, from `GET /threads`, 25 at a time by latest activity, with each one's reply count and latest reply: a channel whose newest messages are all replies showed "no messages yet: say something", and now shows its threads. Scrolling up loads the next older page from the last one's `older`. A live reply moves its thread to the bottom with no read, and one to a thread the view doesn't have reads the first page again, once for a burst. On a board without `older`, channels load by messages as before.
- 88e6197: Sync mentions a platform user natively from `@[slack:user:U0456]` when the board names them by this sync's own profile of them, `<principal>+slack:user:U0456`, as a sync elsewhere's users are.
- 17c375f: On Vercel's board, `vb wait --re 812 --after 812` and `vb wait 812` wait for what comes after the message. They answered at once with the message itself, since its posting is recorded a moment after its time, and in a channel with more than a page of history they answered with messages from before it.
- 1da1488: On Vercel's board, a command that starts from a message (`vb reply`, `vb read <id>`, `vb wait <id>`) asks the API for that message's channel by its ID, where it read the board's whole list of channels to find its name: one request, where it was a request for every page of channels the board has.
- d353ff8: On Vercel's board, a read that filters on what messages say or who wrote them (`--text`, `--by`, `--mentions`, `--source`) no longer reads a thread whose list already brought all of it: a post, or a post and one reply. It read every thread's messages, one request a thread, so `vb read archive --text osprey` over 40 posts was 48 requests and is 5.
- 4e825dd: On Vercel's board, `--mentions` finds messages that mention someone, on `vb read`, `vb tail`, `vb wait` and the handle's reads: you by your handle or actor ID with no name given, and anyone else by the name as written and what's under it, as on a local board. It matched nothing there, whatever the message said. A watcher's `--mentions` tail is still refused: Vercel's API matches those, and it keeps no mentions.

## 0.45.1

### Patch Changes

- 73140b7: On Vercel's board, a scheduled reply takes labels (`vb schedule 812 "check in" --in 1h --label kind=task`), as a scheduled thread already did: each send carries them, and the schedule shows them. It answered 501 `not_supported`.
- 7499cf1: On Vercel's board, a wait or a tail in one thread (`vb wait --re 812`, `vb wait 812`) reads the feed of that thread's channel, where it read every channel's on the board, and a read across channels takes each message from the feed, where it read each by ID. A 30-second `vb wait <id>` on a board with 80 channels was about 500 requests and is about 10.

## 0.45.0

### Minor Changes

- 9b2cfe1: `board()` no longer checks message text length, attachment count, or a schema's name, version, and description length before a backend does: the local board keeps refusing what's over its limits as before, and on `vercel()`, Vercel's API decides and its error comes back (text over 10,000 characters is now its `invalid_message` instead of `text_too_long`). A grant's channel pattern can now be as long as a channel path, up from 300 characters, so every channel can be granted.
- 46feeb0: Channel paths can be up to 2048 characters, up from 80. The board no longer holds a path to a backend's own limit: on `vercel()`, Vercel's API still caps channel names at 80 for now, and refuses a longer one with its `invalid_channel_name`. Clients on an older `@vercel/board` still refuse paths over 80 in events and requests, so upgrade them along with the board.
- a4a8376: `vb inspect --allow-host <host>` lets the inspector answer behind a proxy that serves it on another name, such as a tailnet host, instead of only on `127.0.0.1` and `localhost`.
- 4069b9e: Four things a UI on a handle needed. `team.events(query, { onState })` says whether the feed is connected: `onState` is called with `'live'` when the board answers a request for events, and `'retrying'` when one fails and the handle backs off, each change once. The first request, and the first after a failure, ask without waiting, so it's live as soon as the board answers. `@vercel/board/access` exports the permission names as a value, `PERMISSIONS`, beside the `Permission` type. And the root exports `ExplainPrincipal`, the type of the principal `team.explain` asks about, with `EventsOptions` and `EventsState`. And `team.discovery()` says the `name` of a team's board in Vercel's API (`General`, the default's), so a UI can show which board it's on.
  
  ```ts
  import { board, type EventsState, type ExplainPrincipal } from '@vercel/board'
  import { PERMISSIONS } from '@vercel/board/access'
  
  const team = board()
  let feed: EventsState = 'retrying'
  for await (const event of team.events({ all: true }, { onState: (state) => (feed = state) })) {
    // render(event, feed)
  }
  
  const whom: ExplainPrincipal = { user: 'ada@acme.com' }
  const { can } = await team.explain('ci/deploys', whom)
  ```

### Patch Changes

- a68ae0e: On Vercel's board, listing threads takes each thread's first and newest message from the thread list where the API sends them (`include=messages`), where it read each by ID: a 20-thread `vb read` is 2 requests where it was 32. Vercel's API doesn't send them yet and refuses the parameter, so a process asks once, reads that page again without it, and lists as before from then on.
- 82b14e6: `vercel()` names the authors on a page by asking Vercel's API for those actors by ID, where it read the board's whole list of actors, 50 at a time: a page of messages or threads, a thread with its replies, and a page of a channel's changes each ask once, for up to 100 authors a request, however many agents the board has. A synced message's project is named from the actor that imported it. On an API that doesn't answer actors by ID yet, names come from the list as before.

## 0.44.0

### Minor Changes

- 4d2b534: Vercel's deployment comment on a pull request shows in Slack as Vercel's own table (Project, Deployment, Actions, Updated) instead of a list. It's still one message per pull request, replaced in place as Vercel edits its comment, with the deployments Vercel skipped in a line under the table. A sync provider of your own is handed the comment's deployments too (`deployments` in the body of `post` and `edit`), beside the markdown that lists them.

### Patch Changes

- 5e532d6: A block's data gets the same answer on every board as on Vercel's: `checkValue` now reads each format as Vercel's API does (ajv-formats 2.1.1, full mode). A `uri` is RFC 3986's, so one with `<`, `"`, `{`, `|`, a space, or a bad percent-escape is refused where it posted before. An `ipv4` address with a leading zero, a `time` whose offset is any two digits, and a `date-time` parted by a tab are taken where they were refused. A `time`'s 60th second is taken only at `23:59:60`. `checkValue` also checks `items` given as a list of schemas, one for each place: it let any items through.
- f900be2: A synced message whose text opens with a code block, a list, a heading, a quote, or a table keeps it on Slack, GitHub, and Linear. The author's label (`**ada**:`) now sits on a line of its own above such a text, whether the default rendering wrote it or a renderer of yours that opens the same way. It used to share the text's first line, where a code block stops being one, so a message that was only a block arrived as a line of inline code.
- bfea984: An edit to a long message syncs on Vercel's board. Sync put the edited text in the inbox event's ID, which Vercel's API refuses past 300 characters, so the webhook answered 500 and the board kept the text from before the edit (a Vercel deployment comment stayed at "Building"). The ID now carries a digest of the text. `local()` refuses an inbox event ID over 300 characters too, as Vercel's API does, the conformance kit pushes an edit of a long message, and a webhook whose event the board refuses answers 200 instead of 500, so the platform stops redelivering it.
- 28a1096: `typing`'s `status`, and so `vb typing <id> "<status>"`, is at most 50 characters, Slack's limit for the text it shows in place of "Typing…": a longer one is a 400, where Slack refused it and the thread showed no status.

## 0.43.1

### Patch Changes

- 3c314de: In a CLI that bundles board's (`vercel board`), `inspect` and `serve` are unknown commands, like any other it doesn't have, instead of suggesting `npx @vercel/board`.
- 8dc1735: On Vercel's board, a deployment posts and reads blocks. `vercel()` reads the team's schemas through the board (`GET /boards/:boardId/schemas`), which Vercel's API answers to whoever the board lets in. It read the team's own routes before, which answer a project's credentials 403, so `schemas()`, `schema()`, and any post with a block failed from a deployment. Registering a schema there is still for people and apps.
- 75d30fb: On Vercel's board, `createSchema()` and `vb schemas create` take `created` from Vercel's API, which now says whether the request made the version. Registering is one request where it was two, and of two callers that register the same version at once, exactly one hears `created: true`; both could before.

## 0.43.0

### Minor Changes

- 27673a7: **Breaking:** `@vercel/board/cli` no longer has `inspect`, so a CLI that bundles board's (`vercel board`) carries no UI. There, `inspect` and `serve` now point to board's own CLI: `npx @vercel/board@latest inspect`. `createApp`'s `inspectorPage` option and `INSPECTOR_PAGE` are gone. `vb inspect` is unchanged.

## 0.42.1

### Patch Changes

- db0dacb: `grants`' app options read `--app <app>` in help, as `--user <email>` does, where they read `--app <slug|id>`. They still take an app's slug or its ID.
- 79729d0: `BOARD_AS` no longer stops the CLI or a handle with `renamed_env`. Nothing reads it, so with only `BOARD_AS` set you write as yourself; `BOARD_PROFILE` names a profile.
- 867631d: `inspect` without its page says so and to reinstall or update the CLI, instead of naming `createApp`'s `inspectorPage` and a `pnpm` build step that only board's developers can use.
- 835a3c0: `vb` and `vercel board` refuse an option the command doesn't take, instead of dropping it: `edit --attach` attached nothing and `edit --label` labeled nothing, both exiting 0. Now each is `Unknown option` (exit 2), and `edit --attach` says to reply with the file instead.

## 0.42.0

### Minor Changes

- e46ead7: `as(profile, { can })` holds a handle to a `can`, as `sandboxPolicy()` holds a sandbox: the board enforces it on every backend, as it does `x-board-can` (the header goes with each request over `http()` and to Vercel's API; on `local()` the caller is narrowed the same way). Like any narrowed caller it's never the deployment's integration, so an agent's tool that runs `vb()` on `team.as('fixer', { can })` can't register watchers, read sync's records, or read and join a platform's channels through `sources`, whatever commands it runs. `can` takes any `Can` or the header's text; a narrowed handle's `as()` and `sandboxPolicy()` only narrow it further.
  
  A caller narrowed with `x-board-can` reading the inbox on a board `local()` keeps now gets 403, as the docs say and Vercel's API does: it's one of sync's records.
- ff49fc3: A board answers text over 10,000 characters with `text_too_long` (400) instead of `invalid_request`, and a `hint` to put the long part in a file and attach it to a message, with a short summary as the text. On Vercel's board too: `board()` checks the text before the API sees it. `vb` and `vercel board` say to `--attach` it, or on an `edit`, to keep the edit short and reply with the file.

### Patch Changes

- a03d0ee: `vb(board, argv, { signal })` ends whichever command is running, its requests included, where it stopped only `tail` and `wait`: a call with `AbortSignal.timeout(…)` gets a deadline, and a request that hangs no longer holds every later call. A command it stops fails with `timeout` (1) for a timeout's signal and `canceled` (130) otherwise; a write it stopped says it may have landed.

## 0.41.0

### Minor Changes

- 290ddeb: **Breaking:** who writes is now said once, and checked.
  
  - **A profile is one header.** `x-board-profile` is an RFC 8941 structured-field Item: the profile's name, with its avatar as a parameter (`x-board-profile: fixer; avatar="https://example.com/fixer.png"`). The board ignores the old `x-board-avatar`, which released `vb` sends for a person with a Vercel avatar: an avatar comes only with a profile, in its header. `as({ name, avatar })`, `--as` with `--avatar`, and `BOARD_PROFILE` with `BOARD_AVATAR` send it. `BOARD_PROFILE` replaces `BOARD_AS`, and a CLI or handle that finds `BOARD_AS` set refuses to run (`renamed_env`) rather than write as you. `vercel()` still sends Vercel's API the name alone and `x-board-avatar`, which it reads today.
  - **No sessions.** Who writes is a principal and its profile. The board ignores `x-board-session`, which released `vb` sends inside a coding agent, and `by`, `/me`, and schedules carry no `session`, also for what an older board wrote with one. `ClientOptions.session` is gone, and a post's client ID is its actor's, whatever session sent it. `vercel()` sends none.
  - **No agent detection.** The CLI and a handle in Node read no coding agent's environment (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `GROK_SESSION_ID`, `CURSOR_AGENT`, `PI_*`, `AI_AGENT`): without `--as` or `BOARD_PROFILE`, you write as yourself, so `--human` and the `ambiguous_agent` error are gone. A profile named for a known agent (`claude`) gets no built-in avatar of its own accord: the board still serves the marks at `/avatars/<name>`, for a caller to pass as its avatar. `resolveActor` from `@vercel/board/access` takes no `audience`.
  - **Handles come from what verified you.** `--handle`, `BOARD_HANDLE`, `x-board-handle`, and `x-board-name` are gone: the board reads neither header, and a client can't name itself. A host's verifier's handle is its person's handle and name. A Vercel login's development token says only a user ID, so on a board that verifies it (`oidcTokens()`), a person goes by that ID, handle and name, and `vb` no longer asks Vercel for a username to send. A deployment's handle is its project's name in every environment (`support`, not `support@preview`), with the environment in its name (`support (preview)`), so a project's environments share it: `@support`, `--mentions support`, and `--by support` match every environment's deployments, and a deployment's `--mentions me` matches a mention of any of them. To name one environment's, use its actor ID (`@[vercel:project:prj_support:preview]`, `--by vercel:project:prj_support:preview`), or, where its handle holds the environment (`prj_support@preview`), that handle (`--by prj_support@preview`). Every author a credential named is `verified`, so posts to Slack go out under their names. `vb serve` is always your OS user.
  
  New: `team.sandboxPolicy({ profile?, can?, token? })` returns a Vercel Sandbox network policy that hands the board, and nothing else, to a sandboxed agent. The sandbox's proxy adds the credential (this deployment's own OIDC token, or `token`), `x-board-profile` (the handle's `as()` profile by default; one is required), and `x-board-can` (`can`, or read, post, react, and label everywhere) to its requests for the board's own routes; it names those routes one by one, by method and shape (on Vercel's board, exactly the calls `vb` makes there for what an agent does), withholds routes that change grants, register watchers, or write sync's records, refuses Deployment Protection's bypass cookie, and blocks every other host. `can` takes any `Can` (`'all'`, `['read']`, a map) or the header's own text. Spread its `allow` beside your own hosts. It works the same on Vercel's board, whose API holds the sandbox to its `x-board-can`. See the guide "Hand a board to a sandboxed agent".
  
  ```ts
  import { board } from '@vercel/board'
  
  const { allow } = await board().as('fixer').sandboxPolicy()
  // await Sandbox.create({ networkPolicy: { allow: { ...allow, 'registry.npmjs.org': [] } } })
  ```
  
  The conformance kit checks who writes: a profile and its avatar in one `x-board-profile`, shown on what it writes, `x-board-avatar` and `x-board-session` ignored (a post that carries them lands as its verified actor, with no avatar of theirs and no session), and no `session` on a message, an event, or `/me`. It sends those headers through a new option, `withHeaders(headers)`, which `vb conformance` passes and which stands in for `withCan` when that's left out. Vercel's API fails the profile's and `x-board-avatar`'s until it reads them as the protocol has it.
  
  ### Migrating
  
  - A released `vb` keeps working against an upgraded board: what it sends that the board no longer reads (`x-board-avatar`, `x-board-session`, `x-board-handle`, `x-board-name`) is ignored.
  - A proxy or sandbox network policy that sets `x-board-avatar`: put the avatar in `x-board-profile` instead, `<name>;avatar="<url>"`; the old header no longer shows.
  - `BOARD_AS=<name>`: set `BOARD_PROFILE=<name>`.
  - A person's own avatar, which `vb` sent from your Vercel account, no longer shows on a local board.
  - A coding agent that posted with `vb` and no flags: pass `--as <its name>` (`--as claude`), or set `BOARD_PROFILE`. The board skill tells agents to. Drop `--human`, which is now an unknown option.
  - People on a local board that Vercel logins reach show as their user IDs. To show names, verify them with `authenticate` and return each person's handle: a host's verifier's handle stands.
  - Mentions and `--by` values that named a deployment `<project>@<env>`: use `<project>`. A watcher or filter matching `user-<id>` handles: match the user ID, or the principal.
  - Code that sends `x-board-session` or reads `by.session`: agents that must stay apart write as profiles of their own (`--as fixer-1`), and `by.actor` tells them apart.
- f19c565: **Breaking:** boards issue no tokens. `createToken`, `tokens`, `revokeToken`, the `/tokens` routes, `vb tokens`, `BOARD_TOKEN_PREFIX`, the `board_token_scope` error, and the conformance kit's `tokens` group and `withToken` option are gone from every board, `local()` and `vb serve` included. A `board_` secret from before is just another credential to `authenticate`, and `oidcTokens()` refuses it.
  
  - **What replaces them:** a caller with an OIDC token gets in by a grant. A proxy that holds a credential narrows it with `x-board-can`, as `sandboxPolicy()` does for a sandboxed agent. `BOARD_TOKEN` stays the credential `vb` and `http()` send to a board at a URL: an OIDC token, or a placeholder a sandbox's network policy replaces. `vercel()` never sends it: in Node it sends `VERCEL_TOKEN`, the deployment's OIDC token, or your Vercel login.
  - **A profile changes only what it wrote.** A request that writes as a profile edits, deletes, and cancels the schedules of only what that profile wrote; the principal itself, with no profile, changes what any of its profiles wrote. So `vb --as claude` no longer edits what `--as codex` wrote, and a sandbox no longer edits what its deployment wrote as another profile. The conformance kit checks it in its core group, which Vercel's API fails until it holds a profile to its own messages.
  - **An older board's log** still loads: its token events fold into nothing, and a schedule a token made is canceled, `revoked`, at its next send.

### Patch Changes

- 54e8bb7: `vb --help` shows the options most runs of a command take, in its row of the command list: `post <channel|id> [text] [--label k=v]... [--attach file]...`, `label <id> [k=v]... [--if-unset k] [--unset k]`, `schedules [id] [--by handle] [--all]`, `wait [channel] [--after id] [--timeout 10m]`, and `schedule … (--in 5m | --at time | --every 30m)`. They were only on each command's own page, so a reader of the list asked for what was already there. `download` names its argument `<attachment-id>`.
- 5d95678: `vb read <channel>` ends with the command that reads on from its cursor (`new since then: vb read dev --label kind=bug --after 1290`, filters included), and `vb wait` prints the wait that goes on after its event (`next: vb wait dev --after 1291`), so an agent's loop is in the output and not something it has to work out. `vb wait <id>` now waits in that message's thread for what comes after it, where it waited on a channel named after the ID and never answered. A wait that times out says it sees only what arrives after it starts and names the `read` for what is already there, and `--timeout 900` is 900 seconds, where it was 900 milliseconds. Help says `--text` matches a phrase, shows `--after` in `read` and `wait` examples, and describes `--json` as the one object it prints.
- b850ef6: `vb post` and `vb reply` refuse what they used to drop without a word: a label written after the text (`vb post answers "Friday" q=launch` now says labels go with `--label`), a second text after the first, `--text`, and `--attach -`, each with how it is written. `vb label 812 owner=` is refused too and points at `--unset owner`: it set a label with no value, which still counted as set and blocked a later `--if-unset owner`. `--label owner=` on a post is refused the same way, and `--if owner=` still matches a label that has no value.
- 1e7351f: `vb schedules s12` shows that schedule, sent, canceled, or pending, where it answered "Couldn't find message #s12": the way to check a cancel went through. `vb download notes.txt` says a file's name isn't its ID and where the ID is. An unknown command that names one by another word (`search`, `list`, `cancel`, `claim`, `attach`, and the like) points at the command it means, and "Couldn't find channel" says a channel appears with its first post.
- 5b20202: On a local board, a caller that can't list grants gets the same 403 for revoking or updating a grant it can't reach as for one that isn't there: `this token can't revoke g5: it needs manage wherever that grant reaches`. It was told `it needs manage at *` for a missing one, and since grant IDs count up from g1, trying each mapped which grants exist. A caller that may list grants still gets 404 `grant_not_found`, or `revoked: false`, for a missing one.
- 6f20a77: `--by me` finds your own messages, threads and schedules on a local board (`vb serve`, `local()`), as it does on Vercel's board and as help says. It matched nothing there: `me` was looked up as a handle. As on Vercel's board, `me` is the caller alone: a person's `--by me` leaves out what their agents wrote, which `--by <handle>` covers.
- 3bd4e6a: `@ada: can you look?` mentions ada. A handle followed by a colon was never a mention, so the commonest way to address someone at the start of a message notified nobody, and `--mentions` didn't find it. A colon that joins the handle to more (`@slack:U0456`) still isn't one.
- b54669b: A watcher is woken by the messages it scheduled itself. A watcher's own writes never wake it, and that covered what a schedule of its own posted too, so a watcher that scheduled "check on CI in 5 minutes" was never run on it. Now each send of a schedule wakes the watcher that made it, like anyone's post, on `local()` and for watchers run as tails; what it then writes on that message (a reaction, an edit, a label) still doesn't. On Vercel's board the match happens in Vercel's API, which follows: until it does, a deployment's watcher there isn't woken by its own scheduled sends, and neither is one by an agent writing under a profile named for it (`team.as('fix')` and a watcher `fix` are one actor).

## 0.40.0

### Minor Changes

- f31efac: A message can carry data: a JSON object in a code fence that names its schema (` ```json#sandbox@1 `), a block. The board checks it against that schema when the message is posted, edited, or scheduled, and refuses one that doesn't match (400 `invalid_block`, saying which field) or names a schema it doesn't have (400 `schema_not_found`). Every message has `blocks`, each `{ schema, version, data }`, so a program reads the data and never parses the text.
  
  `vb post`, `reply`, `schedule`, and `edit` take `--schema <schema>`: the text is that schema's JSON, and the message is only that block. From a handle, `block(id, data)` from `@vercel/board` writes the fence, to post alone or among prose.
  
  ```text
  $ vb post deploys --schema sandbox@1 '{"id":"sbx-123","action":"started","config":{"vcpus":4}}'
  2
  $ vb read deploys
  deploys · 1 thread · cursor 2
  
  #2  claude via julian · 0s
        data sandbox@1 · {"id":"sbx-123","action":"started","config":{"vcpus":4}}
        no replies
  ```
  
  A message a sync brings in from Slack or GitHub is never checked or refused, and has no blocks. A fence inside a longer fence, or in a quote, shows a block without posting one. A message that already has a ` ```json#name@version ` fence shows it as a block once you upgrade, unchecked; a new write with one is checked. A backend of your own answers `blocks` on every message it returns: `[]` keeps none.
- 801d747: **Breaking:** a platform user a sync elsewhere imports is a profile of that sync's principal, not the platform user alone. A sync that registers on a local board, and every sync on Vercel's board, only says who wrote a message, so what it imports is by `<principal>+<author id>`: `vercel:project:prj_support:preview+slack:user:U0456`, its `by.profile` the author's ID. It shows through the project, as agents do, in `vb read`, `vb tail`, the inspector, and the label sync posts with:
  
  ```text
  #2  Malte via support (preview) · 2m
        ship it, I checked
  ```
  
  The board's own sync on `local()`, which checks each webhook itself, still imports as `slack:user:U0456`. Code that matches an imported author's actor ID, for a reaction, a `--by` filter, a watcher's tail, or a mention, matches the profile's ID instead, or `by.profile` for the platform user. Two syncs' imports of one user are two actors, each named, handled, and pictured only by its own sync's imports: a sync without `sync` in every channel now keeps its own users' records instead of leaving them be. A mention of a profile renders natively (`<@U0456>`) only through the sync of its own principal, under the key it imported them through; anywhere else it posts the name.
  
  **Breaking:** a platform user's ID starts with the sync key they came through, not the platform: `slack-eu:user:U0456` through a key `slack-eu` registered for Slack. The key is the connection, so renaming a key changes its users' IDs. A sync keyed by its platform's name (`slack`, `github`, `linear`) keeps the IDs it had; one under another key, the board's own (`sync: { support: slack(…) }`) or one registered on it, names new imports under that key. `POST /sync/imports` refuses an author whose ID isn't under the import's key (`from`), or with no `from`, one of the caller's keys, as Vercel's API does. Providers still name users on their platform, and board files them under the key. Every actor view of a platform user says its `platform`, which the inspector's logo and sync's label show. A sync elsewhere's import that mentions one of its keys' users (`@[slack-eu:user:U0456]`) mentions its own profile of them, and a platform user renders natively only through their own key.
  
  **Breaking:** mentions are text. A write never fails over one: no `ambiguous_mention`, no `unknown_mention`, and no `unknownMentions` on a post, a reply, an edit, or a schedule, nor `vb`'s `warning: @x matches no one`. Messages and their events lose `mentions`, the actor IDs a write resolved, and `post()`, `reply()`, and `schedule()` return the message or schedule alone (the `Written<T>` type is gone). `--mentions` on `read`, `tail`, and `wait`, and in a watcher's tail, matches the text outside code: `@handle` and `@[actor-id]` for whoever it names, a person's agents included (`@julian/claude`), with `me` your handle and ID. Only a caller that reads every channel finds someone through their other name; anyone else's matches what it names as written. An email matches `@[ada@vercel.com]` as written, and nothing asks Slack who has it. Each sync resolves mentions when it posts, against its own users only: `@ada` goes out natively (`<@U0456>`) when exactly one of them has the handle, or of several, the one who wrote in the thread; `@[actor-id]` natively when it's one of them and as the actor's name otherwise; and `@[ada@vercel.com]` as whoever Slack finds with that email then, or as the plain email. Anything else goes out as written. So a sync allowed one channel, or two syncs that each import a Malte, never make `@malte` fail. On `vercel()` sync resolves them from the API's actors, and mention filters stay refused. `POST /sync/imports` no longer takes `op: 'seen'`, which board() sent only to learn the user an email named: a sync import names its platform users by importing their messages.
  
  **Breaking:** a platform user a sync elsewhere imports goes by `<its project's name>/<their handle>`: support's Malte is `support/malte` in every environment, and the environment shows only in their name (`Malte via support (preview)`). The part after `/` is typable: diacritics off, lowercased, each run of anything but `a-z0-9._-` as `-`, and the ends trimmed, so "Jürgen Ubl" is `support/jurgen-ubl`, or with nothing left, their platform ID without the key, the same way (`T_EU:U0MALTE` is `t_eu-u0malte`), cut to fit a handle's 128 characters. `@support/malte` reaches only support's Malte as its sync posts, `@malte` is the shorthand each sync reads as its own user, and `--mentions support` finds everyone support imported. The board's own sync's users keep their handles. `vercel()` takes Vercel's API's handle, and puts one without a `/` under the project's name (or ID).
  
  Every actor view with a profile has `via: { name, environment }`, an agent's included (`claude via julian`), and so does `me()` for a caller writing as one. `vercel()` reads Vercel's API's platform profiles (`createdBy.profile.platform`, and `via` and `platform` on its actor views), and an import from an API that still names the platform user alone shows as before. Imports logged before this release keep the IDs they were written with.
- d5f2016: A new board lets every project on its team `sync`, as Vercel's API now starts a team's board: g2 gives every project's deployments, previews included, read, post, react, label, and `sync` everywhere. So any of them may speak for platform users through sync's routes: register a platform, import as its users, and attach a thread to a Slack channel or a GitHub issue the board's own sync reaches. `vercel()`'s `me()`, and so `vb whoami`, show `sync` for a deployment's own credential. Apps (g3) and board tokens minted without a `can` that says `sync` still don't sync.
  
  Boards on Vercel's API that already exist keep their grants. A local board doesn't store a starting grant until you change it, so on one where g2 is as it started, g2 syncs too once you upgrade; one that changed or revoked g2 keeps what it set. To keep `sync` to the deployments that run a sync, take it from g2 and grant it back to them where they sync:
  
  ```text
  $ vb grants update g2 --can '*=read,post,react,label'
  updated g2  --all-projects --environment production,preview,development  read post react label
  $ vb grants create --project prj_support --environment production --can support=all
  created g4  --project prj_support --environment production  support=all
  ```
- 500394f: A board keeps a registry of schemas: a JSON Schema for an object, under a name and a version such as `sandbox@1`, which says what a piece of structured data holds. `vb schemas` lists them, `vb schemas inspect <schema>` prints one, and `vb schemas create <schema> --schema <json|@file|->` registers a version, as `team.schemas()`, `team.schema(id)`, and `team.createSchema()` do from a handle (`GET /schemas`, `GET /schemas/:id`, `POST /schemas`). Nothing checks a message against one yet.
  
  A version never changes and is never removed: the same definition again registers nothing, another is 409 `schema_immutable`, and a change is the next version. A definition uses structural keywords only (no `$ref`, `pattern`, or `uniqueItems`) and stays under 32 KB. Every board has `git-commit@1` and `vercel-deployment@1` built in. Anyone the board lets in reads the schemas, and registering needs `manage` at `*`.
  
  ```text
  $ vb schemas create sandbox@1 --schema @sandbox.schema.json --description 'What a sandbox did.'
  created sandbox@1
  $ vb schemas
  git-commit@1         built in  A Git commit, by its full SHA and the first line…
  vercel-deployment@1  built in  A Vercel deployment, by its URL and optionally t…
  sandbox@1            0s        What a sandbox did.
  ```
  
  On Vercel's board they're the team's registry, which every board on the team shares. `vb conformance` and `conformance()` check it in a new `schemas` group, which registers one version, `conformance@1`, that stays on the board. A backend of your own has three more methods to implement, `schemas`, `schema`, and `createSchema`: one that keeps no schemas answers 501 `no_schemas` from each.
- 6b89bfb: `@vercel/board/schemas` exports how a board keeps schemas and reads blocks, as plain functions that import nothing: `checkDefinition(schema)` and `checkValue(schema, value)`, which say why a definition can't be registered or a value doesn't match one, `canonical(schema)`, by which two definitions are the same version whatever order their keys come in, `findBlocks(text)` and `block(id, data)`, which read and write the blocks in a message's text, `parseSchemaId(id)`, and `BUILT_IN_SCHEMAS`. A server that keeps a board itself, as Vercel's API does, checks a write with them as `board()` does.
- 57864c6: A message sync copies to Slack posts under its author's name and picture when the app has `chat:write.customize` and the board verified the author: everyone on Vercel's board, and on a local board whoever shows under the handle a credential it checked gave them (an OIDC token, a board token, a host's verifier), as itself or after `via`: `clever-lemur via vboard-factory` from the project's OIDC token. A handle or display name a client sent keeps the label: a person's from their CLI, and an agent's that shows it after `via`. Actor views say so with `verified: true`. A person posting as themselves is just their name (`Julián Benegas`), and anything written on a principal's behalf is `<name> via <principal>`: `claude via julian`, or `Malte via support (preview) (slack)` for a platform user another sync imported through another key. Its `**name**: ` label is left out. A name longer than Slack's 80-character username is cut before its attribution, which stays whole; one whose attribution alone wouldn't fit goes as the app with the label. The label stays where Slack can't show a sender: without that scope, and on a new thread whose root carries files. A custom provider's `post` and `edit` get `as` for every verified author's message, a person's included.
- 0cea941: **Breaking:** on Vercel's board, another project's sync key reads `<project>/<key>`. Vercel's API now keeps each project's sync keys apart, so support's `slack` and www's `slack` are two keys on one board. A message's `from`, an event's, `vb sync <id>`'s targets, and `--source` name another project's key by the project's name, `www/slack`, as its deployments go by on the board, or by its ID where the API doesn't name it, `prj_…/slack`; `--source` and a watcher's tail take either. A deployment's own project's keys stay bare, and a person sees each key under its project. A read or a watcher that filtered `--source slack` for another project's imports filters `--source www/slack` now. www's import reaches support's Slack copies, as any message on the board does, where support used to take it for one of its own and skip it.
  
  On Vercel's board a deployment shows by its project's name, `support`, and as `support (preview)` outside production, its handle `support` in every environment, in `vb read`, `vb tail`, `vb actors`, `vb whoami`, and the inspector, where it showed as `prj_support` or `prj_support@preview`. So does the project an agent or an imported user acts through (`Malte via support`), and `--by support`, a watcher's included, takes the deployments that show by that name. The name is the handle Vercel's API gives the project's deployments, or else what its imported users say; where nothing names the project, it keeps its ID.
  
  Within a project, one deployment holds each key: production takes it over from a preview or development, and otherwise the first to register it keeps it. `vercel()` reads who holds which from its registration, which no longer fails with 409 `sync_key_taken`, and syncs only through the keys it holds: a webhook for another answers 200 before its adapter reads it, and it pulls, imports, starts threads, and delivers nothing through it. Its watchers run as before. It says so once:
  
  ```text
  [board] slack is synced by production
  ```
  
  Against an API from before this, a deployment holds every key it registered, a second registrant's is still 409, and a target that names no project is the reader's own. A backend of your own says which keys sync where it runs with `syncedHere(key)`; without it, every key does.

### Patch Changes

- 0f79f82: `vb conformance` and `conformance()` check the `text` filter: it matches anywhere in a message's own text, in any case, with `%` and `_` as themselves, and finds an edited message by what it says now. A backend that ignores `text`, or matches it as SQL's `LIKE` does, now fails a core check.
- 773e94e: `vercel()`'s `me()`, and so `vb whoami`, ask the board what your credentials may do there: your team role within what the board's grants give you, where it said your team role alone. A board that shuts you out answers as any other call there does.
- 64d2800: `vercel()` waits and sends a request again when Vercel's API puts it off with a 429 or a 503, up to four more times over about 15 to 30 seconds, so `vb` and the SDK ride out a busy minute where they failed at once. A write goes again with the operation ID it had, so it lands once. Waits start at a second, double, and each adds up to as much again at random, so agents sharing one credential don't come back together.
- e4c210a: Vercel's board takes a platform message's files. A screenshot posted in Slack comes over as an attachment on the board, uploaded as this deployment's project, instead of a link to Slack that only Slack users can open. It needs Vercel's API to take `attachments` on sync imports.
- 6b40db1: On Vercel's board, `vb tokens` and `tokens()` list every board token, following Vercel's API page by page once it pages `GET /tokens`, instead of only what its first answer holds. Against an API that doesn't page yet, its one answer is still the whole list.

## 0.39.1

### Patch Changes

- be05b7f: Slack sync no longer posts a new thread's root twice when Slack fails for a moment while board looks for the message its file upload made: the lookup waits out a passing error instead of retrying the delivery, which uploaded the files again.

## 0.39.0

### Minor Changes

- f86e15c: **Breaking:** a board at `BOARD_URL` no longer registers its watchers on the board it uses, and nothing wakes it. Its config watchers run in its own process as tails, following that board's events the way `vb tail` does. On Vercel they don't run, since a function doesn't outlive its request, and it logs that once. `board()` with `sync` throws on a board at `BOARD_URL`: run sync from the config of the board that keeps the log, or on Vercel's board. A board on `local()` or `vb serve` wakes nothing either: registering a `url` with it answers 501 `no_wake_by_url`, and anyone who registers there pulls their matches.

### Patch Changes

- a184d64: `vercel()` registers a deployment's watchers with a path, or nothing to pull, and never sends a `url`, which Vercel's API is about to refuse. A registration it answers without a `url` and without a path pulls, as it should.

## 0.38.0

### Minor Changes

- 7edbff9: `@vercel/board/access` exports `parseCan` and `CAN_MAX`, so a server that reads `x-board-can` itself parses it exactly as the board does: the same `can`, and an `InvalidCan` with the same message where the board answers 400 `invalid_scope`.
  
  ```ts
  import { compileAccess, InvalidCan, parseCan } from '@vercel/board/access'
  
  const access = compileAccess({ '*': 'all' }) // the caller's, however your server works it out
  try {
    const narrowed = access.narrow(parseCan('dev/=read,post;ci/=read'))
    narrowed.can('post', 'dev/web') // true, and false in ci
  } catch (error) {
    if (!(error instanceof InvalidCan)) throw error
    // answer 400 invalid_scope with error.message, as the board does
  }
  ```
- 4c62e8a: On Vercel's board, `vb grants create`, `update`, and `explain` with `--github` or `--oidc`, and `vb tokens create` run as a person, say why Vercel's API refuses them and what to do instead, with reason `unsupported_principal`. Vercel's API takes no GitHub or OIDC principal in a grant, and explains none: a workflow gets in as a Vercel App, which an OIDC exchange policy issues its token for, and the grant names that app. It mints board tokens only for a deployment, or from a board token, and for a day by default and 7 days at most, since a deployment can mint again: board's own 30 days, up to 90, stays for `local()` and boards of your own. `grants create` no longer notes that Vercel's board doesn't sign in GitHub or OIDC callers yet (`callers_not_signed_in`), since it takes no such grant. The conformance kit's checks that grant to someone besides the project name the app in `principals` when it's given one, and the repository otherwise; on `unsupported_principal` they skip, as do the check that explains for a repository's runs, and its tokens checks where the run mints none.
  
  ```text
  $ vb grants create --github acme/web --can 'ci/=post' --scope acme
  error: Vercel's board takes no GitHub or OIDC principals in a grant.
  
    Grant an app that an OIDC exchange policy issues tokens for: --app <slug>.
  ```
- 6a8200c: The header that narrows a token for one request is `x-board-can` now, not `x-board-scope`: its value is a `can`, written as `--can`, grants, tokens, and `/me` write theirs (`dev/=read,post;ci/=read`). This breaks a proxy that still sends `x-board-scope`: the board refuses it with 400 `invalid_scope` rather than ignoring it, so its callers never get the token's whole access. Send the same value as `x-board-can` instead. Nothing we know of sent it, so the board doesn't narrow by both. A header it can't parse is still 400 `invalid_scope`, with a message that names `x-board-can`.
  
  The conformance kit checks the header now, through a new `withCan(can)` option, which `vb conformance` passes: a caller narrowed with `x-board-can` is refused outside its `can`, and gets 403 registering, pulling, or acking watchers, and on sync's imports, receipts, and inbox. Vercel's API doesn't read the header yet, so a board on it fails those checks until it does.

### Patch Changes

- c98a41b: A caller that may post in a channel but not read it can post there through `vercel()` now. `post()` names the channel to Vercel's API by name instead of looking it up first, which such a caller can't, and names the channel it posted in without reading it back. A retried post that Vercel's API answers with IDs only comes back as it was sent. This needs Vercel's API to take `channel` on `POST /threads`: until it does, it refuses every new thread posted through `vercel()`.

## 0.37.0

### Minor Changes

- cefefe6: Watchers drop `when: 'enters'`: `run` gets every event its tail prints, replies in a thread the tail's label matches included. This breaks a watcher that set `when: 'enters'`, which now also runs on those replies and on label writes that keep it matching. Check the event in `run` instead, and filter on the write that set the label:
  
  ```ts
  import { board } from '@vercel/board'
  
  export const team = board({
    watch: {
      done: {
        tail: '--label state=done',
        run: async ({ event, board }) => {
          if (event.type !== 'labels.changed' || event.payload.set.state !== 'done') return
          await board.react(event.message!.id, 'check')
        },
      },
    },
  })
  ```
  
  `POST /watchers` and `RegistrationView` carry no `when`, and a registration's hash covers only its tails and sync entries. A board on `http()` and the board it registers with hash alike only on the same side of this release: until both run it, each wake-up registers again.
- cc93722: `@vercel/board/cli` has `inspect`, so `vercel board inspect` opens the board in your browser, as you. It loads only when it runs, and the inspector's page isn't bundled with it: an app that bundles board's CLI fetches the page that `INSPECTOR_PAGE` names (this version's `dist/inspect/app.js`, with its SHA-256) and hands it to `createApp` as `inspectorPage`. `serve` stays the standalone CLI's own, so an app that bundles board's CLI still brings no A2.
- 623c4cc: fx is a named coding agent: the CLI detects it from `AI_AGENT=fx` (with `FX_SESSION_ID` as its session once fx sets one), and the board serves fx's icon as its avatar.
- b0e161c: The inspector shows your avatar where it says who you post as, and a profile you post as takes an avatar too: name it and give an https URL in the profile menu, and the page remembers it for that profile. Its accent is black, white in the dark, in place of orange, and errors are red. Typing anywhere lands in the open thread's composer, not the channel's. Right-clicking the blank space beside a message's text opens the message's menu, and the cursor there is the default one; the browser's menu, and the text cursor, stay on the text itself. A long message ID no longer widens that menu.
- 1de6ffd: Vercel's board syncs. `board({ sync })` with no backend runs Slack, GitHub, and Linear here, where it threw, and keeps sync's records in Vercel's API: imports, receipts, lookups by platform ID, and the inbox. Platform authors show as `external` actors, and reads and the board's config watchers filter by `--source`. Vercel's API takes no files on imports yet, so a platform message's files come over as links to them there. Sync runs as this deployment's project: a user token, like the CLI's, gets 403 on sync.
  
  ```ts
  import { board } from '@vercel/board'
  import { channels, slack } from '@vercel/board/sync-slack'
  
  export const team = board({ sync: { slack: slack('slack/acme', channels({ '#prs': 'prs' })) } })
  ```
- faba5ad: On Vercel's board, only a deployment's own credentials register watchers: its OIDC token, never a board token, whoever made it. This breaks a board run as a person (`next dev` with your `vercel login`, `VERCEL_TOKEN`) or with a board token (`BOARD_TOKEN`, a `fetch` that sends one), which registered its watchers as that person or project. Now its config's watchers run in this process as tails: each follows the board's feed from its first use, as `vb tail` does, retries as on a local board, and writes as its credentials with the watcher's ID as its profile. Sync doesn't run for it. A board token in a `fetch` passed to the board is found out by the API's refusal of its first registration, and never tries again. A tail needs a process that stays up, so on a Vercel deployment, watchers need its own OIDC token: with `BOARD_TOKEN` or `VERCEL_TOKEN`, none run there.
  
  Every deployment on Vercel registers its mount path, a custom environment and a `vercel deploy` preview included, and never pulls on its own. Off Vercel, a board registers no URL and pulls its matches instead of being woken. A dev server counts as off Vercel even with `vercel env pull`'s or `vercel dev`'s `VERCEL=1`, since its `VERCEL_ENV` is `development`: there, a person's watchers run as tails. `register()` on Vercel's board refuses a `url` (400 `invalid_request`), and the API's 403 `watchers_need_project` comes back as a handle error with a hint, which `vb` reports as reason `watchers_need_project`; `board_token_unsupported` is gone. The conformance kit skips its watchers checks on `watchers_need_project`.

### Patch Changes

- ed413d8: A request its own caller stops, such as an inspector tab that reloads in the middle of a long-poll, no longer logs `[board] [DOMException [AbortError]: This operation was aborted]` or answers 500. No one reads the answer, so the board answers 499 and logs nothing. A failure of the board's own still logs, whether or not its caller is still there.
- df1e0e7: Fix four bugs a 200-agent review found: `--by <handle>` on a vercel() board matches the handle the board shows (`julian`, `julian/claude`), a person's covering their agents; `--mentions ada@vercel.com` (and `--mentions me`) takes the email as its value instead of filtering on mentions of you, and nothing after `--` is read as a flag; a failed discovery or Deployment Protection bypass lookup is asked again on the next call instead of failing the transport for good; and `channels()` no longer drops an event while a channel key can't be resolved: one in an ID key's channel is kept to import once it does, and one only a `#name` key may route is refused so the platform sends it again, without storing other channels' events.
- 5cced74: Vercel's board keeps `noSync: true` on a post, a reply, or a schedule, so sync never sends it to a platform, instead of reading it back as `false`. As Vercel's API keeps it, a root with `noSync` keeps its whole thread off: its replies read back `noSync: true` too.

## 0.36.0

### Minor Changes

- ce81561: `vb grants` names its options as the Vercel CLI does. `--branch`, a `--github` modifier, is `--git-branch` now: `vb grants create --github acme/web --git-branch main --can 'ci/=post'`. This breaks `--branch`, which shipped in 0.35.0. `--project` takes `-p`, and `--environment` takes `-e`, both still repeatable: `vb grants create -p web -e production -e preview --can 'ci/=post'`.

### Patch Changes

- 89cbe13: The inspector opens in under a second on a team board in Vercel's API, where it took 40: it shows once it knows who you are and the channels, and the activity view fills in when its read lands. That read, the latest across channels with no filter, now takes one page of each channel's messages at once instead of every thread's messages one at a time: on a board with 11 channels and 144 threads, 13 requests in 0.9 seconds instead of 172 in 40. Up to a `limit` of 100 it's exactly the latest `limit`. Past that, it can answer with fewer when one channel has more than 100 of them, since the API lists no further back, but never skips a message newer than its oldest.

## 0.35.0

### Minor Changes

- db8c8af: `vb grants create`, `update`, and `explain` name principals with a flag each, `--user`, `--project`, `--github`, `--oidc`, `--app`, `--all-users`, `--all-projects`, `--all-apps`, and `--everyone`, each followed by its modifiers (`--environment`, `--workflow`, `--branch`, `--event`, `--claim`): `vb grants create --github acme/web --workflow ci.yml --can 'ci/=post'`. `--can pattern=permissions` repeats and takes `all` and `none`. `update` takes `--add-<kind>` and `--remove-<kind>`, and `--can`, which replaces the grant's. `explain` (`--app` included) prints which grant decides a channel, `security/ wins over *. Closest grant for bob@acme.com: g4 (--user): all.` `vb channels create security --private` closes a new channel to everyone but you. `vb tokens create --can` takes `none` too, and repeats.
  
  The handle does what the CLI does, with the same names: `createGrant`, `updateGrant`, `revokeGrant`, and `explain` take `'none'` at a pattern and give a project without `environments` its production deployments, and `createChannel(path, { private: true })` makes a grant letting you in, one closing the channel to everyone else, then the channel. Before it writes anything, it refuses a path where it or a channel under it is there (`channel_exists`), and one a grant other than `*`'s reaches already (`channel_granted`, naming the grant to revoke), since that grant would still let in whom it names. A project a board doesn't let in (`board_not_granted`) is told the grant that does: `Grant it: vb grants create --project prj_pong --environment preview --name security --can '*=read,post,react,label'`, without `--name` for the team's board.
  
  On Vercel's board, `vb grants create --github` or `--oidc` adds `note  Vercel's board doesn't sign in GitHub or OIDC callers yet: this grant works once it does` under `created …`, and with `--json` a `callers_not_signed_in` warning. A private channel is taken back, with nothing made, when someone adds themselves to its creator's grant, or opens its lock, before the lock lands.
- ab92d1d: `conformance()` checks how grants combine, through `explain`: the most specific pattern decides, then the closest principal there, ties add up, `everyone` lets no one in, and a viewer reads but neither posts nor manages. It checks that an app is kept by its client ID, and every app as a group. It checks that changing a grant takes `manage` at its patterns, and that a token grants no one past its own `can`, even under a lock, and lets no one in where `everyone` gets more than it has. Every grant it makes is in `conformance/grants/`, the same for every run, so it leaves no channel behind; it revokes them all, and a revoke that fails fails the check. Two runs on one board at once see each other's grants, so run it on a scratch board. A board that looks names up needs real ones: pass `principals: { project, repository, viewer, app }`, none of them the run's own, which it refuses before it writes, or, for a project named by name, after one grant that changes nothing for the run, which it revokes. Grants across teams are skipped, since they aren't specified yet.
  
  On a board token, `conformance()` skips the watchers checks, `a board token can't register watchers yet`, as Vercel's API answers for now. `vb conformance` sends the tokens it mints to the board it checks by its URL, so on a team's board in Vercel's API they reach it by its ID, as a board token must.
- f71a0fa: A board on `vercel()` sends grants to Vercel's API in the protocol's shapes: `updateGrant` as `PATCH /boards/:id/grants/:id`, and `explain` as `GET /boards/:id/grants/explain`. The API looks up the names people type (an email, a project's name, a repository, an app's slug) and answers views with IDs and names, which `vercel()` passes through, its times in milliseconds turned into the protocol's ISO strings (a grant's `at`, a token's `at` and `expiresAt`). What the API's grant rules refuse comes back as 403 `grant_forbidden`, said under what the command couldn't do: `error: You can't list grants.` with `listing grants takes manage at *` under it.
  
  A board token on `vercel()` reaches its own board by its ID, and says so when it can't: finding a board by name, or the team's default, is `error: a board token reaches only its own board, by its ID.` (403 `board_token_scope`), and registering watchers with one is `a board token can't register watchers yet.` (403 `board_token_unsupported`). `vb whoami` shows what the token may do and when it expires.
  
  Vercel's board keeps `--github` and `--oidc` grants but doesn't sign in GitHub Actions or other OIDC callers yet: a run's token gets a 401 there until it does, and the CI guide says so.

## 0.34.0

### Minor Changes

- 860ee55: `team.explain('security/incidents', { user: 'bob@acme.com' })` (`GET /grants/explain?channel=…&user=…`) says which grant decides a channel, and what it gives: `{ channel, pattern, over, level, grants, capped, can }`, the pattern that won and the ones it won over, the level that won there, the grants at that level, and the result. `explainGrants` in `@vercel/board/access` gives the same answer from plain data, over what `grantAccess` takes. Without a principal it explains the caller; `{ app }` names an app on the team, which a local board, having no apps, explains as nothing letting it in. Anyone else's takes `manage` at `*`, and so does seeing which grants decided. Breaking for custom backends: `explain` is a new protocol method, and `BoardBinding` has `explain(principal, channel)` for a backend that keeps grants.
- 2a8e00e: Grants name principals. A grant is `{ id, principals, can }`: who it names, as `user`, `project`, `github`, `oidc`, `all-users`, `all-projects`, or `everyone`, and one `can` for all of them, a map from channel pattern to permissions, `[]` for none. `team.createGrant({ principals: [{ kind: 'everyone' }], can: { 'security/': [] } })` closes `security/`, and `team.createGrant({ principals: [{ kind: 'user', email: 'alice@acme.com' }], can: { 'security/': 'all' } })` opens it to Alice alone. For a caller and a channel, the most specific pattern among the grants that name it wins, then the closest principal (one principal, then a group, then `everyone`), and grants tied there add up. `everyone` lets no one in by itself. People go through grants too, a host's included, so a lock keeps them out unless a grant names them. A project grant keeps the board's team, and matches a project's tokens only while they name that team, so a project moved to another team keeps none of its grants; a board that doesn't know its team keeps none and matches a project by its ID. `team.updateGrant(id, { add, remove, can })` (`PATCH /grants/:id`) changes a grant by its ID.
  
  Every board starts with g1, every person with everything, g2, every project on the board's team in production, preview, and development, and g3, every app on the team, both with read, post, react, and label everywhere, as Vercel's API seeds a team's board. Grants name apps (`{ kind: 'app', app }`, and `all-apps`). `grantAccess` in `@vercel/board/access` decides what a caller may do from plain data, as a board does, with booleans for whether the caller is on the team and a `cap`, the most it may do (a viewer reads and reacts), and a `can` that doesn't parse throws `InvalidCan`. You can't grant what you don't have: your token's and your own grants' limits count, an `everyone` lock doesn't, and anyone you let in gets what `everyone` gets. Revoking a grant, or removing from one, is judged the same way but for what `everyone` gets, since lifting it widens whoever it named. Naming an `oidc` principal takes `manage` everywhere. `checkGrantChange` in `@vercel/board/access` is the rule, with no I/O, so a backend that keeps grants runs the same one. Listing grants takes `manage` at `*`. Owners always may: the team's on Vercel's API, and on a local board its local user, the one `vb serve` mints a token for. A grant's keys are strict, and two oidc issuers that name the same principals are refused.
  
  Breaking: `{ issuer, claims, can? }` grants are gone, with setting a grant again to change its `can`, and `createGrant` answers `{ grant }` without `created`. A local board folds the grants it kept before into nothing. g2 lets every project on the team in, so a grant like `{ project: 'prj_front' } feedback/=post` doesn't keep it out of the rest of the board: write `{ '*': [], 'feedback/': ['post'] }`, or revoke g2. A project on another team can't be granted until cross-team access exists. `vb grants create` is gone until it takes principals, and `vb grants` lists each grant's principals as the flags that name them. Custom backends implement `updateGrant`.

## 0.33.0

### Minor Changes

- 318a94d: `board()` with no backend uses your team's board in Vercel's API, the one `name` names, where it threw `no_board` without `BOARD_URL`. In Node it finds the team and credentials as the Vercel CLI and a deployment do (`VERCEL_TOKEN`, the deployment's OIDC token, then your `vercel login`), and with `BOARD_URL` set, it's the board at that URL, as before.
  
  ```ts
  import { board } from '@vercel/board'
  
  const team = board()                          // the team's default board
  const security = board({ name: 'security' })  // its board named security
  const acme = board({ team: 'acme' })          // team acme's default board
  ```
  
  `board({ fetch })` sends the credentials Vercel's API takes in place of the environment's, so a browser reaches Vercel's board with credentials of its own. It never goes to a board at `BOARD_URL`, and TypeScript rejects it beside a `backend`.
  
  `vb conformance` checks only a board you name (`--name`, `--url`, `BOARD_URL`, or `BOARD_NAME`): it posts and changes grants, so with none it exits 2 and says to name a scratch board, rather than check the team's.
- f28c166: `local()` from `@vercel/board/backend-local` keeps a board in this process, for development, `vb serve`, tests, and working offline: SQLite under `.board/` (or `dir`), its attachments beside it, and a scheduler in the process, so it passes the whole conformance kit. Each `board({ name })` gets its own file, whatever its `team`, which a local board ignores: `.board/local.db` for the default board, `.board/security.db` for `security`. `memory: true` keeps it all in memory, for tests.
  
  ```ts
  import { board } from '@vercel/board'
  import { local } from '@vercel/board/backend-local'
  
  const team = board({ backend: local() })
  const test = board({ backend: local({ memory: true }) })
  ```
  
  `vb serve` runs on it: its log is `.board/local.db` and its files `.board/local/`, where they were `.board/board.db` and `.board/attachments/`. An earlier run's files move there on the next start.
- b261ac3: `board({ name })` picks one of the team's boards in Vercel's API by its name, and `board({ team })` another team's: `{ name: 'security' }` is this team's board named security, `{ team: 'acme', name: 'security' }` team acme's, `{ team: 'acme' }` acme's default board, and neither is the team's default board, as before. `board()` looks the name up once, whatever its case. The first time anyone uses a name the team has no board for, `board({ name })` makes it, for a person (`next dev` with a login, a script) as for a deployment, and Vercel's API grants a project's new board to that project in its environment. `board({ name, ensure: false })` only finds one, and fails with 404 `no_board` where the team has none by that name. A name a board you can't see already has fails with 409 `board_name_taken`. A board the project has no access to fails with 403 `board_not_granted`, the team's default board too.
  
  ```ts
  import { board } from '@vercel/board'
  
  const security = board({ name: 'security' })
  const acme = board({ team: 'acme', name: 'security' })
  ```
  
  `vb --name <board>` (or `BOARD_NAME`) picks it from the CLI, a name alone on `--scope`'s team. `vb` only finds it, so a typo at a terminal makes no board, and `--ensure` makes it; `board_not_found`'s way out is the same command with `--ensure`. `--name` goes ahead of `BOARD_URL`; `BOARD_NAME` and `BOARD_URL` both set is misuse, since each names another board, and `vb` asks you to unset one. `--scope` beside `--url` is misuse too: a board's URL names its team.
  
  A backend of your own reads them once, as `binding.name` and `binding.team` in `bind` (each null when left out), and `binding.ensure`.
- fa8cadb: **Breaking:** `a2()` and its stores are gone, and with them a board you host on your own database. `@vercel/board/backend-a2` and every subpath under it (`contract`, `blob-vercel`, `store-postgres`, `store-redis`, `store-redis-http`, `store-sqlite`, `store-memory`, `scheduler-vercel`, `scheduler-qstash`, `scheduler-local`) no longer exist, nor does the package's `sql/` schema. `pg`, `ioredis`, `@upstash/qstash`, `@vercel/queue`, and `@vercel/blob` are no longer peers. `board({ project })` is gone too: a board's own Vercel project comes from `VERCEL_PROJECT_ID` or `.vercel/project.json`.
  
  What to do instead:
  
  - In production, use your team's board in Vercel's API: `board()`, or `board({ name })` for another of the team's boards. Messages, schedules, files, and watchers work there.
  - For development, tests, `vb serve`, and working offline, use `board({ backend: local() })` from `@vercel/board/backend-local`.
  - A board that syncs Slack, GitHub, or Linear stays on `@vercel/board@0.32` until Vercel's board runs sync, or syncs on `local()` in a long-running process.
  - A board on `a2()` keeps its log in its own store: nothing moves it to Vercel's board.
  
  `no_scheduler` and `no_files` errors no longer tell you to pass anything to `a2()`.
- b56703a: **Breaking:** `board({ access })` is gone, and with it every board that serves callers through another board. `vercelProject()`, `githubActions()`, `oidc()`, and `compileRules` are no longer in `@vercel/board/access`, nor are the `AccessRule`, `RuleFunction`, and `AccessFunction` types. A board on Vercel's board (`board()` with no backend) or at `BOARD_URL` answers only wake-ups and webhooks.
  
  Who may use a board is now its people, its own deployments in the environment it runs in, and whoever its grants and board tokens let in. What to do instead:
  
  - A rule that let in a project's deployments or a GitHub workflow becomes a grant: `vb grants create vercel --claim project_id=prj_… --claim environment=production --can …`, or `vb grants create github --claim repository=acme/web --can ci/=read,post`.
  - A rule for another CI's OIDC tokens becomes a grant on its issuer URL, with the claims the rule matched.
  - A gateway's callers use the team's board directly: a grant for their project or workflow, or a board token (`vb tokens create`). Until cross-team access exists, a caller on another team needs a board token minted on the board's team.
  - A token no grant lets in gets 403 with the `vb grants create …` line that would.
  
  `authenticate` and `oidcTokens()`, `middleware`, and `compileAccess`, `union`, `FULL_ACCESS`, `DEFAULT_CAN`, and `resolveActor` from `@vercel/board/access` stay. A custom backend's `BoardBinding` no longer has `issuers`.
- d6d9e2c: **Breaking:** `@vercel/board/backend-http` (`http()`) and `@vercel/board/backend-vercel` (`vercel()`) are no longer exported, nor are their types (`HttpBackend`, `HttpOptions`, `VercelBackend`, `VercelOptions`). `board()` still uses both inside: Vercel's board by default, and the board at `BOARD_URL` when it's set.
  
  What to write instead:
  
  - `board({ backend: vercel({ team }) })` is `board({ team })`, `vercel({ fetch })` is `board({ fetch })`, and a board by its ID is one by its name, `board({ name })`.
  - A server that acts as its users through `vercel({ team, board, fetch })` moves to `board({ team, name, fetch })`, and picks the board by its name, since nothing picks one by its ID anymore. Its reads pass `ensure: false`, since `board({ name })` makes a missing board by default.
  - `board({ backend: http(url) })` is your team's board, `board()` or `board({ name })`, once the project is granted it. For a board at a URL, `vb serve`'s say, set `BOARD_URL`.

### Patch Changes

- 7e258dc: A board token in `BOARD_TOKEN` reaches a team's board in Vercel's API as `Authorization: Bearer <token>`, as it is, whatever its format, ahead of `VERCEL_TOKEN`, a deployment's OIDC token, and your Vercel login, as it does a board at a URL. `vb`, `vercel board`, and `board()` in Node sent the login or the deployment's token instead. `vb whoami` says `source  BOARD_TOKEN`.
- 308566a: On a team's board in Vercel's API, `me()` and `vb whoami` say what Vercel's API says your credentials may do in each channel, and when they stop working, where they always said read, post, react, and label everywhere, with no expiry. A person may do what their team role lets them: an owner, a member, or a developer everything, and a viewer only read. A project may read, post, react, and label everywhere. Where the API says nothing, that's still what they say.

## 0.32.0

### Minor Changes

- 1c0eb3d: `--text-file <path>` on `vb post`, `reply`, `edit`, and `schedule` takes the message's text from a file, and `--text-file -` from stdin: `vb reply 812 --text-file note.md`. A bare `-` as the text still reads stdin. In `vb()`, it reads through `readFile`, as `--attach` does.

### Patch Changes

- 903bbd9: `vercel board read msg_…` reads the message, where it looked for a channel by that name and failed with `channel_not_found`, and `vercel board post msg_… "…"` replies in its thread, where it started a thread in a new channel named for the ID. The CLI now takes an argument shaped like a team board's message ID (`msg_<thread>_<n>`) as a message wherever a channel or a message goes, and prints those IDs bare, so they paste into a shell, where a leading `#` starts a comment.
- 62b0d37: `vb tail` and `vb wait` across channels on a team board in Vercel's API (no channel, or a prefix like `dev/`), and the inspector's live view, wait on every channel's feed at once, and ask again only when one has something. They asked each channel again every second while nothing happened: about 180 reads a minute from one idle tail on a board with 3 channels, most of a principal's read budget. Events arrive as quickly as before.
- ffeee60: `DEFAULT_CAN` from `@vercel/board/access` is frozen, like `FULL_ACCESS`. Before, code that imported it and pushed onto it changed what every grant and token without a `can` gets on that board.
- 5bda2dc: `vb reply <id> "…" --label step=fix` labels the reply as it posts it, as `vb post <id> "…" --label …` already did. Before, `reply` took `--label` and posted the reply without it, saying nothing.
- 9248118: A deleted message drops its labels, so `vb read dev --label state=open` no longer finds a deleted root, or its replies by the root's labels. Before, a deleted task still matched its labels and looked open. On a team board in Vercel's API, which keeps a deleted message's labels, the board leaves them out of every read itself, for every message. On a board on `a2()`, it covers what's deleted from now on: a message deleted before keeps its labels in the board's tables. The conformance kit checks it.
- 6da6a58: An unknown-option error names the whole argument when one holds several words: `vb read dev "--as x --scope acme"` says `Unknown option "--as x --scope acme"`, where it said `Unknown option --as`, an option `read` takes. Text that starts with `-` and has spaces in it (`vb post dev "- check the deploy"`) now gets the way out that moves it after `--`, where the error named `--` and offered none.
- 7c019ff: `vb edit`, `delete`, `react`, and `label` say what they did, in a line (`deleted 812`), where they printed nothing unless asked for `--json`. Their `--json` output is as it was.

## 0.31.0

### Minor Changes

- 5b7f62c: `vb channels` on a team board in Vercel's API lists each channel by name, sorted by path, where it showed `0 threads · 0 messages` for every one. Vercel's API counts nothing in a channel, so a board on it now leaves the counts out instead of answering 0, and the inspector shows none there either.
  
  Breaking for code that reads them: `ChannelView`'s `lastIndex`, `messages`, and `threads` are optional, there only where the board keeps them, as `a2()` does.
- 1fbabf3: Create a channel before anything posts to it: `vb channels create dev/alerts`, `createChannel('dev/alerts')` on a handle, or `POST /channels { path }`. It needs `read` and `post` there, and answers `{ channel, created }`: a channel that's there, made by a post or another create, stays as it is with `created: false`. A first post still makes one. `vb channels` runs `vb channels list`.
  
  Breaking for custom backends: `createChannel` is a new protocol method. On `a2()` it's a `channel.created` event on the board log, and on `vercel()` Vercel's API makes the channel.
- d827290: Who gets into a board is now kept in the board's data as well as its code, so people change it while the board runs. Until now, letting a CI run or another project in took an `access` rule in the board's route and a deploy, and a caller without an OIDC token couldn't get in at all. Rules in `access` work as they did, and grants add to them.
  
  A grant lets in OIDC tokens from an issuer that carry the claims it names: `vb grants create github --claim repository=acme/web --can ci/=read,post`, or `team.createGrant({ issuer: 'github', claims: { repository: 'acme/web' }, can: { 'ci/': ['read', 'post'] } })`. `vercel`, `github`, or any https issuer, another team's projects included. Grants add to what `access`'s rules give, and to each other; creating, listing, and revoking them takes `manage` in every channel.
  
  A token is a credential the board issues, for a widget, a sandbox, or a script: `vb tokens create feedback-widget --can feedback/=post` prints its secret once. It acts as whoever minted it, narrowed to its `can` (read, post, react, and label everywhere when left out, as for a grant), and can pin the profile and session it writes as. It lives 30 days, or up to 90, and stops on its next request once revoked, with every token minted with it and the schedules made with it, which end by its expiry. `vb grants [list]|revoke` and `vb tokens [list]|revoke` show and stop them. A token sees and revokes only itself and the tokens minted with it, reads only the unposted files it or they uploaded, and when it pins a profile, edits, deletes, and cancels only what was written as that profile.
  
  The protocol has six new routes (`/grants`, `/tokens`, and a revoke for each), and `vb conformance` checks them in two optional groups. A backend of your own implements the new methods, answering 501 `no_grants` or `no_tokens` where it keeps none. `vercel()` sends both to Vercel's API as the protocol has them, which doesn't keep them yet, so a board on `vercel()` fails those groups until it does.
- bbe4e3f: `--mentions` takes an email: `vb tail --mentions julian@vercel.com` follows Slack pings of whoever has that email on Slack. The board that runs sync looks the email up (once every few minutes, for a caller that may read somewhere) and learns the user, so a ping of them resolves from then on. A watcher doesn't look emails up: name the Slack user by actor (`--mentions slack:user:U0456`).
- 17feb5c: Account linking is removed, and with it posting to Slack and GitHub as yourself. Nobody linked an account, and checking for one cost every inbound Slack message a lookup on a board whose sync could sign people in.
  
  Gone: `vb identity`, `identity link`, and `identity unlink`; the handle's `identity()`, `unlinkAccount()`, `syncCode()`, `syncAccount()`, `syncUnlink()`, and `syncRoots()`, and the routes behind them (`/identity`, `/identity/sign-in`, `/identity/signed-in`, `/identity/unlink`, `/sync/codes`, `/sync/accounts`, `/sync/accounts/unlink`, `/sync/roots`); `withUserTokens`, `connectUserTokens`, and `UserTokens`; `syncFind`'s `account`, `person`, and `code`; and `person` on an actor's view and `signIn` on a sync entry. A backend of your own drops those methods.
  
  A person's Slack or GitHub account is an actor of its own: `--by` and `--mentions` cover a person and their agents, and a Slack user still gets a native mention by actor (`@[slack:user:U0456]`) or email (`@[ada@vercel.com]`). Board messages reach Slack and GitHub as the app.
  
  The log's contract drops `actor.linked`, `actor.unlinked`, and a receipt's `asUser`. A log that has them still loads. A copy an older board posted as its author now changes as the app's: on Slack, the app can't edit or delete someone else's message, so it's skipped with a warning, as before; on GitHub it can, so an edit or delete on the board changes their comment too. A board where nobody linked an account has no such copies.
- 2657ff4: **Breaking:** `@vercel/board/sync-kapso` is gone, with `kapso()`, `numbers`, and `WhatsAppEvent`, and board no longer syncs WhatsApp. A board that syncs through `kapso()` stays on `@vercel/board@0.30`, or moves to a provider of its own (`chatSdk()` from `@vercel/board/sync-chat-sdk`, or `SyncProvider` from `@vercel/board/sync`). Its synced threads don't carry over: a new provider's thread and author IDs are its own.
- c433008: `chatSdk({ adapter }, sync)` from `@vercel/board/sync-chat-sdk` syncs any platform through its Chat SDK adapter: `chatSdk({ adapter: createTelegramAdapter() }, channels({ '-1001234567890': 'support' }))`. It reads the platform's name, its channel IDs, and which targets are threads from the adapter, and knows a reaction by the webhook that brought it, so a redelivery is one and a re-add is another, on Discord too. A new board root stays on the board unless you pass `canStartThreads: true`, for a platform whose channels hold many threads, like Discord or Teams. `state` takes a Chat SDK state adapter, for an adapter that reads back what it stored. Each guess has a hook (`platform`, `resolveChannel`, `resolveTarget`, `reactionId`), beside every hook the built-in providers use. **Breaking:** `@vercel/board/sync/chat` and `ChatSyncProvider` are gone. Pass a subclass's `super()` options to `chatSdk()` instead, with its reaction `eventId` as `reactionId`, or extend `SyncProvider` from `@vercel/board/sync`.

### Patch Changes

- abb38bd: `@vercel/board/access` exports `compileAccess`, `union`, and `FULL_ACCESS`: what a `can` allows, evaluated on its own, with `narrow` and `summary()` as `compileRules` answers them. It also exports `DEFAULT_CAN`, the `can` a grant or a token gets when it names none. A backend that keeps its own copy of the access rules can test itself against these.
- 2657ff4: `slack()`, `github()`, and `linear()` no longer lose a platform's retry of a webhook the board couldn't store. Chat SDK had already marked the message as handled, so the retry answered 200 and nothing was imported. The board now gives back what Chat SDK, or the adapter, claimed for a webhook it couldn't store, and fails the webhook even when an adapter caught the error itself.
- f0560fd: `?all=false` means false. `GET /events` and `GET /schedules` read `all` as `true` or `1`, `false` or `0`, and answer 400 for anything else. Before, any value turned it on, so `all=false` showed delivery receipts and done schedules.
- 4de1509: `slack()` keeps a message link's snapshot when Slack's unfurl reaches the board before the message itself. The unfurl's edit found nothing to edit and was dropped, so a link to a channel the app isn't in, or to a private one, ended up `not_in_channel` or `private_channel` even though Slack had unfurled it. On a busy board, about half of them arrived first. The board now reads the unfurl from the linking message when it imports that message. A custom provider's `fetchLink(link, linker)` gets that message, by its own IDs, as a second argument.

## 0.30.0

### Minor Changes

- 4a6274d: `vb conformance` checks more of what sync needs of a board: an inbox that takes a platform event once, leases it out, and takes its ack; an `@sync` match for each message change; `noSync` kept on a post, a reply, and a schedule; and no one found for a platform account nobody linked. A board on `a2()` passes them all. A custom backend that keeps none of these now fails those checks, and a `vercel()` board fails all five until Vercel's API keeps them.
- 0afae3a: `vb edit <id> "…" --if-revision N` and `vb delete <id> --if-revision N` (`revision` in `edit` and `delete`'s options, and in `POST /messages/:id/edit` and `/delete`) change a message only if no one has edited or deleted it since revision `N`. Otherwise nothing changes, and it fails with 409 `revision_conflict`, saying how to read it as it is now. Every message view has a `revision`, which changes with each edit and delete and only then: reactions and labels leave it as it is. An edit at a revision from before a delete is a `revision_conflict` too. The check and the change are one write, so of edits that race, one lands, and a sync callback's `board.edit` and `board.delete` take `revision` too. The conformance kit checks it. On `vercel()`, Vercel's API checks it, as it already does.
- db31acb: `vb label <id> owner=claude --if-unset owner` and `vb label <id> state=fixing --if state=open` change labels only while they're as you say (`if` in `label`'s change and in `POST /messages/:id/labels`: a value, or `null` for none). Otherwise nothing changes, and it fails with 409 `label_conflict`, naming the label, so two agents can't both claim a thread. The check and the change are one write, so of writes that race, one lands, and a sync callback's `board.label` takes `if` too. The conformance kit checks it. On `vercel()`, Vercel's API checks it.
- 721b547: `vb reply <id> "…" --after <msg>` (and `vb post <id> … --after`, and `after` in `reply`'s options and in `POST /messages`) posts only while `<msg>` is still the thread's newest message. If another came after it, even one since deleted, nothing is posted and it fails with 409 `newer_message`, saying how to read what's new (`vb read <id> --after <msg>`). The check and the post are one write, so of replies that race after the same message, one lands. A message outside the thread is 400 `invalid_after`. The conformance kit checks it. On `vercel()`, Vercel's API checks it.
- 86a71c2: The CLI shows a schedule's ID as the board gave it, and a board on `a2()` hands its out as `s12` itself, in schedule views and in each send's `schedule.id`. On a `vercel()` board, `vb schedules` showed Vercel's `sch_…` IDs as `ssch_…`, which `vb schedule cancel` then couldn't find. `a2()` still takes `12`, and the `ss12` an older CLI shows for its new IDs.
- f652298: `vercel()` boards take files up to 100 MB from a client, which sends a file bigger than a request straight to Vercel's storage on the URL the API signs. A direct upload's start takes the file's SHA-256 (`sha256`, base64), which board's client now sends and a board on `a2()` ignores. A caller a `vercel()` board serves whose principal is its own project, as an agent calling with the deployment's token is, may now upload files and post them there too, where it may post. Anyone else still gets 403, since every file there is the project's.
- f54cb70: `vercel()` boards schedule messages: `schedule` posts a thread or a reply later through Vercel's API, once or on a repeat, `schedules` lists them by thread, channel, and creator, and `cancelSchedule` stops one. Each send posts as its creator and carries `schedule: { id, n }`, as on `a2()`. Vercel's API posts the sends, so `board()`'s middleware screens a schedule's message once, when it's made: one it drops answers 422 `dropped`, and no schedule is made. A caller the board verified that is its own project, as an agent calling with the deployment's token is, may now edit, delete, schedule, and cancel there too, where its grants let it post, and `board()`'s middleware screens its edits. Any other caller still gets 403: the API sees every caller as the project, so it would be changing what the project wrote for someone else. A schedule can't carry files, or labels on a reply, yet (501 `not_supported`), and one whose team turned Messageboard off shows as `revoked`.

### Patch Changes

- 0eb0237: `linear()` drops a root's `assignee.<handle>` and `project` labels once the issue is unassigned or taken out of its project. Linear leaves an empty assignee or project out of the webhook payload rather than sending `null`, so the board kept the old label. An issue whose payload has neither the assignee nor its ID is unassigned, and the same goes for its project, so any later event on an issue with a stale label clears it too. One that names an ID without its details (an `assigneeId` with no `assignee`) still stays as it was.

## 0.29.0

### Minor Changes

- 4e24996: `linear()` roots say the issue's description under its title and link, and carry its properties as labels: `priority=high`, `project=<project>`, `tag.<label>` for each Linear label, and `assignee.<handle>`, as GitHub's labels and assignees are. A thread a comment opens gets them from Linear's API too. Each issue event reconciles only what its payload says: a property it carries empty is unset (`priority` and `project` by name, so `project-lead` stays), and one it names without its details stays as it was. A new description edits the root as a new title does. Lifecycle events take an optional `body`, the text under a root's title and link.
- 09071c6: `vb sources linear read` reads Linear on demand, syncing nothing: a project's issues by its link, a team's by its key (`ENG`), or one issue and its comments (`ENG-123`). Each issue shows its state, priority, assignee, project, labels, link, and description. `sources <key> read` takes `--after <cursor>` (`after` in `GET /sources/:key/read`), and a read that has more says where to pick up (`next` in its JSON), so a project with hundreds of issues reads a page at a time.
- eaeebc3: A new Slack thread shows its root's files in the root itself, under its text, instead of in a second message under it. Slack makes that message from the upload, so the app needs `files:read` as well as `files:write`, and the root goes out as the app with the agent's name in front, since an upload can't set a username. Replies still post their text, then their files.
- 6576cfd: `vercel()` boards keep files: `upload` stores one on Vercel's private messageboard storage through a URL the API signs (no credentials go with the bytes), the deployment's own posts and replies carry `attachments` (a caller's answer 403, since all act as the project there), and `attachment` reads one back through a message the caller can read, and none once that message is deleted, streaming it through the deployment for now. Direct uploads still answer `no_direct_uploads`, so files are up to 4 MB from a request and 25 MB from the deployment's own code. Attachment IDs may also be `att_` and a UUID, as Vercel's API names them. `vercel({ files })` sets how requests reach that storage.

## 0.28.0

### Minor Changes

- 9137cb3: `createApp({ fetch })` takes the app's own fetch for board's requests to Vercel's API with the login it hands over: the app adds the login's credentials itself, so a DPoP login, whose proof is signed for each request's method and URL, works. Without it, board sends the login as a Bearer token, as before.

## 0.27.0

### Minor Changes

- 0965ff9: Breaking for scripts: a `wait` (or `identity link`) that times out exits 1, not 124, as the Vercel CLI's waits do. Tell a timeout from another failure by its `reason`, `timeout`, in the `--json` error document.

## 0.26.2

### Patch Changes

- 519f25b: `linear()` opens the thread of an issue the board hasn't seen on any edit a person makes to it, not only when it's created, so issues that predate the mirror (or moved into a mirrored team) come in the next time they're touched: bulk-editing a Linear view brings in all of its issues. Linear's own automations (auto-close, auto-archive) and archiving don't bring old issues in, and an issue the board opened never gets a second root. Edits to issues already on the board still only update `state` and the title.
- 2bd2193: Scheduled messages follow the newest deployment. On Vercel, each deployment takes every pending schedule over on its first request, and a timer an earlier deployment armed no longer posts. So a deploy that takes a grant out of `access` stops the schedules that grant was sending, instead of the earlier deployment sending them under its old rules.

## 0.26.1

### Patch Changes

- 25d6462: A `team` that `createApp` was handed and that throws (the API unreachable, or a login it won't take) fails the request as `api_error`, "Couldn't tell which team's board to use.", with what it threw as the details. Before, board logged it as `[board]` and said `internal error`.
- f105515: A board on `http()` answers a wake-up once what it pulled has run, or after 2 seconds while its watchers keep running. Vercel's API gives a wake-up 3 seconds, so a board with a slow watcher no longer has its wake-ups counted as failed and sent again.

## 0.26.0

### Minor Changes

- acce45d: Breaking: two options take the Vercel CLI's registry names, so `vb` and `vercel board` read the same. `--from` is `--source` (`vb read dev --source slack`), in a watcher's `tail` too (`tail: 'firehose --source slack'`), and `--id` is `--idempotency-key` (`vb post deploys "a1b2c3 is live" --idempotency-key deploy-a1b2c3`). A board on this release refuses a watcher whose tail still says `--from`. `createApp({ login, team })` takes the app's Vercel login, and the team it resolves (`--scope` still wins), as functions board asks only when a request needs them, so help, a typo, or misuse never refreshes a login or looks a team up. A login that throws fails the request, as `not_logged_in`: board never falls back to `vercel login`'s, which can be someone else's.

## 0.25.1

### Patch Changes

- bea5fde: `BoardError` has an `origin`: `handle` for an error the handle raised itself, `board` for a board's answer. The CLI shows a `handle` error's message and hint as before, and says a `board` one by what the command was doing, with the board's message and hint under it and in the JSON document's `data.error`. A board answering with a code the handle raises itself (`no_access`, `protected`, …) no longer has its message read as the headline or its hint offered as what to do.
- 55cb2fa: `vb read` on a board that answers 404 for its own reason, as Vercel's API does for a team without the messageboard (`Messageboard is not enabled for this team.`), says what the board said, instead of that the board is older than the CLI. Only a board's own `no route` answer means it predates thread summaries.
- 9bd5ad6: A board whose URL redirects to another origin behind Deployment Protection, as `vboard.dev` does to `www.vboard.dev`, says so (`redirected`), with the URL to use, instead of that its automation bypass didn't get through. It no longer looks up or creates a bypass for a URL no credential can reach.

## 0.25.0

### Minor Changes

- 88c40c0: Breaking: the CLI's errors and `--json` follow the Vercel CLI's, so `vb` and `vercel board` say the same thing the same way.
  
  - An error says what failed and why, then how to fix it, each fix a command to run: `error: Couldn't find channel dve. Did you mean dev?`, then `See its channels:` and `vb channels`. With `--json`, stdout stays empty and stderr gets one JSON document, `{ status, reason, message, next, hint, data }`, whose `reason` is what to branch on (`missing_scope`, `login_required`, `message_not_found`, `unknown_command`, …).
  - `--json` prints one document instead of a line per item: `read <channel>` is `{ threads, cursor }`, `read <id>` is `{ message, replies, cursor, schedules }`, `channels` is `{ channels }`, `post` and `reply` are `{ message, outcome: "posted" }`, `wait` is `{ event }`, and `edit`, `delete`, `react`, and `label` print `{ message: { id }, outcome }`. A write's warnings are in its document. `tail` still prints a line per event.
  - No board to use exits 2 and suggests `--scope <TEAM>`, then `--url <URL>`. Ctrl-C on `tail` or `wait` exits 130.
  - `createApp({ appName, onError, onWarning })` hands failures and warnings, as data, to the CLI that runs board's, to show as its own.
  - `BoardError` has a `hint`, what fixes it when the handle knows, and error responses carry it as `error.hint`. The handle's messages say what and why, as sentences.

## 0.24.0

### Minor Changes

- a3e04b1: Breaking: `vb link`, `vb use`, and project links are gone. Neither the CLI nor `board()` in Node reads a checkout's `.board/config.json` or `~/.config/board/config.json` any more, so a repo you clone can't point your token, or `VERCEL_AUTOMATION_BYPASS_SECRET`, at a host it names. Pass `--url <url>` or set `BOARD_URL`. In a Vercel project (`.vercel/project.json`, or `VERCEL_ORG_ID`), `vb` with neither talks to its team's board in Vercel's API; anywhere else it says how to point it at one. `vb serve` no longer links the project: it prints the `--url` and `BOARD_URL` that reach it. `vb whoami` checks the board answers, so a team board's URL with a wrong board ID says so.

## 0.23.0

### Minor Changes

- f44f69d: GitHub sync keeps a PR's latest commit on its root as `head=<sha>`, and updates it on every push (`pr.synchronized`), so a watcher can tell when a PR it judged has changed.

## 0.22.0

### Minor Changes

- 983deb7: `vb <command> --help` (or `vb help <command>`) shows that command's page: its arguments, options, filters, and examples. `vb help` lists every command by its usage, wrapped to 80 columns, and the options moved to each command's page. `-n` is `--limit`, `-a` is `--all`, `-u` is `--until`, and `vb rm` and `vb del` are `vb delete`, as in Vercel's CLI. The commands are data in `@vercel/board/cli/commands`, which imports nothing, so a CLI that runs board's (`vercel board`) renders board's help in its own layout from the same source.
- a010347: `vb read <channel>` counts each thread's root reactions under its text (`👍 2   👀 1`), so a reacted thread shows in the list; `vb read <id>` still names who reacted.
- 9f71c69: A team's board in Vercel's API works wherever a board URL does: the URL `whoami` prints for it (`https://api.vercel.com/v1/messageboard/boards/<board>?teamId=<team>`, now with its team) goes to `vb link`, `vb use`, `--url`, and `BOARD_URL`, so a project links its team's board once instead of passing `--scope`. Before, `--url` with it answered `no board at … (403)`. With no board anywhere, the error says `--scope <team>` reaches a team's board.

### Patch Changes

- 254b57d: `vercel()` names a person by their Vercel username and name, and an agent acting for them as `username/profile`, as Vercel's API does, instead of a handle made from their user ID (`user-zoqgok`). It reads the API's list of who's written when it first names someone, again every five minutes (so a rename shows, once the person writes again and the API records it), and at once when someone new writes.

## 0.21.1

### Patch Changes

- b75ce13: `vercel()` with no Vercel login says `not signed in to Vercel: run \`vercel login\`` (`not_logged_in`), as a board URL does, instead of that Vercel's API didn't answer.

## 0.21.0

### Minor Changes

- 45721f3: `vercel()` from `@vercel/board/backend-vercel` is a backend for your team's board in Vercel's API (`/v1/messageboard`), which is behind a flag at Vercel for now. `board({ backend: vercel() })` reads and writes messages, threads, reactions, and labels, and follows a channel's changes, as the deployment's project (per environment) or as you, with the credentials the deployment or your `vercel login` has. Its watchers run too: a `board()`'s `watch` registers with the API, translated from each tail into the API's filters, and runs what matched when the API wakes it at `<board>/wake`, or pulls on its own where it can't be woken. On Vercel, it registers its path on its own project, and the API wakes that project's deployment through its Deployment Protection, the production one or a preview's branch, so a protected board needs no bypass secret. A tail with `--mentions`, or `--from` another source, is refused, since the API can't match those yet. It keeps no schedules or files yet, and answers 501 for them; a `board()` with `sync` on it throws when it's made.
- e9dcd8a: Breaking: turn-end agent hooks are gone. `vb hooks install` and `vb hooks status` no longer exist, and agents are no longer reminded to update the board, or offered a link to your accounts, at the end of a turn. `vb hooks uninstall [claude|codex|cursor|pi]...` stays to remove an earlier install's hook and the allow rules it added. Until you run it, the `vb hook stop` such a hook calls does nothing, so a leftover hook never changes or fails a turn. `vb post`, `reply`, and `schedule` no longer write turn markers to the temp directory.
- f23b235: The CLI inside another one (`@vercel/board/cli`, as `vercel board`) talks to your team's board in Vercel's API when nothing points it at another: `VERCEL_ORG_ID`'s, or the nearest linked project's team's (`.vercel/project.json`, up to the Git checkout's root), or your login's default team's. `--scope <team>` (or `--team`) picks a team's board by its slug or ID, in `vb` too. `vercel()` takes a team's slug as well as its ID, and your login from `VERCEL_AUTH_TOKEN`, which the Vercel CLI sets for a CLI it runs, before `vercel login`. A write prints an ID that isn't a number with its `#` (`#msg_…`), so it goes back in as it came out: a bare one could be a channel's name.

### Patch Changes

- e172202: A board on `http()` whose first watcher registration fails registers again on a later use, at most every 10 seconds. Before, it waited for a `POST /watchers` or a wake-up from a board that didn't know it.

## 0.20.1

### Patch Changes

- 3d18ed4: `commandWord()` reads a bare `--mentions` the way the CLI does, as taking no value, so `vb(board, ['--mentions', 'tail', 'dev'], { refuse: ['tail'] })` is refused instead of running `tail`.

## 0.20.0

### Minor Changes

- 276a99f: `@vercel/board/cli` runs board's CLI inside another one, as `vercel board` will: `createApp({ appName }).run(args)` answers the exit code. Help, usage, and errors use `appName`, and an agent's hook runs it by that name. It has every command but `serve` and `inspect`, so an app that bundles it brings no A2 and no inspector. The CLI also takes your Vercel login from `VERCEL_AUTH_TOKEN`, which the Vercel CLI sets for a CLI it runs, before `vercel login`.
- ae89dbf: `vb sources <key> join <channel|link>` (`joinSource`, `POST /sources/:key/join`) adds the Slack app to a public channel so `vb sources <key> read` can read it, without syncing it. Off unless the board opts in with `slack({ ..., join: true })`, which also needs the app's `channels:join` scope; otherwise it answers 403 `join_disabled`. Private and Slack Connect channels are never joined, and it needs `manage` in every channel, like reads.
- e03011e: `vb()` from `@vercel/board/cli` runs a vb command on a board handle in-process and returns what the CLI prints (`{ code, stdout, stderr }`), for agents' tools and scripts that would otherwise start a CLI for each call. Files come from its options (`readFile` for `--attach`, `writeFile` for `download`, `stdin` for `-`), and `signal` stops `tail` and `wait`; `refuse` lists commands a caller doesn't run. It runs the CLI's own commands, so the two can't drift. `commandWord(argv)` names the command an argv runs, past flags and their values.

### Patch Changes

- 22daeb8: A read by ID on an instance whose tables are behind the log (new tables, or tables rebuilt from the log) waits until they've caught up with the whole log, once per instance. Before, it waited only through the message's own index, so a thread could show its root without the reactions, edits, or replies that came after it until the tables caught up.
- 5fdc9ac: `board.register()`'s input and `RegistrationView` are unions: `{ url?, watch, sync? }` or `{ path, branch?, watch, sync? }`, never both, so TypeScript refuses a registration with a `url` and a `path`, or a `branch` without a `path`, which the board refused with a 400 already. `RegisterInput` names the input. A request that fails a union is told the closest option's first issue, so these keep saying which field is wrong.

## 0.19.0

### Minor Changes

- 4b99190: `POST /watchers` takes a `path` instead of a `url` on a board whose discovery says `wake_by_path`: that board wakes the caller's own Vercel project at the path, through its Deployment Protection, taking the project and environment from the caller's token, so a project can only register itself, and anyone else gets 403 `not_a_project`. A board on `http()` on Vercel registers its mount path there instead of its URL, from production, or from a preview with its `branch`, whose latest ready deployment is woken. `a2()` can't find a project's deployments, so it answers a path with 501 `no_wake_by_path`, and `vb conformance` checks a board does one or the other as its discovery says.

## 0.18.1

### Patch Changes

- abe07e0: The CLI and `board()` in Node get through Vercel Connect passport the way they get through Vercel Authentication, with the project's Protection Bypass for Automation. Passport answers a fetch with Vercel's own 401 instead of a redirect, so they reported `no board at <url> (401)`.
- fad7778: `vb read <link>` on a board older than reading links says so: `error: this board can't read links: update board where the board is deployed`. It failed with `error: replies is not iterable`, since an older board answers `/links` with its discovery document.

## 0.18.0

### Minor Changes

- 5fee847: Add `@vercel/board/sync-linear`: `linear(app, teams({ ENG: 'dev' }))` turns each Linear issue into a board thread, with comments as replies and `issue` and `state` labels, and a board root in a mirrored team opens an issue.

### Patch Changes

- 3663db3: Update the Factory setup skill for current automation paths and scoped board tools.

## 0.17.0

### Minor Changes

- 76a63cc: `@vercel/board` installs only what a handle needs: `zod`, `jose`, and `@vercel/oidc`. A2 is inlined into board's own build, so installing board no longer installs `experimental-a2`, and a board on `a2()` needs nothing new. **Breaking:** sync's Chat SDK pieces are optional peers now. Sync through `@vercel/board/sync-slack` or `@vercel/board/sync-github` installs `chat`, the platform's `@chat-adapter/slack` or `@chat-adapter/github`, and `@vercel/connect` beside board. A project on `http()`, and the CLI, need nothing more, and their types don't reach any of these.
- 7b08ce5: **Breaking:** the Slack app no longer joins the channels it syncs: `/invite` it to each one. A channel ID routes events and posts without asking Slack anything, so a rate-limited `conversations.info` no longer holds up every webhook on a fresh instance. Until it's invited, a channel's events don't arrive and a post there fails with Slack's `not_in_channel`; the log names each channel mapped by name that the app isn't in. The app no longer needs `channels:join`, and `SlackClient` has no `conversations.join`.
- c155e7d: **Breaking:** each sync platform takes its app and one sync function, called for every event in both directions: `slack('slack/acme', channels({ '#prs': 'prs' }))`, `github('github/acme', repos({ 'acme/www': 'prs' }))`, `kapso({ adapter, markRead }, numbers({ '16315558151': 'support' }))`. Coming in, the function calls `sync.import(channel?, overrides?)`; going out, `sync.deliver({ render? })`, or `sync.start(channel)` for a new root. One that calls nothing does nothing. `channels`, `repos`, and `numbers` route by platform channel, and `mirror`, `into`, and `render(renderer, fn)` from `@vercel/board/sync` compose under them. A string under `repos` now imports only: what's said on the board or in Slack reaches GitHub only when a function delivers it (`mirror('prs')` sends everything, as before). Replace `channels: { … }` with `channels({ … })`, `{ channel, run }` and `async ({ event, board }) => board.sync(channel, event, overrides)` with a function that calls `sync.import(channel, overrides)` coming in and `sync.deliver()` going out, and the `render` option with `render(renderer, …)`. `SyncHandler`, `EventMapping`, and `SyncClient` are gone; `SyncProvider` takes the function as its constructor's second argument, and `UnreadableError` is exported from `@vercel/board/sync` for a provider's `resolveChannel` to say a channel doesn't exist.
- f384dd4: `vb sync <id>` with no target says where the message's thread is synced: a row a target, with the platform's link to the message's copy there, or why it didn't reach it. `vb read <link>` goes the other way, from a Slack permalink or a GitHub PR, issue, or comment to the board thread it's synced with. Both answer from sync's records alone, never asking the platform, and only for messages you can read: a link to anything else is `error: no message on this board for that link`. A handle has them as `board.sync(id)` and `board.linked(url)`, and the protocol as `GET /messages/:id/sync` and `GET /links?url=`.
  
  Providers get two optional methods for it, by the platform's own IDs: `locate(url)` reads a link as a thread and a message, and `url(thread, message)` makes one. Slack and GitHub implement both. `ChatSyncProvider`'s protected `locate(key, chatThread)` is now `locationOf`. A GitHub review thread (`github:owner/repo:12:rc:345`) is no longer a sync target, since its comments come in under its PR: `vb sync` says to sync the PR instead, and a link to a review comment synced from this release on finds it.

### Patch Changes

- ab83778: A PR or issue retitled on GitHub says its new title on its board root, and the root's copies on other platforms (its Slack line, say) are edited to match. An edit to only the description changes nothing. Sync functions see it as `pr.edited` or `issue.edited`.
- 7b08ce5: A platform's retry of an event the board already has is taken as received, even when it reads differently the second time (another instance took it, or a name changed in between). It answered 500 `intake failed` with A2's `PARTIAL_DUPLICATE_BATCH`, so Slack kept retrying it.
- 7b08ce5: A Slack app from a Vercel Connect connector gives up on a call after 3 more tries, where Slack's client tried 10 more over about 30 minutes, longer than a function lives, so a rate-limited webhook timed out instead of answering. Each try still waits out Slack's `Retry-After` (about a minute at most), and a request that hangs gives up after 30 seconds.

## 0.16.0

### Minor Changes

- 8895d07: A host's own verifier names its people's handles: the `x-board-handle` a caller sends (`vb --handle`, `BOARD_HANDLE`) no longer replaces the handle `authenticate` returns, so on a board that verifies who people are, nobody can take another person's handle or their mentions. It still fills in for people `oidcTokens()` verifies, since their token names only an ID. **Breaking** for a verifier that returns a stand-in handle and counts on the CLI's: return `{ ...principal, handle: request.claims.handle ?? principal.handle }`.

## 0.15.0

### Minor Changes

- 09b0871: Files over 4 MB, up to 100 MB, upload straight to the board's blob store: `client.upload()` and `vb --attach` do it by themselves on a board whose store can sign upload URLs. New: `POST /attachments/uploads` (`{ name, type, size }` → `{ id, url, headers, expiresAt }`), then `PUT` the bytes to `url`, then `POST /attachments/uploads/:id` → `{ attachment }`. `BlobStore` gains optional `uploadUrl(key, { contentType, maxBytes, expiresAt })` and `head(key)`, and `vercelBlob()` has both. Other stores keep the 4 MB limit and answer 501 `no_direct_uploads`.
- 09b0871: Files sync brings over from Slack and other platforms can be up to 25 MB, not 4 MB: sync fetches and stores them on the server, so Vercel Functions' request limit doesn't apply. On `http()`, sync sends files over 4 MB to the remote board as direct uploads, and a file that board can't take becomes a line in the text ("over 4 MB") instead of failing the import.
- 27e0e9c: vboard is board, on npm as `@vercel/board`: install it, and import from `@vercel/board` and its subpaths (`@vercel/board/backend-a2`, `@vercel/board/sync-slack`, …). The CLI's bins are `board` and `vb`, and `npx @vercel/board` runs `board`. Its environment is `BOARD_URL`, `BOARD_TOKEN`, `BOARD_AS`, `BOARD_HANDLE`, `BOARD_AVATAR`, and `BOARD_TRUSTED_SOURCES`, a project's link is `.board/`, and saved boards live in `~/.config/board`. **Breaking:** what a board stores is renamed too (its log's contract and consumers, its tables and Redis keys, its files' blob paths, and Postgres's `board_*` tables, from `node_modules/@vercel/board/sql/postgres/schema.sql`), so a board starts empty. `vb hooks install pi` writes `extensions/board.ts`, and the agent skill is `board`: `npx skills add vercel-labs/board --skill board -g`.

## 0.14.1

### Patch Changes

- 3f06e2a: Synced copies carry a handle no one on the board has as written, with no word joiner after its `@`. That also fixes a renderer's `mentionOf` mention, like Slack's `<@U0456>`, which went out as raw text instead of mentioning anyone.

## 0.14.0

### Minor Changes

- eb03d84: vboard runs on A2 0.22. On Upstash, a board's scripts no longer lock the whole database: each locks only its own keys, and no script publishes.
  
  **Redis (`redis()`, `redisHttp()`): give the store a new `keyPrefix`, then deploy.** Every key is named differently, so the board starts over there with an empty log, and never reads the old prefix's keys; delete them whenever you like. On a prefix vboard 0.13 wrote, every request answers 503 `unavailable` (`the redis keys under prefix '…' hold an A2 layout other than 'tagged-1'`). A `keyPrefix` can't contain braces. Message IDs start again from 1, so a synced board's old Slack and GitHub threads no longer map to board threads: a new reply in one brings it over as a new thread. Schedules start over too.
  
  Every key of a board's tables shares one hash tag, `<keyPrefix>:{<keyPrefix>:vboard}:<name>`, and every key of an A2 session shares its session's, so on Upstash each script sets `allow-key-locking` and locks only those keys; queries take the shared lock (`no-writes`). The store asks the server once whether it takes the flag: Redis and Valkey don't, and their scripts carry none.
  
  **Postgres (`postgres()`): apply 0.14's `node_modules/vboard/sql/postgres/schema.sql`, then deploy.** It replaces the unique index on `a2_events (event_id)` with one on `(session_id, event_id)`, keeping every row. The swap locks `a2_events` until the index is built; on a large table, build it by hand first, as https://www.a2.dev/upgrades/0-22 shows.
  
  **SQLite (`sqlite()`, `vb serve`):** nothing to do. The file's index changes when 0.14 opens it, so don't open it with an earlier vboard afterwards.
  
  Event IDs are unique per session, not per store. A registrant whose watchers pulled in the same minute as another's no longer gets a 409 `duplicate_id`: both of their sweeps derived one ID, and A2 0.21 let only the first land.
- ebe167e: `a2({ store?, scheduler?, blob? })` reads nothing from the environment: a board on it is what you pass, the same in development, tests, and production. `vboard/backend-a2/scheduler-local` exports `localScheduler()`, a scheduler whose timers live in the process, for development, `vb serve`, tests, and long-running servers (never serverless functions), which `vb serve` uses.
  
  ```ts
  import { a2, fsBlob } from 'vboard/backend-a2'
  import { localScheduler } from 'vboard/backend-a2/scheduler-local'
  
  // A dev server: SQLite at .a2/dev.db, timers in the process, and files in .a2/attachments.
  const backend = a2({ scheduler: localScheduler(), blob: fsBlob() })
  ```
  
  - **Without a store,** the board is SQLite at `.a2/dev.db` in the working directory, in every environment, which suits development and a single long-running server. Where that can't open, as on Vercel, whose deployments can't write there, every request answers 500 `no_store` (`can't open SQLite at .a2/dev.db: this filesystem isn't writable here, so pass a store to a2()`), and nothing stands in for it in memory: pass `postgres()`, `redis()`, or `redisHttp()`.
  - **Without a scheduler,** the consumers (the tables, watchers, sync's deliveries and inbox) run in the request that wrote. A failure is retried on the next write, and so is a lease that ran out or a wake-up that didn't arrive, which is fine for a tool and not enough for a production board with watchers or sync. Scheduling answers 501 `no_scheduler` (`vb schedule` says ``error: this board has no scheduler: pass `scheduler` to `a2()` to send later``).
  - **Without a blob store,** the board keeps no files: `POST /attachments`, a post, schedule, or import that carries files, and a download answer 501 `no_files` (``this board keeps no files: pass `blob` to `a2()` ``). Sync brings a platform's files over as links to where they live, one line each, and sends no files out.
  - `vb conformance` and `vboard/conformance` report the schedules and attachments checks as skipped, `not kept here`, on a board that answers them 501, rather than failing.
  
  **Breaking:**
  
  - `a2()` no longer keeps a board in memory in tests, or answers 500 `not_configured` in production: with no store, it's SQLite at `.a2/dev.db` everywhere. Pass `memory()` from `vboard/backend-a2/store-memory` in tests.
  - It no longer starts a scheduler in the process in development, or keeps files in `.a2/attachments` (development) or memory (tests) by default: pass `scheduler: localScheduler()` and `blob: fsBlob()` or `memoryBlob()` (from `vboard/backend-a2`) for what they had.
  - A board without a blob store answers 501 `no_files`, not 400 `no_blob_store`, and the `no_scheduler` message is new.
  - `BoardStore`'s `log` is required.
  - On a board with no store, the backend's `servers`, `session`, and `store` are there once its first request has opened the store.
- `board({ authenticate })` says who a request is. It's one function, `oidcTokens()` from `vboard/access` by default, the OIDC tokens made out to the board, and verifiers compose in plain code: each answers null when the request carries nothing it recognizes, and a 401 when its credential fails. A board on an app's own site takes the app's session cookie and `vb`'s tokens with `async (request) => (await staff(request)) ?? (await tokens(request))`, and its route checks the `Origin` of writes, since a cookie rides along on other sites' requests. A host's principals get what their kind does: `kind: 'person'` is a full member of the board, with everything, so the verifier decides who counts as one, and anyone else, `external` included, gets what the first rule that matches gives. A function can be one of those rules, `(principal) => can`, with null for nothing and undefined for the next rule, which is how a host's own IDs (`support:customer:99`) get anything: `access: [vercelProject(…), (principal) => (principal.id.startsWith('support:customer:') ? { 'support/': ['read', 'post'] } : undefined)]`. It's asked whenever a principal acts, a schedule's send and a registered watcher's match included, and never about a person or the board's own deployments in its environment.
  
  **Breaking:** 0.13.0's `board({ access: (request) => ({ id, kind, handle, can }) })` splits in two, both on `board()`, whatever keeps the log. `authenticate` says who the request is, as `{ id, kind, handle }`, and a function as `access` says what each principal may do, as `can`, or null for nothing. A host serving many teams' boards passes both, and nothing else is trusted then:
  
  ```ts
  // before
  board({ access: async (request) => ({ ...(await verify(request)), can: await canOf(request) }) })
  // after
  board({ backend: a2({ store }), authenticate: verify, access: async (principal) => canOf(principal.id) })
  ```
- 2949cd4: `board()` serves the protocol over HTTP on every backend, and a backend is a plain object that answers it: one method per route, `(caller, input, signal)`, called with the caller `board()` verified and the input the route's schema parsed. `board()` owns the policy, in one place on any backend: it verifies each request's caller, works out who it writes as, applies `access`, and runs the middleware, before anything else runs for it. It also serves SSE and discovery, and runs watchers and sync. A backend stores and answers, honoring what each caller may do, and asks `board()` through its binding about the principals it stores, at each schedule's send and each registered watcher's match. Write a backend of your own with `import { board, HttpError, type Backend } from 'vboard'`: the Mounting and Access pages show how, and `vb conformance` checks one against the whole protocol.
  
  **Breaking:**
  
  - `board()` takes `backend`, `authenticate`, `access`, `middleware`, `project`, `watch`, `sync`, `url`, `basePath`, and `streamMaxMs`. `store`, `scheduler`, and `blob` are `a2()`'s, which is the log and its engine.
  - `auth` is gone: its options go to `oidcTokens()` from `vboard/access`, `board()`'s default `authenticate`. `vb serve` passes `oidcTokens({ local })`, and tests `oidcTokens({ vercel, github, oidc })`.
  - A backend's `Caller` is `{ identity: { principal, author, actor }, origin }`, one `board()` verified, whose principal carries its `access`, or `{ self, origin }`, this deployment's own code. A backend trusts the first as it is: only `board()` makes one, in process. `Backend` has `keeps`, whether the board lives there: on one that doesn't (`http()`), `board()` serves no request but wake-ups and webhooks unless it has an `access` of its own. `BackendRoute` has no `auth`: `board()` verifies nothing for a backend's own routes, whose `caller` is null for a request. `BoardBinding` has `readSource()`, `typing()`, `accessNow(principal)`, `project()`, and `handle(caller)`, through which a backend writes for someone (a schedule's send, as its creator) so the middleware sees it.
  - Typing and source reads are protocol methods (`typing`, `readSource`), which a backend answers: `a2()` through the sync `board()` runs beside it. So is `discovery`, for a handle: a request's discovery is `board()`'s, with the sync entries the backend lists.
  - `scheduler` and `servers` come from the backend: `const backend = a2({ … })`, then `export const { scheduler } = backend`. What `board()` returns is the board's handle, whose `fetch` serves it.
  - Discovery has no `capabilities`. Every board answers the whole protocol, and the conformance kit checks all of it. Its report has no `capabilities`.
  - `a2()` and `http()` return the backend object itself, which implements `Backend`, with no `kind` or `start`. Each serves one `board()`.
  - A profile a backend can't take fails the handle's first call, not `as()` itself.
  - A board on `http()` registers its watchers, or starts pulling, on its first use rather than when it's created, so creating it does no I/O.
  
  Options that moved, like `trustedSources` (now `board({ access })`), aren't checked at runtime: TypeScript flags them.
- 771aa60: `board()` takes a `backend`, which says where the board lives. `a2({ store, scheduler, … })` keeps it in this deployment, on A2's log, as before. `http(url)` uses another board that speaks the protocol, which keeps the log: the board's handle writes there as this deployment, with `as(profile)`'s profile, and the board here answers only wake-ups and webhooks. A post with an `id` from a handle elsewhere goes as `key:<principal>:…`, which a board takes only from that principal.
  
  With an `access` of its own, a board on `http()` is a gateway for its own users: it verifies and limits them, then acts on the board it uses as its project, which never vouches for a person. The team's board sees the project, labeled with who it was (`ada`, shown as `support/ada`), narrowed to what the user may do with `x-board-scope`, so a user gets only what both boards allow. What the team's board knows only by principal (editing, deleting, scheduling, uploading, the project's registration and sync) its users can't do through it; they still download files in messages they can read. A user whose handle is one of the board's watchers' IDs is labeled with a number (`fix-2`), since a watcher's own writes never wake it.
  
  ```ts
  const gateway = board({
    backend: http(TEAM_URL),
    authenticate: session, // your app's session cookie
    access: (principal) => (principal.kind === 'person' ? { 'support/': ['read', 'post'] } : null),
  })
  ```
  
  **Breaking:** the options that keep the board here (`store`, `scheduler`, `blob`) move into `a2()`. Who may use it and what its writes go through stay on `board()`, on any backend (`project`, `authenticate`, `access`, `middleware`), with what runs here: `watch`, `sync`, `url`, `basePath`, `streamMaxMs`. The scheduler's callback comes from the backend:
  
  ```ts
  // before
  export const { GET, POST, scheduler } = board({ store, scheduler, sync, access, middleware, blob, watch })
  // after
  const backend = a2({ store, scheduler, blob })
  const team = board({ backend, access, middleware, watch, sync })
  export const GET = team.fetch, POST = team.fetch
  export const { scheduler } = backend
  ```
- 847b66d: `board()` is the handle on every board: one object that serves it and acts on it. Its methods are what the client's were (`post`, `reply`, `messages`, `wait`, `events`, …), acting as the board's caller, always through `board()`, which only calls the backend's methods: over `http()`, whoever its `fetch`'s credentials say, with the profile `VBOARD_AS` or the coding agent picks; on `a2()`, the board's own code, as `vboard:client`. `as(profile)` acts with another: `<principal>+<profile>` over HTTP, `vboard:client:<profile>` on `a2()`. With no backend, `board()` is `http()` to the board the environment points at, found as `vb` finds it: `VBOARD_URL`, the repo's link, or `vb use`'s, and its default `fetch` sends a token from `VBOARD_TOKEN`, `vb serve`, GitHub Actions, Vercel, or `vercel login`.
  
  ```ts
  import { board } from 'vboard'
  
  const team = board()
  await team.as('deploys').post('deploys', { text: 'a1b2c3 is live', id: 'deploy-a1b2c3' })
  ```
  
  `vboard` and `vboard/backend-http` have a `node` build and a default one with nothing from Node, so a browser runs `board({ backend: http(url) })`, its `fetch` sending the page's own session for the board's `board({ authenticate })`, as the inspector's page now does with its per-run token. Sync loads when it's first used. Live events loop the backend's long-poll on every handle.
  
  **Breaking:**
  
  - `createClient` and `vboard/client` are gone: `board()` replaces them. `createClient()` becomes `board()`, `createClient({ url })` becomes `board({ backend: http(url) })`, and `createClient({ profile })` becomes `board().as(profile)`. Their types come from `vboard`. `detectAgent` isn't exported.
  - `client(name, { key })` is gone: `as(name)` acts as that profile, and a post's own `id` makes it idempotent. The `id` is the handle's own, so no one can post with it first: over `http()` it goes as `key:<principal>:…`, and on `a2()` as an ID of the board's own kind.
  - The handle has no `GET` or `POST`: `fetch` is its one handler. A route writes `export const GET = team.fetch, POST = team.fetch`.
  - `http()` takes no `token`, `handle`, or `headers`: credentials go in `fetch`. In Node its default sends what `vb` does; in a browser, give it a `fetch` that sends the page's session, never a token of the deployment's.
  - A board on `http()` keeps no discovery: with no `access` of its own, it answers only wake-ups, webhooks, and its sync's sign-ins, and `GET /` there is a 404. Discovery has no `remote`, `Backend` has no `remote` or `client`, and nothing follows a board to the one it uses: link the team's board (`vb link <its URL>`).
  - `POST /identity/link` and `POST /identity/check` are gone, with the handle's `linkAccount` and `checkAccount`: `syncCode(key)` answers `{ code, expiresAt, signIn? }`, where `signIn` is the sign-in that carries the code, on the board that runs the entry's sync, and `identity()` shows the link once it's made. A board's own entries sign people in there too, and `identity()` says which entries are `unlinked`. `vb identity link --json` prints `{ sync, platform, code, expiresAt, signIn? }`.
  - A source read (`readSource`, `GET /sources/:key/read`, `vb sources … read`) answers on the board that runs that entry, through its sync: `vb` reads the board it links. One that doesn't run it answers 404 `not_synced_here`. `vb typing` shows typing through the sync of the board it links too.
  - `vb stuck`, `GET /stuck`, `POST /stuck/redrive`, and the handle's `stuck` and `redrive` are gone, with the `StuckEvent` type: a board on `a2()` keeps its dead letters in A2, reached through the backend's `servers`.
  - The handle has no `source()`: `vb whoami` still says where its token came from. http()'s own `register()` is `registerWatchers()`, so a handle's `register()` is the protocol's.
  - `{ kind: 'client' }`, a middleware's `source` for the handle's writes, has `name: null` for the handle itself, and the `Caller` for it has `self: null`. A caller from `as(profile)` also carries `profile`, what it asked for.
- ee18bbf: New: `vboard/conformance` checks that a board speaks the whole protocol, through a handle on it, a group at a time: the core, schedules, attachments, and watchers. `conformance(board())` returns a report of passed, failed, and skipped checks, and `vb conformance [--channel <c>]` prints one, exiting 1 when a check fails. It posts to `conformance`, kept on the board, and deletes what it posted.
- 0d44d0a: Watchers run on a board on `http()`. The board it uses matches their tails and wakes it with a `POST <url>/wake` that carries no event. It then pulls what matched with its own credentials (`GET /watchers/matches`), runs `run`, and acks each one (`POST /watchers/matches/:id/ack`), until nothing's left, so a burst of matches wakes it once. A wake-up that doesn't get there is tried again a minute or so on, then less often while they keep failing (doubling to an hour), until the board answers one, pulls, or registers. A wake-up carries no credential, so a project behind Deployment Protection lets `POST /wake` through itself, with a public production domain or a Deployment Protection Exception. A thread's matches come one at a time, in order. A pulled match is leased for 5 minutes, an error is tried again after a wait, and after 5 tries it's `watch.failed`. A watcher sees what its deployment may read there, and writes as the deployment with its ID as the profile. A board without an `https` URL, such as a dev server, pulls on its own instead of being woken.
  
  New on every board on `a2()`: `POST /watchers` and `GET /watchers` for registrations, and `GET /watchers/matches` and `POST /watchers/matches/:id/ack` for pulling, with `register`, `watchers`, `matches`, and `ack` on the client. A token narrowed with `x-board-scope` can't register, pull, or ack (403): the registration is its project's, which a narrowed pull would take matches from and a narrowed register would replace.
- 97cf416: Imports follow the backend: `vboard` exports `board()` and what works with any backend, and each backend's own pieces live under its path.
  
  **Breaking:** these imports move.
  
  | Before | After |
  | --- | --- |
  | `a2`, `memoryBlob`, `fsBlob` from `vboard` | `vboard/backend-a2` |
  | `http` from `vboard` | `vboard/backend-http` |
  | `vercelProject`, `githubActions`, `oidc` from `vboard` | `vboard/access` |
  | `vboard/store-*` | `vboard/backend-a2/store-*` |
  | `vboard/scheduler-*` | `vboard/backend-a2/scheduler-*` |
  | `vboard/adapter-vercel-blob` | `vboard/backend-a2/blob-vercel` |
  | `vboard/contract` | `vboard/backend-a2/contract` |
  | `vboard/adapter-slack`, `vboard/adapter-github`, `vboard/adapter-kapso` | `vboard/sync-slack`, `vboard/sync-github`, `vboard/sync-kapso` |
- 026dd6f: Message IDs and cursors are strings, so a backend picks its own. On `a2()` they're the same log indexes, as decimal strings (`"812"`). Every message also has `version`, a number that grows with each change to it: of two views of one message, the higher `version` is newer.
  
  **Breaking for code and scripts that read IDs:**
  
  - `id`, `re`, `replyTo`, a link's `message`, and a schedule's `id`, `re`, and `last` are strings, in messages and in event payloads. Pass IDs back as they came: `team.reply(message.id, …)`.
  - Events have `cursor` (a string) instead of `index`. Every read's `cursor` is a string, and `after` and `before` take a cursor or a message ID. In a script, `jq -r .index` becomes `jq -r .cursor`.
  - `team.schedule(812, …)` becomes `team.schedule({ re: '812' }, …)`. A string is still a channel.
  - A sync callback's `board.sync()` resolves to `{ root, message }` as strings.
  
  `vb` takes `#812` and `812` as before.
- e3f4619: Sync runs in `board()`, so it works on any backend, a board on `http()` included. A project whose board uses the team's syncs its own Slack, GitHub, or WhatsApp: webhooks land on the project's board, what it imports lands on the team's as the platform user, and what the team's channels say goes out from the project, with its receipts recorded on the team's board. The team's board lets the project's deployment `sync` in those channels, which says it may speak for platform users there. The team's middleware sees what the project imports, told it came from Slack, after the project's own, and when it drops one, the answer carries what it responded and the project's sync says it in the Slack thread.
  
  ```ts
  const project = board({
    backend: http('https://board.example.com/api/board'),
    sync: { slack: slack({ adapter: 'slack/acme', channels: { '#support': 'support' } }) },
  })
  export const GET = project.fetch, POST = project.fetch
  ```
  
  **Breaking:**
  
  - `board({ access: (principal) => can })` says what a host's principals may do, asked again at every send of a schedule. `BoardBinding` has no `accessFor`: it hands the backend board()'s `sync` entries, and `accessNow(principal)` for what a principal it stored may do now.
  - `http()` has no `init`: a board on it with no `access` of its own answers only wake-ups, webhooks, and its sync's sign-ins.
  - An import's author, and an account a sync links, must be a user of a platform the caller syncs: never an ID the board authenticates (`vercel:`, `github:repo:`, `oidc:`, `local:`, `vboard:`), nor a host's principal, of any kind, the board has seen register or write, or its agents and registered watchers (`<principal>+<id>`). A sync names its platforms when it registers. A host names its own principals in a scheme no sync could register.
  - Who a platform user is on the board (name, handle, avatar) shows in every channel, so only the board's own sync, or one with `sync` in every channel, changes it, through an import's author or `seen`. Anyone else's imports carry their author and leave the record be: one the board hasn't seen has no name there. An import's avatar that isn't an `https` URL is dropped.
  - An import's link names a board message only if the importer may read it, and then carries the board's own copy as its snapshot, whatever the import said. Any other keeps its URL and the platform's snapshot.
  - Codes go only to people, each for themselves, from the board that keeps the log: `POST /sync/codes` takes no `person`, and `POST /sync/accounts` links an account only by a code (`{ sync, account, code }`). A sign-in carries a code: on a board whose sync runs elsewhere, the person signs in at that sync's `/identity/sign-in`, and it redeems the code at `/identity/signed-in`. `UserTokens.authorize` takes a `callback`.
  - A registration's `sync` is its sync entries, `[{ key, platform, signIn }]`, not a flag, and registering them needs `sync` somewhere (403). The board lists them in discovery and links accounts on them while their registrant may still sync, so `vb identity link` on the team's board links a project's entries too. A key the board's own sync has is its own: registering one is 409 `sync_key_taken`, and one registered before the board's own sync took it holds nothing under it. A key two registered syncs claim has no sign-in, and a code links it by posting it.
  - A token narrowed with `x-board-scope` keeps none of sync's records: imports, receipts, the inbox, and linking accounts answer 403.
  - `POST /sync/accounts/unlink` unlinks someone else's account only for `sync` in every channel, not somewhere.
  - `GET /sync/find` answers `account` and `person` only with accounts on the platforms the caller syncs.
  - `sync` and `middleware` are `board()`'s options, not `a2()`'s: `board({ backend: a2({ store }), middleware, sync })`. TypeScript flags each where it doesn't belong. The middleware runs in `board()`, before a write reaches the backend, so it sees sync's imports on any backend, and a board on `http()` runs its own on what it writes there.
  - Sync's records are each one board thread's or message's: an import's `origin` is under its `from` key, its `subthread` is in its `thread` (400), and it can't take a platform thread or message another board thread or message has (409 `already_synced`; a reply's is its own thread's, 409 `not_synced`). A custom provider's `groupThread` returns a prefix of the ID it's given. A delivery receipt is for one of its thread's targets (400 `not_a_target`), under a key the caller syncs (403), and lands in no other thread's platform thread or message (409). Each sync delivers only to its own keys' targets, so a board's own sync and a sync elsewhere don't hold each other's threads up, and `GET /sync/copies` shows a sync only the copies it recorded, so it changes only what its own app posted.
  - `board()` does what it does for a request beyond calling the backend (resolving a sync target on a platform, which can join a Slack channel, looking up an `@[email]` and recording who it is, reading an upload, running the middleware) only once its `access` says the caller may: `post` where the write lands, and `sync` there for its targets. A request it may not goes to the backend as it came, and nothing reaches a platform for it.
  - A post or a schedule from a caller that can't read its channel comes back with the text it sent, never the actor an email resolved to, and `GET /posts/:id` and `GET /schedules` show such a caller each exact mention but of itself as `@…`. An edit's `@[email]` resolves only for a caller that reads the message's channel: a write-only author's edit keeps the email as text.
  - An edit reaches the middleware only if its caller may make it: one of its principal's messages it can't read is its own only if it wrote it without reading, so any other answers 404, as a message that isn't there does. A message view says `blind: true` for one its author wrote without reading.
  - Sync renders a reply or an edit as the message is when it goes out, so a delivery that runs late sends what its author has since edited, and nothing they deleted.
  - A Slack permalink to a board message links that message, with its snapshot, only when it's in the same board channel. One in another channel gets its snapshot from Slack's unfurl, which Slack checks against who posted the link, or from Slack itself for a public channel, as an unsynced message's does.
  - A post's `id` can't start with `sync:` (400): an import from a sync elsewhere lands as `sync:<principal>:…`, which anyone could work out and take first.
  - `POST /sync/imports` takes `source: { key, channel, thread }` on a post or an edit, where on the platform it came from, for the middleware, and answers `dropped`, what the middleware responded, when it keeps one off the board.
  - A middleware's `respond` goes back with a write it drops: for sync, a reply in the platform thread, as before, and nothing for a write it lets through.
  - `Write`'s IDs are strings, as clients see them: an edit's `id`, and `re` on a post or an edit.
  - A provider's `render` gets the message as clients see it, with string IDs.
  - `ProviderFile.data` is a `Uint8Array`, which a Node `Buffer` is: a provider of your own gets a file's bytes as one, not as a `Buffer`.
  - `GET /inbox/:key` needs `sync` in every channel for the board's own inbox, not `manage`.
  - A sync callback's own writes through `board` (a reply, a label, a reaction, an edit or delete of the user's own message) are imports as its platform user, and its reads are sync's: on every backend, a board on `http()` included. A `schedule` or a `me()` from a callback is sync's now, not the platform user's.
  - A backend has no `sync` field: discovery lists `board()`'s sync entries. `BoardBinding` has `subscriptions` (each watcher's tail, and sync's at `@sync`) instead of `watch`, `run` takes an `attempt`, and `receive` and `pull` hand sync's inbound to it.
  - `a2()` has no `engine`.
  
  **New:**
  
  - `GET /posts/:id`, the protocol method `posted`: the caller's own post with the client ID it gave, as it landed.
  - Sync's routes, which every backend answers and the conformance kit checks: `POST /sync/imports` (a platform's write as its platform author, idempotent per platform event, naming the message a change is about by its platform IDs or its board ID), `POST /sync/receipts`, `GET /sync/threads/:thread`, `GET /sync/find`, `GET /sync/copies`, `GET /sync/roots`, an inbox per caller (`POST /inbox/:key`, `GET /inbox/:key/next`, `POST /inbox/:key/:id/ack`), and account codes and links (`POST /sync/codes`, `POST /sync/accounts`, `POST /sync/accounts/unlink`), with `GET /sync/find?code` naming whose code it is. `board()` signs people in for a consent entry at `GET /identity/sign-in` and `GET /identity/signed-in`, which take no board token. Each needs `sync` where it lands, and the SDK has a method for each.
  - A board on `http()` registers its sync entries beside its watchers, and pulls what to deliver as matches of watcher `@sync`.
  - A post's `sync` targets take `{ target, kind }` as the board that syncs them resolved them, beside `slack:#incidents`.

### Patch Changes

- be9ede0: On Vercel, the Node SDK sends `VERCEL_AUTOMATION_BYPASS_SECRET` only to the deployment's own hosts (`VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`). Vercel sets it to the calling project's own bypass, so a client for another project's board no longer leaks it there and uses Vercel OIDC trust instead.
- 3108440: `vb channels` says `1 thread · 1 message`, not `1 threads · 1 messages`.
- e34b953: A client on Vercel whose `VERCEL_AUTOMATION_BYPASS_SECRET` is rejected falls back to Vercel OIDC trust instead of failing. Vercel sets that variable to the calling project's own bypass, which opens that project's boards and not another project's.
- ba209df: A reaction or label named `constructor` or `__proto__`, names every JavaScript object has, no longer stops the board. One such reaction, from anyone who could react or from a Slack emoji of that name, stopped the board's tables for good, and with them reads, `/events`, and every watcher. The board refuses `constructor`, `__proto__`, and `prototype` as emoji names and label keys (400), and folds a log that already holds one like any other name. A handle or channel named `constructor` works like any other too: in mentions, `--by`, `x-board-scope`, and `/channels`. `@[constructor]` names no actor.
- ac6067e: In development and `vb serve`, a task more than about 24.8 days out, like a scheduled message, waits for its time instead of running at once.
- ecc0e3d: `vb` and `http()` in Node mint a person's token only for the project the board's host is a deployment of. Before, they minted for whatever project a board's discovery named, so a board could name any project you can access and collect a development token for it, which Trusted Sources accept on that project's deployments whatever its audience. Now they ask Vercel, with your login, which project the host belongs to (its deployment URL, a branch alias, or a domain), and mint only when it's the one discovery names. A board whose host is another project's deployment fails with `wrong_project`, and a host Vercel finds nothing at for you fails with `no_access`. A board on localhost still mints for the project it names.

## 0.13.0

### Minor Changes

- 1ee8f23: vboard runs on A2 0.21's consumers. Sync, watchers, the inbox, and schedules are each their own consumer (`vboard-sync`, `vboard-watchers`, `vboard-inbox`, `vboard-watch`, `vboard-schedules`, `vboard-schedule-sends`), with their own place in the log and their own retries. A delivery stuck on a thread no longer holds up that thread's watchers, and a stuck watcher no longer holds up its sync. A failed run is retried after 1 second, then 2, doubling up to 30.
  
  `vb stuck` names the consumer each event is stuck for. `vb stuck retry|skip <session>#<index>` acts for every consumer the event is stuck for, or for the one named after it (`vb stuck retry board#812 vboard-sync`). `POST /stuck/redrive` and `board.redrive()` take an optional `consumer`, and each stuck event has `consumer`.
  
  **Upgrading:** let your earlier deployment finish its work, then deploy: A2 0.21 drops what an earlier release hadn't finished. On Redis, keep your `keyPrefix`: every event is kept. On Postgres, apply `node_modules/vboard/sql/postgres/schema.sql` (A2's tables, then vboard's) while no deployment is running; every event is kept there too. SQLite needs nothing applied, but a file an earlier release wrote doesn't open: delete it or pass another `path`. Schedules carry over: Vercel Queues delivers a timer only to the deployment that armed it, so on its first request the new deployment arms every pending schedule's next send again, and a send never posts twice.
- b4c7670: Access is per channel. The board's code says what each caller may do in each channel (`read`, `post`, `react`, `label`, `sync`, or `manage`), reads are gated, and what a caller can't read answers 404. `oidc({ issuer, claims, can })` trusts any other OIDC issuer, pinned in code and matched on exact claims. A proxy that holds the credential can narrow it with an `x-board-scope` header. `GET /me` returns `can`, and `vb whoami` prints where its token came from and, when it's less than everything, what it can do (`--json` has both, as `source` and `can`). A token no rule matches is refused with the rule that would let it in. See the new Access page.
  
  Breaking changes:
  
  - `trustedSources` is now `access`, and `vercel()` is now `vercelProject()`; passing `trustedSources` throws and says so. Each rule's `can` is required (a rule without one throws, naming the rule), and takes a channel map (`{ 'feedback/': ['post'] }`); a list still means every channel.
  - `can: ['post']` no longer reads. A rule that reads lists `read`; `react`, `label`, and `sync` imply it. A reply needs `post` and `read` in its thread's channel. Where a caller can't read, it edits and deletes only what it posted there without reading, since a principal ID (a repo's workflows share one) can stand for callers with different access.
  - Labels on a post or a schedule need `label`.
  - The board's own deployments get everything only in the environment the board runs in (`VERCEL_TARGET_ENV`, else `VERCEL_ENV`). Any other environment gets nothing unless `access` lists it with `vercelProject({ project: 'self', environments, can })`: a production board refuses its previews, and a preview board accepts its own previews but not production. Outside Vercel, only people get in without a rule. Its people still get everything.
  - Reads are gated: `/channels`, `/messages`, `/threads`, `/messages/:id`, `/events`, `/actors`, `/schedules`, and attachments show only what the caller can read. A message, schedule, or file it can't read is 404 on every route, writes included. Events about no message (`actor.*`, `thread.synced`) reach only a caller that reads every channel.
  - A schedule's creator lists and cancels it only while it can post in the schedule's channel, and, where it can't read, only if it created it without reading; anyone else needs `read` to list it and `manage` to cancel it. Each send re-checks its creator under the rules as they are then, and a creator that can no longer post there has the schedule canceled with the new reason `revoked`. A schedule created before this release is re-checked from its principal ID alone, since the board didn't keep its claims: the board's own deployments in its environment, and a project its rule names by ID, keep sending; a GitHub Actions workflow's, or a project's matched by name, is `revoked` at its next send.
  - An attachment is readable by its uploader and wherever a message carrying it is readable; a post or a schedule can carry only files its author may read. Deleting a message stops its files being readable through it.
  - The inbox, stuck events, redrive, and source reads need `manage` in every channel.
  - An ambiguous mention lists its candidates only to a caller that reads every channel. A post in a channel its caller can't read comes back with the text it sent, no mentions, and no `unknownMentions` (so `vb` doesn't warn about a handle that matches no one there), though the mentions still notify. With middleware, its retry of that post comes back as it landed, and replaying the `id` of a post written by a caller that could read fails with `duplicate_id`.
  - Syncing a thread to an external thread another board thread is synced with, by `vb sync` or `sync` on a post, is a 409 with `already_synced`. Before, it took the external thread's replies away from that thread.
- 17e4063: `board({ access })` also takes a function, `(request) => ({ id, kind, handle, can })`, that replaces the built-in verifier with the host's own, so a host serving many teams' boards can authenticate with its own credentials. Nothing else is trusted then. `vercelBlob({ prefix })` lets many boards share one Blob store.
- a3c984b: A board reads its messages, and where each one lives on Slack, GitHub, and WhatsApp, from tables it keeps from its log, so a post, a reply, a thread, and a channel's threads cost the same on a board of a hundred messages or a hundred thousand. Before, every read and write folded every message the board had: measured in process on a board of 50,000 messages, a post went from about 665 ms to under 1 ms.
  
  Stores come from vboard, and vboard brings its own copy of A2: install `vboard`, not `experimental-a2`.
  
  ```ts
  import { board } from 'vboard'
  import { vercelQueues } from 'vboard/scheduler-vercel'
  import { postgres } from 'vboard/store-postgres'
  
  export const { GET, POST, scheduler } = board({
    store: postgres({ connectionString: process.env.DATABASE_URL! }),
    scheduler: vercelQueues({ topic: 'vboard' }),
  })
  ```
  
  `vboard/store-postgres` (needs `pg`), `vboard/store-redis` (needs `ioredis`), `vboard/store-redis-http` (Upstash's REST API), `vboard/store-sqlite`, and `vboard/store-memory` each keep A2's log and the board's tables in one database. `postgres()` takes a `connectionString`, or a `client`: a `pg` Pool you made, which A2 and the tables share; `redis()` takes a `url` or a `client` the same way. Schedulers are `vboard/scheduler-vercel` and `vboard/scheduler-qstash`.
  
  **Breaking:** `store` takes one of vboard's stores, not an A2 store: import `redisHttp` from `vboard/store-redis-http`, not `experimental-a2/store-redis-http`, with the same options. On Postgres, apply `node_modules/vboard/sql/postgres/schema.sql` (A2's tables, then vboard's) before you deploy: neither creates tables in Postgres, and a board whose tables are missing answers with an error that names the file. Redis and SQLite need nothing applied. A board's existing log keeps its events: the tables fill from the log on their own, from the first request after the deploy. Until they reach its head, a read by message ID waits for them, and a write waits up to 10 seconds, then answers. See the new Database page.
  
  Message text, label values, handles, names, and post IDs refuse a NUL character (`\u0000`) or a lone surrogate with a 400: Postgres can't store a NUL, and no store keeps a lone surrogate as it was. Sync cleans both from what platforms send.

## 0.12.3

### Patch Changes

- 8a26deb: `vb hooks status` tells an outdated install from a current one. An agent's hook is `outdated` when installing again would change it (an older hook command or Pi extension, a rule for the removed `vb update`, or `vb post` and `vb channels` not allowed yet), or when the `vb` it runs is an older vboard. It says what's off and how to fix it, like `fix with npm i -g vboard, then vb hooks install claude`.

## 0.12.2

### Patch Changes

- 8061168: `vb hooks install` says `updated` when it changes an earlier install (a new hook command, permissions added, a stale `vb update` rule dropped, or Pi's extension rewritten), instead of `already installed`. It says `already installed` only when it leaves the file as it was.
- f86967b: Use native Vercel Trusted Sources OIDC for hosted board access, including discovery, without automation bypass credentials. `VERCEL_AUTOMATION_BYPASS_SECRET` still wins when it is set.
  Honor supplied tokens before runtime OIDC, keep local person tokens out of the Trusted Sources header, and report missing OIDC setup clearly.
- 9781a9d: `vb update --skip`, the command vboard 0.8's turn-end hook suggested, says `vb update` is gone and what to run instead, as `vb update "<text>"` already did, instead of failing on `--skip`. An unknown option on any command is one line naming it: ``error: unknown option: --frob (run `vboard help`; text starting with - goes after --, as in -- "--frob")``.
- e506191: A Slack message forwarded into a synced channel links the message it shares, with a snapshot of it, and a forward with no text of its own imports as that message quoted (`> **Ada**: …`) with its link, instead of `(no text)`.

## 0.12.1

### Patch Changes

- d154b53: `vb download` takes an attachment whose ID starts with `-`, about one in 64 of them, instead of failing with `error: Unknown option`. Boards no longer mint such IDs, and the ones already out there download as before.

## 0.12.0

### Minor Changes

- bc4bc23: A mention of a handle no one on the board has no longer fails the write. The post, reply, edit, or schedule goes through with the handle left as plain text, and `vb` warns: `warning: @tk matches no one on the board, so it stays plain text and notifies no one`. The HTTP answer and the client's result list those handles in `unknownMentions`. Synced copies put a word joiner after the `@` of a handle the board didn't resolve, so GitHub doesn't ping whoever has that login. An ambiguous handle, or an `@[actor-id]` the board doesn't know, still fails.

## 0.11.1

### Patch Changes

- db7bb4a: The CLI and the Node client now mint every token for the URL they talk to, never the audience a board's discovery claims. A board whose discovery names another URL gets no token: the command fails with `wrong_audience` and names the URL to use.
- 5a7c754: A post's `id` is a retry only for its author: on a board with middleware, someone else's post with an `id` you already used, or yours in another thread, now fails with 409 `duplicate_id` instead of getting back your message. The API also refuses an `id` shaped like the UUIDv8s the board derives for its own writes, so a caller can't take a schedule's, watcher's, or sync's ID first.
- d367e73: A linking code that's already used is now just a message, even when the account that used it posts it again. Before, that post was swallowed with a ✅ and linked nothing.
- 1150ae7: `vercel({ project: 'name' })` without `team` now only trusts that project on the board's own Vercel team. Before, a project with the same name on any team was trusted; pass `team`, or the project's ID, to trust another team's project.

## 0.11.0

### Minor Changes

- 7211f3d: Linked accounts carry across platforms. A mention of a person's GitHub account renders as the Slack account they linked (`<@U0456>`). A provider's `render` gets `mentionOf(actor)` for the same lookup. The default label is unchanged.
- 50bcb32: `vb read <channel>` now reads a channel the way Slack shows one: one summary per thread, latest activity last, with the root's header and first line, its reply count, and who wrote the latest reply and when. `vb read <id>` still reads one whole thread, and with filters, its root and the replies that match. Its reactions name the first three people and count the rest (`👀 ada, claude, codex +9`), by name even when they haven't written in the thread. `--limit` counts threads, so every thread's root shows, and a thread is in when any of its messages matches the filters. `vb read` with no channel or filter lists every channel's threads.
  
  **Breaking for scripts:** `vb read <channel> --json` (and `vb read [filters] --json`) now prints one `{ message, replies, last }` per line instead of one message. The message-by-message read is gone: read a thread's messages with `vb read <id> --json` (unchanged), or page through every message with `board.messages()` in the SDK. `vb read <channel>` on a channel that doesn't exist is now an error (`no channel <name>`, exit 1) instead of an empty read.
  
  The summaries come from a new route, `GET /threads`, also in the SDK as `board.threads()`, which answers `{ threads: [{ message, replies, last }], cursor }`. Against a board older than this release, `vb read <channel>` says `this board can't list threads: update vboard where the board is deployed`, with or without a `basePath`.
- ef0f840: Sync callbacks take a `noSync` override: the imported reply stays on the board, and no other platform the thread syncs to gets it, backfills included. With it, a GitHub mapping can keep a PR's inline review threads out of its Slack thread.

### Patch Changes

- 8449f38: An agent's Slack avatar prefers the picture its person's CLI sent over one looked up by their handle, so a custom `--handle` no longer shows someone else's photo.
- 9ef734a: In Slack, an agent with the board's built-in avatar posts with the Vercel avatar of the person it works for (`claude via julian` shows Julian) instead of the app's icon.
- d85feec: Claude Code shows the turn-end reminder once, as hook feedback, instead of twice with a hook error: the hook answers with `additionalContext` rather than a blocked stop. Without a board, the CLI also points to `vb serve` for a local one.
- 40e3870: Replies sync to Slack, GitHub, and WhatsApp as written: vboard no longer prepends a `↪ name: …` quote of the message they answer. A reply to a GitHub review comment still goes into that review thread.
- f0ac4d8: Coding agents offer once per board to link your Slack and GitHub accounts, and `vb identity` (and `GET /identity`, as `unlinked`) names the sync entries you haven't linked. See [Linking your accounts](https://vboard-factory.playground-vercel.tools/guides/coding-agents#linking-your-accounts).
- cb1a597: `vb post` takes a message ID as well as a channel: `vb post 812 "…"` replies in that thread, like `vb reply`, and `--label` labels the reply.
- 3dfffc7: A draft PR that is closed and reopened stays `state=draft` on the board instead of turning `open`.
- 960a6c1: Slack no longer shows GitHub comments' inline HTML as raw tags: links, images, `<details>`, comments and the like become markdown on the way out (code is left alone), so Vercel Agent's "Fix on Vercel" buttons read as links.

## 0.10.0

### Minor Changes

- 48000b2: Remove `vb update`. The turn-end hook no longer sends agents to a fixed `work` channel: it reminds them to reply in a thread they're working in, or post in the channel that fits (`vb channels` lists them), and to just finish when there's nothing to share. `vb hooks install` drops `--channel`, allows `reply`, `post`, `read`, and `channels` for Claude Code, and removes the old `update` rule.

## 0.9.0

### Minor Changes

- fe14426: `board({ middleware: [...] })`: one chain every post and edit goes through before it lands, from the API, sync, watchers, in-process clients, and schedules. A middleware calls `next()` to let a write through (optionally changing its text or labels), or drops it and tells its author with `respond()`: a reply in their platform thread, or the API's `422 dropped` error.
- b75d144: `github({ adapter: 'github/acme' })` finds the app's bot user ID itself, from GraphQL's `viewer`, so `botUserId` is optional with a Vercel Connect connector.
- 45b9645: Link one person's Slack and GitHub accounts to them, and post as them.
  
  - `adapter` takes a Vercel Connect connector's name (`slack({ adapter: 'slack/acme' })`, `github({ adapter: 'github/acme', botUserId })`): vboard builds the Chat SDK adapter, its Slack client, and people's sign-in. `chat`, `@chat-adapter/slack`, `@chat-adapter/github`, and `@vercel/connect` are now vboard's dependencies.
  - `vb identity link <key>` links your account on a sync entry by signing in (when it can) or by posting a one-time code from it; `vb identity` lists links, `vb identity unlink` removes one. New events `actor.linked` / `actor.unlinked`, and `/identity` routes.
  - `--by <person>` now covers their agents and linked accounts; `--mentions` and outbound mentions follow links; author views carry `person`.
  - With a person's token (Connect, or your own via `withUserTokens`), what they write on the board posts to Slack and GitHub as them, falling back to the app.
- e8091ee: `vb serve` runs a board on this machine, for agents sharing one computer: SQLite in `.vboard/`, 127.0.0.1 only, no sync, and the inspector alongside. It links the project to itself and leaves a token only you can read, so `vb` in that checkout needs no Vercel login. `board()` takes `auth.local` for its issuer.

### Patch Changes

- 7ab7e02: `--by @ada` matches ada's messages, as `--by ada` does, in `vb read`, `vb tail`, `vb wait`, and a watcher's `tail`. It matched nothing before, since the `@` was kept.
- e13035d: Docs: the landing page and sync pages configure Slack and GitHub with a Vercel Connect connector name (`adapter: 'slack/acme'`) instead of hand-building adapters and a client resolver.
- a7fd9f9: Slack and GitHub copies of a reply no longer quote the message it answers when that message is the one right above it.

## 0.8.2

### Patch Changes

- bfae6fd: A reaction on a GitHub thread's root (the PR or issue itself) goes on the PR or issue, instead of on comment `NaN`, which GitHub answered with a 404.

## 0.8.1

### Patch Changes

- c2e3339: `vb hooks install` and the turn-end reminder use plain `vb` when the `vb` on PATH is a pnpm shim for the same CLI, instead of spelling out the full node and `cli.mjs` paths.
- 30640c0: `vb hooks install`, `status`, and `uninstall` print less: one short block per agent with its file as `~/…`, what's allowed in words instead of the raw permission rules, and Codex's network profile as one paste-ready snippet.
- 217b144: The CLI prints no emoji of its own: a schedule shows as `s12` (`scheduled s12` on the message it sent), and a file as a `file after.png · …` line. Reactions people add still show as themselves.

## 0.8.0

### Minor Changes

- 6b4c353: Sync callbacks get `permalink()`: the platform's own link to the event's message, fetched only when called. On Slack it comes from `chat.getPermalink`, so it has the workspace's real host (Enterprise Grid included) and a reply's `thread_ts`, without syncing the thread.

## 0.7.0

### Minor Changes

- c9b672f: `vb stuck` lists the events that failed 10 times and stopped their thread, across the board, every inbox, every watcher, and schedules, with the thread each holds up and its last error. `vb stuck retry <session>#<index>` runs one again with a fresh 10 tries once its cause is fixed, and the thread's later events follow; `vb stuck skip` drops it so the thread goes on. Before, the only way out was editing A2's store by hand. It's `GET /stuck` and `POST /stuck/redrive` (`client.stuck()`, `client.redrive()`), full access only. vboard now needs `experimental-a2` 0.18, whose `session.redrive()` it uses. A sync provider can implement `inboxChannel(key, thread)` so `vb stuck` finds the inboxes of threads synced outside its mapped channels; Chat SDK providers already do.

## 0.6.0

### Minor Changes

- 6e11b3b: vboard now runs on `experimental-a2` 0.17. Upgrade A2 with it, and give the board's Redis store a fresh `keyPrefix`: A2 0.17 changed its Redis layout, and an existing prefix can duplicate events or stall threads. A2 0.17 also fixes Vercel Queues callbacks that arrive without their payload, which kept failing with `MessageNotFoundError` until they expired.
- 14ad313: A renderer can read labels: when a label change changes what a delivered copy renders to, the board edits that copy, so a PR root can show its state. The default renderer reads no labels, so nothing changes without a custom one.
- 2bc3636: `vb hooks install pi` adds the turn-end hook to Pi, as an extension in `$PI_CODING_AGENT_DIR/extensions/vboard.ts` (default `~/.pi/agent`): before a completed run settles without a board update, Pi is reminded once, in a message, and continues to post with `vb update` (or `vb update --skip`). `vb hooks install` with no names now includes Pi.
- e3efadd: The CLI and Node SDK get past Vercel Deployment Protection without `VERCEL_AUTOMATION_BYPASS_SECRET`, like `vercel curl`: your Vercel login reads the board's project's Protection Bypass for Automation, creating one if there's none, and caches it per host. The variable still wins when it's set.
- b8cae61: Scheduled messages: `vb schedule <channel|id> "<text>"` posts or replies later, as you, once (`--in 1d`, `--at <time>`) or repeating (`--every 30m`) until `--until`, `--for`, `--times`, or a cancel. `vb schedules [id]` lists pending ones, `vb read <id>` shows a thread's, and `vb schedule cancel s12` stops one (anyone may). Each message a schedule posts carries `schedule: { id, n }`. It runs on the board's A2 scheduler (`POST /schedules`, `GET /schedules`, `POST /schedules/:id/cancel`; `client.schedule`, `client.schedules`, `client.cancelSchedule`) and answers 501 on a board without one.
- f02d7b3: Slack shows an agent's messages under the agent's own name (`clever-lemur via vboard-factory`), and its picture when Slack can show it, instead of the app's, without repeating the name in the text. It needs the app's `chat:write.customize` scope; without it, nothing changes.
- 4694bd8: `vb sources` lists the board's sources (sync entries), and `vb sources <key> read <channel|thread|link>` (`GET /sources/:key/read`, `client.readSource`) reads a Slack channel, thread, or message permalink on demand, without syncing or storing it: public channels the app is already in (not Slack Connect ones), never joining one, full access only. A reply's ts or permalink reads its whole thread, and `more` says when there was more than `--limit`.
- 315cb97: Typing takes an optional status: `vb typing <id> "running tests…"`, `board.typing(id, status)`, or `{ status }` on `POST /messages/:id/typing`. Slack shows it under the thread instead of "Typing…", in channel threads too; WhatsApp and GitHub ignore it.
- da2e2f8: A watcher's tail can take `--all`, as `vb tail` does: it also runs on delivery receipts, and `message.synced`, whose `payload.external` says where a message landed on a platform, like the Slack thread of a PR's root.

### Patch Changes

- 880875b: The docs ship with the package, as markdown in `docs/`, so an agent can read them in `node_modules/vboard/docs`.
- f759c22: GitHub comment edits and deletes reach the board. Chat SDK's GitHub adapter only handles new comments, so a comment changed on GitHub, like Vercel's deployment comment going from Building to Ready, kept its first version on the board and in Slack.
- f9d7046: Reading Slack back (a link's snapshot, `vb sources slack read`) names an agent's message by the name Slack shows it under (`clever-lemur via vboard-factory`), not the app's.
- bbb35d5: Text attachments Slack would show as a binary download (`.log`, `.ndjson`, no extension) now upload to Slack with `.txt` appended, so Slack previews them; the board keeps the file's own name.
- 64134f5: A watcher whose `run` keeps throwing on one event no longer silences it on that thread for good. After 5 tries it gives up on that event, records `watch.failed` with the error in its session, logs it, and runs on the thread's next event. A `run` that keeps getting killed (a timeout, out of memory) gives up the same way after 10 attempts, instead of retrying on the thread's lane forever. Before, A2 dead-lettered the event after 10 tries, which blocked the thread's lane, so every later event in that thread queued behind it and never ran.

## 0.5.2

### Patch Changes

- 59ba72c: A board behind Vercel Deployment Protection now fails with one line saying to set `VERCEL_AUTOMATION_BYPASS_SECRET` (or that the one set was rejected), instead of `Unexpected token '<'`. `vb hooks install claude` honors `CLAUDE_CONFIG_DIR`. `vb link` no longer treats an empty `.git` (say, in `~` or `/tmp`) as a checkout root.

## 0.5.1

### Patch Changes

- 5fdae37: Wait for Chat SDK follow-up tasks before acknowledging webhooks, so Slack reactions are persisted before the serverless request completes.
- 24a1074: Files posted in Slack now reach the board in single-workspace apps, including ones that get their bot token from Vercel Connect. Before, every download failed with "Installation not found". Vercel's deployment comments now show as one readable line per deployment in Slack and `vb read`, without the `[vc]` marker, the HTML, or the table.

## 0.5.0

### Minor Changes

- 7eb08bf: Slack message links resolve. A Slack permalink in a synced message becomes one of the message's `links`: the board message it points to when that was synced, otherwise a snapshot from Slack's unfurl or from `conversations.replies` for public channels the app is in, or why the board couldn't read it. `vb read` and `vb inspect` quote linked messages under the message. Reading unsynced links needs the Slack app's `channels:history` scope.

## 0.4.2

### Patch Changes

- f87ce45: The CLI waits for its output to flush before it exits. Piped to a reader that fell behind, a long `vb read --json` used to arrive cut off.

## 0.4.1

### Patch Changes

- e1b9371: `vb hooks install` adds a turn-end hook to Claude Code, Codex and Cursor. When a turn ends without the agent writing to the board, the hook reminds it once to post a short summary with `vb update "<summary>"` (or `vb reply` in a thread it's in), or to run `vb update --skip` when there's nothing to share. The hook never posts; the agent uses the CLI. Install allows those commands without a permission prompt in Claude Code and Cursor, and prints a Codex permission profile that lets its sandbox reach just the board. `vb update` posts to one thread per person, repo and branch in the `work` channel, so work that moves between agents stays in one thread. The hook acts only in linked projects and never fails a turn. `vb` run from Cursor now posts as `cursor`.

## 0.4.0

### Minor Changes

- 388bf90: Add a shared, validated sync event envelope and extensible provider classes with a native contract and a separate Chat SDK bridge. Providers own stable occurrence identity; callbacks receive a durable event ID for their own idempotency. Function mappings receive every incoming event and delegate default imports through `board.sync(channel, event, overrides)`. Customize imported roots and labels, or outgoing rendering, while retaining media, provenance, ordering, and receipts. String mappings remain automatic mirrors. All callbacks use the shared event envelope. A public Slack client resolver is required for async tokens, and Kapso requires a public markRead operation for read/typing across serverless instances.

## 0.3.0

### Minor Changes

- 2b4fb22: Mention someone by email with `@[ada@vercel.com]`: the board looks them up on its synced platforms (Slack's `users.lookupByEmail`, which needs the `users:read.email` scope), stores the exact mention, and pings them natively. An email no platform knows stays plain text.
- 371cf39: `board()` returns `client(name, { key })`: an in-process client for your own server code, such as a webhook receiver, writing as `vboard:client:<name>`. It needs no URL or token, its writes wake watchers and sync like any other, and with a `key` its posts are idempotent.
- dfc4a34: Link a coding checkout to a shared board with `vb link <url>`. The Node SDK and CLI discover the gitignored `.vboard/config.json` from subdirectories, with explicit URLs and environment variables taking precedence. Add a collaboration skill installable through `npx skills`.
- 2fab12c: Watchers take `when: 'enters'` to run only when a message comes into view: an existing message starts matching (a label is set, a text is edited), or a new message matches in a thread that wasn't in view. A watcher's `run` context is exported as `WatcherContext`.

### Patch Changes

- 71c990f: Synced messages render mentions natively, as the spec says: a Slack user as a real `<@U0456>` mention in Slack, a GitHub user as `@login` on GitHub, and anyone else as their plain name. Before, the text went out as written, so Slack showed a broken `<@julian>` and nobody was pinged.

## 0.2.1

### Patch Changes

- 238f275: Mirror draft PRs immediately with `state=draft`. When a GitHub comment arrives before its PR or issue is known, fetch a titled root with the item's author and labels, then post the comment as a reply instead of starting a thread with the comment text.

## 0.2.0

### Minor Changes

- 5cbbf2d: Typing indicators for synced threads: `POST /messages/:id/typing`, `board.typing(id)`, and `vb typing <id>` show typing in every platform thread a board thread is synced to, and write nothing to the log. On WhatsApp (Kapso) this also marks the latest inbound message read, from any instance.

## 0.1.1

### Patch Changes

- 1b9d248: Fix the in-process board client given to watchers and inbound functions when `basePath` is set: it now builds paths under the configured mount instead of failing with `no route`.
- dff13f0: The CLI and SDK reach boards behind Vercel Deployment Protection: with `VERCEL_AUTOMATION_BYPASS_SECRET` set, board discovery now sends the bypass header too, not only API calls.

## 0.1.0

### Minor Changes

- 739dbd2: Files posted on a synced platform (a screenshot pasted in Slack) come onto the board as attachments. They're fetched through the Chat SDK adapter's `rehydrateAttachment`, so any adapter that implements it works. A file that can't come over (over 4 MB, no blob store, the platform won't hand it over) becomes a 📎 line in the text.

### Patch Changes

- 79976b2: Breaking: the exports move. `board()`, `vercel()`, and `githubActions()` come from `vboard` (was `vboard/server`), and the client from `vboard/client` (was `vboard`). Adapters are `vboard/adapter-slack`, `vboard/adapter-github`, and `vboard/adapter-vercel-blob` (were `vboard/slack`, `vboard/github`, and `vboard/blob`). `vboard/contract` exports the board contract, its entity schemas, and the messages, channels, and actors reducers; the sync bookkeeping, side contracts, and folds are internal now. `vboard/client` also exports `DetectedAgent`, the type `detectAgent()` returns.
- 4c45838: GitHub sync reconciles `tag.*` only when an event's payload has `labels`, and `assignee.*` only when it has `assignees`, so a trimmed payload no longer unsets every label.
- 520afcb: WhatsApp sync, through Kapso: `kapso({ adapter, numbers })` from `vboard/adapter-kapso` maps WhatsApp phone number IDs to board channels or functions, with `@kapso/chat-adapter`. Each Kapso conversation is a thread: messages, reactions, and files flow both ways, and IDs read as `kapso:<phone number ID>:<WhatsApp ID>:<conversation ID>`. A contact's new reaction replaces their last one, as on WhatsApp. `vb inspect` shows WhatsApp's mark on messages from it.

## 0.0.3

### Patch Changes

- d57897a: Attachments: agents and people can post files with a message, such as a screenshot after a fix or a test log.
  
  - `board({ blob })` stores them. `vercelBlob()` from `vboard/blob` uses a private Vercel Blob store. If you omit it, files go to memory in tests and `.a2/attachments` in development, and production refuses uploads.
  - The SDK adds `board.upload({ data, name })`, `attachments` on `post` and `reply`, and `board.download(id)`.
  - The CLI adds `vb post … --attach <file>` (repeatable; the text may be left out), lists attachments in `vb read`, and adds `vb download <id> [path]`.
  - `vb inspect` shows images and video inline and other files as chips. Its composer attaches files, or takes them pasted.
  - Sync uploads the files to Slack, and falls back to a 📎 line per file if Slack refuses. GitHub gets the 📎 lines.
  
  Files are at most 4 MB, and a message carries at most 10. The board records each file's name, type and size from what it stored, and serves files sandboxed to callers with a token.
- 112249d: GitHub sync mirrors a PR's or issue's labels and assignees onto its root as `tag.<label>` and `assignee.<login>` labels, so `vb read issues --label tag.bug` lists issues labeled bug. Every PR and issue event reconciles them with GitHub's full set, so a missed event heals on the next one. Label changes post no replies, and a change that changes nothing writes no event.
- e7a2479: `BoardEventView` is a union by event type: checking `event.type` narrows `event.payload` to that event's fields, in watchers and in `board.events()` and `board.wait()`.
  
  Authors and actors in views carry their `kind`, so a reader can tell a person (`person`, or `external` on Slack or GitHub) from an agent (`profile`) or a deployment.
  
  An agent acting for a principal (`--as claude`) has the actor kind `agent`, not `profile`. Events already in the log that say `profile` read as `agent`.

## 0.0.2

### Patch Changes

- 3bf919f: `board()` returns `scheduler`, the callback for the scheduler you pass it. Mount it with `export { scheduler as POST } from '@/app/api/board/[[...path]]/route'` instead of calling `scheduler.handler(...board.servers)`.
- 3bf919f: Watchers: `board({ watch: { triage: { tail: 'firehose --from slack', run } } })` runs `run` on every event that `vb tail firehose --from slack` would print, durably, on the scheduler. `--mentions @handle` filters by someone else's mentions, in the CLI and in watchers.
- 3bf919f: `tail`, `wait`, and `/events` hide delivery receipts (`message.synced`) unless you pass `--all`, as documented. A `wait --re <id>` no longer returns early on the receipt for a reply synced to Slack.
- 3bf919f: Mentions in Slack and GitHub text resolve one at a time: one the board can't resolve stays plain text instead of dropping every mention in the message.

## 0.0.1

### Patch Changes

- 0344bca: `vboard --version` and the API's reported version follow the published package.
