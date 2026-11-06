---
title: Sync functions
description: One function per platform decides what each event does, coming in and going out.
---

## One function per platform

Each platform takes its app and a sync function. board calls the function for
every event, in both directions, and the function decides what happens:

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { slack } from '@vercel/board/sync-slack'

const team = board({
  sync: {
    slack: slack('slack/acme', async (sync) => {
      // From Slack: #support (C0123ABC) comes onto the board, and threads it already has keep coming.
      if (sync.direction === 'in') return void (await sync.import(sync.channel === 'C0123ABC' ? 'support' : undefined))
      // A new root in `support`: start its thread in #support.
      if (sync.target === null) return sync.message.channel === 'support' ? sync.start('C0123ABC') : undefined
      // Anything said on the board, in a thread synced to Slack: send it.
      await sync.deliver()
    }),
  },
})
export const GET = team.fetch, POST = team.fetch
```

A function that calls nothing does nothing: nothing comes in, nothing goes out.
`import`, `deliver`, and `start` are the only things that move a message.

Most boards don't write that function by hand. `channels`, `repos`, and
`numbers` route each event by its platform channel, and `mirror`, `into`, and
`render` are what each channel does:

```ts
// in board({ sync: { … } }):
slack: slack('slack/acme', channels({ C0123ABC: 'support' })),
```

That's the function above, except that the webhook keeps only #support's events
and those of threads the board syncs; see [What the webhook keeps](#what-the-webhook-keeps)
and [Helpers](#helpers).

## Coming in

When an event comes from the platform, `sync.direction` is `'in'`:

| Field | Value |
| --- | --- |
| `key` | The entry's key: `slack` in `sync: { slack: … }`. |
| `channel` | The platform channel it happened in, as the platform names it: `C0123ABC`, `acme/www:pulls`, a phone number ID. |
| `event` | The event, validated and frozen. See [The event](#the-event). |
| `board` | The board, as the platform user the event came from. See [More than an import](#more-than-an-import). |
| `import(channel?, overrides?)` | Imports the event. See below. |
| `permalink()` | The platform's own link to the event's message. See [Permalinks](#permalinks). |
| `resolve(name)` | A platform channel's ID from its name: `'#support'` to `'C0123ABC'`. |

`import(channel)` applies the default import: provenance, files, links, state
labels, and retries. For an event in a thread the board already syncs, the
channel is ignored and the event lands in that thread; the channel only places
new roots. Without a channel, an event in a thread the board doesn't sync stays
off it, so `import()` alone means "only threads we already have".

It runs once per event: a second call answers what the first did. Don't call
it, and the event is skipped; its thread stays connected, so later events still
reach the function.

## Going out

When something happens on the board, `sync.direction` is `'out'`, once for each
platform thread the board thread is synced with:

| Field | Value |
| --- | --- |
| `key` | The entry's key. |
| `target` | The platform thread or channel it goes to (`slack:C0123ABC:1727000000.123456`), or `null` for a new root. |
| `channel` | The platform channel `target` is in, as the platform names it; `null` for a new root. |
| `event` | The board event, as `vb tail` shows it. |
| `message` | The message the event is about, as it is now. |
| `deliver(options?)` | Sends the event to `target`. Takes `{ render }`; see [Render](#render). |
| `start(channel)` | Syncs the message's thread with a platform channel: `'#support'`, `'C0123ABC'`. |
| `resolve(name)` | A platform channel's ID from its name. |

What `deliver()` sends depends on the event:

| Event | `deliver()` sends |
| --- | --- |
| `thread.synced` | The root, then every reply, in order: a thread that just started there. |
| `message.posted` | The reply. |
| `message.edited`, `message.deleted` | The change to its copy. |
| `reaction.added`, `reaction.removed` | The reaction on its copy. |
| `labels.changed` | An edit of its copy, when the labels change what it renders to. |

A new root comes once more, with `target` and `channel` null, for each platform
that can start a thread in a channel (Slack and Linear can; GitHub can't).
That's when `start` puts it there: the board records the channel, and the
`thread.synced` that follows comes back through the function to be delivered.
`start` never sends a thread back to the channel its root came from. A root
posted with `--no-sync` doesn't come at all.

The function is never called with a message's way back to where it came from:
a Slack message isn't offered to its own Slack thread. `deliver` runs once per
call, like `import`.

## Helpers

`channels`, `repos`, `numbers`, and `teams` take a map from platform channels to what
each one does: a sync function, or a board channel as a string.

| Helper | From | Keys | A string means |
| --- | --- | --- | --- |
| `channels` | `@vercel/board/sync-slack`, `@vercel/board/sync` | Slack channels, by name (`'#prs'`) or ID | `mirror` |
| `repos` | `@vercel/board/sync-github` | Repos (`'owner/repo'`), or `{ pulls, issues }` to route each | `into` |
| `teams` | `@vercel/board/sync-linear` | Linear team keys (`'ENG'`) | `mirror` |

Each routes an event by its `channel`. A new root goes to every channel's
function, with `channel` set to that one. A thread the board syncs in a channel
that isn't in the map (someone ran `vb sync` on it) keeps syncing: both ways
under `channels`, `numbers`, and `teams`, and in only under `repos`.

The units are plain sync functions, from `@vercel/board/sync`:

| Unit | Does |
| --- | --- |
| `mirror(channel)` | Imports into the board channel, delivers what's said there, and starts a thread for a new root in it. |
| `into(channel)` | Imports into the board channel, and sends nothing back. |
| `render(renderer, fn)` | `fn`, delivering with `renderer`. |

They compose by calling each other, with the helper outermost (see [What the
webhook keeps](#what-the-webhook-keeps)). A GitHub repo that comes in, and gets
back only what's written on the board, never what was said in Slack:

```ts
// in board({ sync: { … } }):
github: github('github/acme', repos({
  'acme/www': async (sync) => {
    if (sync.direction === 'in') return void (await sync.import('prs'))
    if (sync.message.from === null) await sync.deliver()
  },
})),
```

A PR's inline review threads stay on GitHub and the board, out of Slack:

```ts
// in github('github/acme', repos({ … })):
'acme/www': async (sync) => {
  if (sync.direction === 'in') await sync.import('prs', { noSync: sync.event.subthread !== null })
},
```

Keys resolve on their own. A channel that doesn't exist yet is logged and
skipped, tried again a minute later, and the rest sync; so is a private
channel's name on an app without `groups:read`, which never lists (map it by
ID). A name the platform couldn't check, because its listing failed, might be
any channel, so until it resolves, an event outside the channels that did
throws and is retried, rather than reaching the fallback past that key's
function, and a new root starts only where its channel resolved. Each retry
asks again. Slack names resolve through one cached channel listing. IDs never
wait: a key like `'C0123ABC'` asks Slack nothing.

## What the webhook keeps

The webhook stores each event it keeps in the [inbox](./01-overview.md#debug-it),
then the function runs on it. It keeps an event when the board syncs its thread,
or when its channel is one that `channels`, `repos`, or `numbers` routes;
`render` keeps theirs. While a `#name` key can't be checked, an event it might
route is refused instead (unless its thread is synced), so Slack sends it again
and nothing from other channels is stored meanwhile. A function of your own at the top keeps every event the
platform sends the app, in every channel it's in, and each one is stored, even
if it only calls a helper inside:

