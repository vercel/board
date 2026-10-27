---
title: Custom providers
description: Sync a platform board doesn't ship, natively or through any Chat SDK adapter.
---

## Two ways in

| Import | Base class | Use it when |
| --- | --- | --- |
| `@vercel/board/sync` | `SyncProvider` | You talk to the platform yourself: its webhooks, its API. Importing it doesn't load Chat SDK. |
| `@vercel/board/sync/chat` | `ChatSyncProvider` | A Chat SDK adapter already speaks the platform. Slack, GitHub, and WhatsApp are built this way. |

Either way, a provider translates between the platform and the board, and the
board does the rest: it validates and stores every incoming event before
answering, orders imports per external thread and deliveries per board thread,
retries, skips echoes, records copy and file receipts, and runs the default
imports and your [sync functions](./02-functions.md). Durable state lives on the
board's backend; a provider keeps only SDK caches and credentials.

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
| `post(target, kind, body)` | Posts `body` (`{ markdown, files?, as? }`) and returns `{ thread, message, files? }`. |
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
| `users` | `null` | People's own tokens, `{ authorize, token }` (`UserTokens` from `@vercel/board/sync`), to post as them and link accounts by signing in. |

## Optional methods

Each has a default that does nothing, or says the platform can't:

| Method | For |
| --- | --- |
| `edit(thread, message, body)`, `delete(thread, message)`, `react(thread, message, emoji, added)` | Changes to messages already delivered |
| `startTyping(thread, latest, status?)` | `typing(id, status)` on the board that runs the entry |
| `uploadFiles(thread, files)`, `deleteFiles(ids)`, `refusesFiles(error)` | Files out. `refusesFiles` tells a permanent refusal (notes instead) from a failure worth retrying |
| `fetchFile(file)` | Files in |
| `fetchRoot(thread)` | Recovering a root when a reply arrives in a thread the board hasn't seen |
| `fetchLink(link)` | Reading a linked message the platform didn't describe |
| `permalink(event)` | A sync function's `permalink()`: the platform's own link to the event's message |
| `inboxChannel(key, thread)` | The platform channel a thread is in (`desk:support` for `desk:support:t_812`), without calling the platform: `sync.channel` going out, which `channels` routes by |
| `whoAmI(token)`, `postAs(token, target, kind, body)`, `editAs(…)`, `deleteAs(…)` | Posting as a person, with `users` |
| `read(target, { limit })` | A source read on the board that runs the entry: `readSource(key, target)`, `GET /sources/:key/read` |
| `join(target)` | Adds the app to a channel so `read` can read it: `joinSource(key, target)`, `POST /sources/:key/join` |
| `mention(actor)` | A board mention in the platform's native form |
| `findByEmail(email)` | `@[ada@acme.com]` mentions |
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

## Through Chat SDK

`ChatSyncProvider` bridges any Chat SDK adapter. It runs one Chat instance per
entry, verifies webhooks through the adapter, turns its messages, edits, deletes,
and reactions into records, and fetches files with the adapter's
`rehydrateAttachment`:

```ts lib/forum.ts
import { z } from 'zod'
import type { Adapter } from 'chat'
import { envelope, eventSchema, type ResolvedTarget, type SyncContext, type SyncFn } from '@vercel/board/sync'
import { ChatSyncProvider, type ChatInput } from '@vercel/board/sync/chat'

export const ForumEvent = eventSchema('forum', 'message')
export type ForumEvent = z.infer<typeof ForumEvent>

export class ForumProvider extends ChatSyncProvider<ForumEvent> {
  constructor(options: { adapter: Adapter }, sync: SyncFn<ForumEvent>) {
    super({
      platform: 'forum',
      adapter: options.adapter,
      canStartThreads: true,
      resolveChannel: async (key) => key,
      resolveTarget: async (target): Promise<ResolvedTarget> => {
        const at = target.indexOf(':')
        return { target, channel: at === -1 ? target : target.slice(0, at), kind: at === -1 ? 'channel' : 'thread' }
      },
    }, sync)
  }

  // A reaction has no stable identity in general: use the platform's ID for this occurrence.
  override eventId(key: string, input: ChatInput): string {
    if (input.kind !== 'reaction') return super.eventId(key, input)
    return `reaction:${key}:${z.object({ id: z.string() }).parse(input.reaction.raw).id}`
  }

  override event(context: SyncContext): ForumEvent {
    return ForumEvent.parse(envelope(this.platform, context.key, context.event, context.raw, context.id))
  }
}
```

`eventId(key, input)` supplies `dedupe`. The default covers messages, edits, and
deletes; a provider that receives reactions must override it, since only the
platform knows one reaction occurrence from the next.

The constructor also takes hooks for what differs between platforms, among them:
`groupThread` (which board thread an external thread belongs to, like GitHub's
review threads), `channelOf`, `toChatId` and `fromChatId` (ID encodings),
`markdown` and `author` (reading a message), `context`, `fetchRoot`, `links`,
`read`, `uploadFiles`, `refusesFiles`, `startTyping`, and `intercept` and `missed`
(webhook events the adapter doesn't emit). The built-in providers in
`@vercel/board/sync-slack`, `@vercel/board/sync-github`, `@vercel/board/sync-kapso`, and
`@vercel/board/sync-linear` are
working examples of each.
