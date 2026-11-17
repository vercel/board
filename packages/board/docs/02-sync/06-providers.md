---
title: Custom providers
description: Sync a platform board doesn't ship, through any Chat SDK adapter or natively.
---

## Two ways in

| Import | Export | Use it when |
| --- | --- | --- |
| `@vercel/board/sync-chat-sdk` | `chatSdk()` | A Chat SDK adapter already speaks the platform. Slack, GitHub, and Linear have entries of their own on the same bridge, with more than it reads: use those for them. |
| `@vercel/board/sync` | `SyncProvider` | You talk to the platform yourself: its webhooks, its API. Importing it doesn't load Chat SDK. |

Either way, a provider translates between the platform and the board, and the
board does the rest: it validates and stores every incoming event before
answering, orders imports per external thread and deliveries per board thread,
retries, skips echoes, records copy and file receipts, and runs the default
imports and your [sync functions](./02-functions.md). Durable state lives on the
board's backend; a provider keeps only SDK caches and credentials.

## Any Chat SDK adapter

`chatSdk({ adapter }, sync)` syncs whatever platform a
[Chat SDK adapter](https://chat-sdk.dev/docs/adapters) speaks, with a
[sync function](./02-functions.md) like any entry. Here it's Telegram
(`npm i chat @chat-adapter/telegram`), whose adapter reads its token and
webhook secret from the environment:

```ts app/api/board/[[...path]]/route.ts
import { createTelegramAdapter } from '@chat-adapter/telegram'
import { board } from '@vercel/board'
import { channels, chatSdk } from '@vercel/board/sync-chat-sdk'

const team = board({
  sync: {
    telegram: chatSdk({ adapter: createTelegramAdapter() }, channels({
      '-1001234567890': 'support',
    })),
  },
})
export const GET = team.fetch, POST = team.fetch
```

The entry's webhook is `/webhooks/telegram`: point the platform's webhook at it.
The bridge verifies each request through the adapter, turns its messages,
edits, deletes, and reactions into events, and fetches files with the adapter's
`rehydrateAttachment`. It reads the rest from the adapter, and each guess has a
hook, passed beside `adapter`:

| What | Without a hook | Hook |
| --- | --- | --- |
| The platform's name | The adapter's `name`, in author IDs like `telegram:user:42`, which the board files under the entry's key | `platform` |
| Channels | The adapter's own channel IDs, without its `name:` prefix | `resolveChannel(name)` |
| Targets | One the adapter reads as a thread is a thread in its channel; anything else is a channel | `resolveTarget(target)` |
| New threads | Never: a new board root stays on the board, since on most platforms a chat is one conversation. Threads that came from the platform sync both ways. | `canStartThreads: true`, where a channel holds many threads (Discord, Teams) |
| Reactions | Known by the webhook that brought them: a platform sends the same body again on a retry and a new one for each reaction, even where the reaction reads the same every time, as on Discord | `reactionId(reaction)` |
| Reactions per person | Any number | `singleReaction` |

A platform that gives each reaction an ID, or names its channels, says so:

```ts
// in board(), with an adapter of your own:
sync: {
  forum: chatSdk({
    adapter,
    platform: 'forum',
    // Names in channels(), as the platform's channel IDs.
    resolveChannel: async (name) => (name === 'support' ? 'c_812' : name),
    // The platform's ID for one reaction, the same when it's delivered again.
    reactionId: (reaction) => (reaction.raw as { event_id: string }).event_id,
  }, channels({ support: 'support' })),
},
```

The other hooks cover what differs between platforms: `groupThread` (which
board thread an external thread belongs to, like GitHub's review threads),
`channelOf`, `toChatId` and `fromChatId` (ID encodings), `markdown` and `author`
(reading a message), `isRoot`, `context`, `fetchRoot`, `links`, `locate` and
`url`, `mention` and `findByEmail`, `read` and `join`, `uploadFiles` and
`refusesFiles`, `startTyping`, and `intercept` and `missed` (webhook events the
adapter doesn't emit).
When no hook covers what an adapter gets wrong, extend the adapter
([Chat SDK's guide](https://chat-sdk.dev/docs/platform-adapters)) or write a
native provider.

### State

Chat SDK and the adapter keep their state in memory unless you pass `state`,
a [Chat SDK state adapter](https://chat-sdk.dev/docs/state-adapters):

```ts
import { createRedisState } from '@chat-adapter/state-redis'
import { channels, chatSdk } from '@vercel/board/sync-chat-sdk'

// in board(), with an adapter of your own:
sync: {
  forum: chatSdk({ adapter, state: createRedisState() }, channels({ c_812: 'support' })),
},
```

The board's log is what lasts either way, so most adapters need none. Pass one
when an adapter reads back, on a later request, what it stored on an earlier
one: Resend's finds the thread an email replies to that way, and on another
instance it wouldn't. When the board can't store what a webhook brought, the
bridge gives back whatever Chat SDK or the adapter claimed for it, like a
message's dedupe key, so the platform's retry gets through.

## A native provider

```ts lib/desk.ts
import { z } from 'zod'
import {
  SyncProvider,
  envelope,
  eventSchema,
  type ProviderPost,
  type Receive,
  type ResolvedTarget,
  type SyncContext,
  type SyncFn,
} from '@vercel/board/sync'

export const DeskEvent = eventSchema('desk', 'message')
export type DeskEvent = z.infer<typeof DeskEvent>

type Delivery = {
  delivery: string
  inbox: string
  ticket: string
  message: string
  text: string
  user: { id: string; name: string }
}

export class DeskProvider extends SyncProvider<DeskEvent> {
  private readonly secret: string

  constructor(options: { secret: string }, sync: SyncFn<DeskEvent>) {
    super({ platform: 'desk', canStartThreads: true }, sync)
    this.secret = options.secret
  }

  override async receive(key: string, request: Request, emit: Receive): Promise<Response> {
    // here's where you'd verify the platform's signature, before emitting anything:
    if (request.headers.get('x-desk-secret') !== this.secret) return new Response('unauthorized', { status: 401 })
    const body = (await request.json()) as Delivery
    await emit({
      dedupe: body.delivery,
      raw: body,
      event: {
        kind: 'message',
        channel: `${key}:${body.inbox}`,
        thread: `${key}:${body.inbox}:${body.ticket}`,
        subthread: null,
        message: body.message,
        text: body.text,
        isRoot: false,
        context: null,
        author: { id: `desk:user:${body.user.id}`, handle: body.user.name, name: body.user.name, avatar: null, isBot: false },
      },
    })
    return new Response('ok')
  }

  override async resolveChannel(key: string): Promise<string> {
    return key
  }

  override async resolveTarget(target: string): Promise<ResolvedTarget> {
    const [inbox, ticket] = target.split(':')
    return { target, channel: inbox!, kind: ticket ? 'thread' : 'channel' }
  }

  override async post(target: string, kind: ResolvedTarget['kind'], body: ProviderPost) {
    // your platform's API, e.g. a new ticket for a channel target, a reply for a thread:
    // const sent = await desk.post(target, body.markdown)
    const sent = { ticket: 't_812', message: 'm_1' }
    return { thread: kind === 'channel' ? `${target}:${sent.ticket}` : target, message: sent.message }
  }

  override event(context: SyncContext): DeskEvent {
    return DeskEvent.parse(envelope(this.platform, context.key, context.event, context.raw, context.id))
  }

  // The platform channel a thread is in, so `channels` can route what goes out to it.
  override inboxChannel(key: string, thread: string): string {
    return thread.split(':').slice(0, 2).join(':')
  }
}
```

Then use it like any built-in entry, with any [sync function](./02-functions.md).
Its webhook is `/webhooks/desk`:

```ts
// in board(), with channels from '@vercel/board/sync':
sync: {
  desk: new DeskProvider({ secret: process.env.DESK_SECRET! }, channels({ support: 'support' })),
},
```

## The contract

**Required methods:**

| Method | Does |
| --- | --- |
| `receive(key, request, emit)` | Authenticates the request, then emits normalized `{ event, raw, dedupe }` records, and answers what the platform expects. |
| `resolveChannel(name)` | Turns a channel's name (`'#prs'`, `'support'`) into the platform's channel ID: what `sync.resolve` and `channels` use. Throw `UnreadableError('channel_not_found', …)` (from `@vercel/board/sync`) when there's no such channel; any other throw means it couldn't tell, and `channels` holds what that channel might be in. |
| `resolveTarget(target)` | Turns a sync target into `{ target, channel, kind }`, where `kind` is `channel` or `thread`. |
| `post(target, kind, body)` | Posts `body` (`{ markdown, files?, as?, deployments? }`) and returns `{ thread, message, files? }`. `deployments` comes with [Vercel's deployment comment](./04-github.md#vercels-deployment-comment), whose `markdown` already lists them a line each, for a platform that lays them out itself. `as`, which sync sends with every message whose author the board verified, is who it's from, `{ name, avatar, attribution }`, for a platform that shows a sender per message: `attribution` is the end of `name` that says whose word it is (` via support (slack)`), for a platform that cuts names short to keep. `markdown` opens with `**name**: ` unless a renderer left it out. |
| `event(context)` | Builds the typed envelope sync functions read as `sync.event`, usually `envelope(…)` parsed by an `eventSchema`. |

**IDs.** Incoming locations (`channel`, `thread`, `subthread`) carry the entry's key
as a prefix: `desk:support:t_812`. A `subthread` extends its `thread`'s ID
(`desk:support:t_812:r_3` in `desk:support:t_812`), so `groupThread` returns a
prefix of the ID it's given: the board refuses an import whose subthread isn't
in its thread. A subthread's messages are found by their thread too, so a
platform message ID is unique within its thread, as GitHub's comment IDs are. Targets handed to `post`, `resolveTarget`, and the
optional methods are native, without it: `support:t_812`. The board records each
target's `kind` from `resolveTarget`, so it never parses your ID syntax, and a
channel target on a provider whose `canStartThreads` is false is refused.

**Authors.** Name a user on your platform (`desk:user:7`). The board names them
under the entry's key instead, so a provider under key `support` brings
`support:user:7`, and `mention(actor)` gets them back with your prefix
(`desk:user:7`). A user is the key's, and renaming a key changes its users' IDs.

**Mentions.** When a message mentions one of your users, write them in its
`text` as `@[desk:user:7]` and list them in the event's `mentioned`, each shaped
like an `author`, on a `message` or an `edited` event. The board names them
under the key as it does authors, and meets each one it hasn't seen, so people
can mention them back before they've written. Up to 50 a message are met;
every mention in the text is named under the key, and one the text doesn't
mention is left out.

**Dedupe.** `dedupe` is the identity of one occurrence. A platform redelivering the
same event must produce the same value, so the retry does nothing; a later
identical action (a reaction added, removed, and added again) must produce a new
one. Use the platform's delivery or event ID.

**Intake.** The board validates each record and stores it before your `receive`
returns. Events outside the channels the sync function's helpers route, and
outside threads the board syncs, are dropped; see [What the webhook keeps](./02-functions.md#what-the-webhook-keeps).
If storing fails, the webhook answers 500 so the platform retries.

**Options** passed to `super()`:

| Option | Default | Means |
| --- | --- | --- |
| `platform` | (required) | The platform's name, shown by `vb sources` and in author labels like `ada (desk)`. |
| `canStartThreads` | `false` | A board root can start a thread in a mirrored channel. |
| `singleReaction` | `false` | One reaction per person per message, as on WhatsApp. |
| `uploadsFiles` | `false` | Files go to the platform with `uploadFiles`; otherwise each gets a line in the text. |

## Optional methods

Each has a default that does nothing, or says the platform can't:

| Method | For |
| --- | --- |
| `edit(thread, message, body)`, `delete(thread, message)`, `react(thread, message, emoji, added)` | Changes to messages already delivered |
| `startTyping(thread, latest, status?)` | `typing(id, status)` on the board that runs the entry |
| `uploadFiles(thread, files)`, `deleteFiles(ids)`, `refusesFiles(error)` | Files out. `refusesFiles` tells a permanent refusal (notes instead) from a failure worth retrying |
| `fetchFile(file)` | Files in |
| `fetchRoot(thread)` | Recovering a root when a reply arrives in a thread the board hasn't seen |
| `fetchLink(link, linker)` | Reading a linked message the platform didn't describe. `linker` is the message that links it, where the platform may have described it since |
| `permalink(event)` | A sync function's `permalink()`: the platform's own link to the event's message |
| `inboxChannel(key, thread)` | The platform channel a thread is in (`desk:support` for `desk:support:t_812`), without calling the platform: `sync.channel` going out, which `channels` routes by |
| `read(target, { limit })` | A source read on the board that runs the entry: `readSource(key, target)`, `GET /sources/:key/read` |
| `join(target)` | Adds the app to a channel so `read` can read it: `joinSource(key, target)`, `POST /sources/:key/join` |
| `mention(actor)` | A board mention of one of your users in the platform's native form, as sync posts |
| `mentionById(id)` | The same for a user the board hasn't met, from their ID alone (`desk:user:7`). Return null unless the ID is all a mention needs, and for anything that isn't a user's ID |
| `findByEmail(email)` | `@[ada@acme.com]` mentions, looked up as sync posts |
| `locate(url)`, `url(thread, message)` | Links both ways: `vb read <link>` and `vb sync <id>`. See [Links](#links) |

`render(input)` builds the outgoing body when `deliver` gets no renderer;
override it in a subclass.

## Links

Two methods let the board go between its messages and the platform's links to
them. Both use the platform's own thread and message IDs, without the sync key:

```ts
// in your provider, beside post():
override locate(url: string) {
  // https://tickets.example.com/t/42#c7 → thread t/42, message c7
  const found = /^https:\/\/tickets\.example\.com\/(t\/\d+)(?:#(c\d+))?$/.exec(url)
  return found ? { thread: found[1]!, message: found[2] ?? null } : null
}
override async url(thread: string, message: string) {
  return `https://tickets.example.com/${thread}#${message}`
}
```

- **`locate(url)`** reads a link as the platform's thread and message, or
  `message: null` for a link to a thread itself, and null for a link that
  isn't the platform's. It asks the platform nothing: the board looks the IDs
  up in what it synced. `vb read <link>` and `board.linked(url)` use it.
- **`url(thread, message)`** is the platform's link to one of its messages, or
  null. `vb sync <id>` and `board.sync(id)` show it for each copy.

A provider without them still syncs: its links just don't resolve, and its
copies show their IDs. Slack reads permalinks and asks `chat.getPermalink` for
one; GitHub reads and makes a PR's, an issue's, and a comment's URLs.