```ts
// in board({ sync: { … } }): keeps #support's events, and threads synced by hand
slack: slack('slack/acme', channels({ '#support': 'support' })),
// the same on the board, but keeps every channel the app is in
slack: slack('slack/acme', (sync) => channels({ '#support': 'support' })(sync)),
```

So keep the helper outermost, and put your own code in its values.

## The event

Every event is an envelope, validated and frozen the first time your function
reads it. Fields every event has:

| Field | Value |
| --- | --- |
| `id` | The inbox event's ID. Stable across retries: use it as an idempotency key. |
| `platform`, `key` | `slack`, `github`, `linear`, or a `chatSdk()` entry's platform, and the entry's key. |
| `channel`, `thread` | External IDs with the key prefix: `slack:C0123ABC`, `slack:C0123ABC:1727000000.123456`. `thread` is what `vb sync` accepts as a target. |
| `subthread` | The precise sub-thread, when the adapter grouped it: a GitHub review thread. Otherwise `null`. |
| `kind` | `message`, `edited`, `deleted`, `reaction`, or `lifecycle`. |
| `type` | The narrower name: `message` (Slack, `chatSdk()`), `comment` (GitHub, Linear), `message.edited`, `message.deleted`, `reaction.added`, `reaction.removed`, or a lifecycle type like `pr.opened`. |
| `raw` | The platform's payload. |

Then, by kind:

- **`message`:** `message` (the platform's ID), `text` (markdown), `author`
  (`{ id, handle, name, avatar, isBot }`), `isRoot`, `context` (a GitHub review
  comment's `path:line`), and `files` and `links` when it has them.
- **`edited`:** `message`, `text`, `author`, `links`.
- **`deleted`:** `message`.
- **`reaction`:** `message`, `emoji`, `added`, `author`.
- **`lifecycle`:** `type`, `title`, `url`, `labels`, `reply`, and `author`. GitHub
  and Linear send these: see GitHub's [events table](./04-github.md#events) and
  Linear's [events table](./07-linear.md#events).

GitHub events also carry `subject: { type: 'pull_request' | 'issue', repo, number }`,
comments and reactions included. The types are exported: `SlackEvent` from
`@vercel/board/sync-slack`, `GitHubEvent` and `GitHubPayload` from
`@vercel/board/sync-github`, `LinearEvent` from `@vercel/board/sync-linear`, and
`ChatSdkEvent` from `@vercel/board/sync-chat-sdk`.

## Permalinks

`permalink()` is the platform's own link to the event's message. It's fetched on
the first call and reused after, so a function that never asks doesn't cost an
API request:

```ts
// in slack('slack/acme', channels({ … })): copy a report elsewhere, with a link back
'#reports': async (sync) => {
  if (sync.direction === 'in' && sync.event.kind === 'message' && sync.event.isRoot)
    await sync.board.post('triage', `${sync.event.text}\n\n${await sync.permalink()}`)
},
```

On Slack it calls `chat.getPermalink` with the provider's client, so the URL has
the workspace's own host (Enterprise Grid included) and a reply's `thread_ts`. It
only reads the URL: the thread isn't synced and no channel is joined. It returns
`null` for a lifecycle event or a deleted message, and on platforms without
links, and throws when Slack refuses, so the event is retried.

## Overrides

`import`'s second argument changes the default import:

| Override | Effect |
| --- | --- |
| `text` | Replaces the imported message's text. For a lifecycle event that creates a root and a reply, it replaces the reply; for one that only creates a root, it's the root's final text. |
| `labels` | Merged into the thread root's labels. |
| `unset` | Label keys removed from the root, applied last. |
| `root` | A synchronous function that shapes a new root. It receives the default draft (`text`, `labels`, `author`, `raw`) and returns `{ text?, labels? }`. |
| `noSync` | Keeps the imported reply on the board, like `vb reply --no-sync`: no other platform the thread syncs to gets it, now or in a backfill. A root it creates still syncs. |

`root` runs whenever an import creates a root: a PR opening, or a comment on a PR
the board hasn't seen, which recovers the root first. Its labels merge into the
draft, then `labels` takes precedence, then `unset` removes keys. It can't change
the author or other provenance:

```ts
// in github('github/acme', repos({ … })):
'acme/www': async (sync) => {
  if (sync.direction !== 'in') return
  await sync.import(sync.event.subject.type === 'pull_request' ? 'prs' : 'issues', {
    labels: { area: 'www' },
    root: ({ raw }) => {
      const payload = GitHubPayload.parse(raw)
      const item = payload.pull_request ?? payload.issue
      return { text: [item?.title, item?.body, item?.html_url].filter(Boolean).join('\n\n') }
    },
  })
},
```

Platform reconciliation still applies on later events: GitHub's next event
rewrites `state`, `review`, `tag.*`, and `assignee.*` unless you override them
again.

## The result

`import` returns `{ root, message }`, the board IDs it touched:

- `root` is the thread's root.
- `message` is the imported message, the message an edit, delete, or reaction
  changed, or a lifecycle event's reply. A lifecycle event that only creates a root
  returns the root; one that only changes labels returns `null`.
- An event that can't apply (a reaction on a message the board never had) returns
  `null` where no board message exists.

Retried after it succeeded, it returns the same IDs.

## More than an import

`sync.board` is a client of the board in this process, through `board()`, with
the [handle's](../04-reference/02-board.md) methods, so a function can also
reply, react, label, or attach:

```ts
// in slack('slack/acme', channels({ … })):
'#support': async (sync) => {
  if (sync.direction === 'out') return sync.deliver()
  const { root } = await sync.import('support')
  if (sync.event.kind === 'message' && sync.event.isRoot && root !== null)
    await sync.board.label(root, { set: { status: 'new' } })
},
```

Its writes (a reply, a label, a reaction, an edit or delete of the user's own
message) are authored by the platform actor who triggered the event, like
`slack:user:U0456`, with the same provenance as the import, and go through the
[middleware](../01-board/08-middleware.md) like it. Its reads, and anything else
it does, are sync's own. It holds no token: `board()` makes its calls. It works
the same on any backend that runs sync.

## Render

`deliver({ render })` decides the body of each board message it posts, and
`render(renderer, fn)` passes a renderer to every `deliver` in `fn`. A renderer
receives immutable copies of the message, as clients see it (its IDs are
strings), and its author, the default label, and the resolved destination, and
returns markdown:

```ts
// in board({ sync: { … } }): post the text alone, without the author label
slack('slack/acme', render(({ message }) => message.text, channels({ '#prs': 'prs' }))),
```

The default is `**${label}**: ${message.text}`, where the label is the author's
name: `claude via julian` for an agent profile, `ada (slack)` for a message that
came from a platform. board still adds a line per attachment the platform
didn't take, and converts mentions to the platform's own form after your
renderer runs.

Each channel can render its own way, since `render` wraps any function:

```ts
// in board({ sync: { … } }):
slack: slack('slack/acme', channels({
  '#deploys': render(({ message }) => message.text, mirror('deploys')),
  '#support': mirror('support'),
})),
```

A renderer can read labels. When a label change changes what a delivered copy
renders to, board edits that copy, so a PR's root in Slack can show its state:

```ts
// in slack('slack/acme', render(…, channels({ … }))):
({ message, label }) =>
  message.re === null && message.labels.state === 'merged'
    ? `:pr-merged: ${message.text}`
    : `**${label}**: ${message.text}`
```

`mentionOf(actor)` returns how the platform mentions one of its own actors
(`<@U0456>` in Slack), or null for anyone else. The default label is
the author's name, so nobody gets pinged unless a renderer asks:

```ts
// a renderer: a PR's root mentions its owner, or its author
({ message, label, mentionOf }) => {
  const who = (message.labels.owner && mentionOf(message.labels.owner)) ?? mentionOf(message.by.actor)
  return message.re === null && message.labels.pr && who
    ? `${message.text} · ${who}`
    : `**${label}**: ${message.text}`
}
```

The default renderer reads no labels, so labels alone never edit a copy. Rendering
applies to roots, replies, backfills, and edits; changing it affects future
deliveries, not copies already sent. A subclass can override `render(input)`
instead; see [custom providers](./06-providers.md).

## Retries and idempotency

A function that throws is retried. Writes made through `sync.board` take IDs
derived from the inbox event and the order of calls, so a retry that writes in
the same order doesn't post twice, and an import that already succeeded returns
its existing message. Two rules follow:

- Writes made in parallel (`Promise.all`) need explicit `id`s.
- Your own side effects aren't covered. Key them on `event.id`:

```ts
// in a sync function, your side effect:
// await createTicket(sync.event, { idempotencyKey: sync.event.id })
```

On `local()`, an event coming in that keeps throwing is given up on after 10
tries, and on Vercel's board after 5. That holds up only its thread's lane in
that channel's inbox; other
threads and the board keep flowing. Going out, a throw is a failed delivery: retried five times, then recorded, as in
[When delivery fails](./01-overview.md#when-delivery-fails). Calling `import`,
`deliver`, or `start` after the function returns throws.
