import type { Protocol } from '../api/protocol.ts'
import type { MessageView, SourceJoin, SourceRead } from '../api/routes.ts'
import type { ProfileOption } from '../client/client.ts'
import type { ExternalEvent } from '../contract/external.ts'
import type { Actor } from '../contract/folds.ts'
import type { Author } from '../contract/schemas.ts'
import type { Access } from './access.ts'
import type { Granted, Known, Pinned, StoredGrant } from './auth.ts'
import type { Board } from './board.ts'
import type { Decided } from './policy.ts'
import type { WatcherContext } from './watcher.ts'
import type { WriteOrigin } from './origin.ts'

/**
 * Who a verified caller is: its principal, with what board()'s `access` lets it do now (its scope
 * included, which only narrows), the author record its writes carry, and the actor it writes as.
 * `records: false`: its writes leave the board's record of its actor (name, avatar) as it is, for
 * a platform user a sync that can't sync everywhere writes as.
 */
export type Identity = { principal: Granted; author: Author; actor: Actor; records?: false }

/**
 * A caller board() verified, and what its policy lets it do: a request's, or for work a backend does
 * outside requests, the one it does it for (a schedule's creator, at its send). A backend trusts it
 * as it is: only board() makes one, in process.
 */
export type VerifiedCaller = { identity: Identity; origin: WriteOrigin }

/** This deployment's own code, as it calls the backend through board(). */
export type SelfCaller = {
  /**
   * A handle (`via: client`, with the profile from `as(profile)`, or null for the board's own), a
   * watcher, the middleware's handle (`via: middleware`), or sync (`via: engine`). Each backend
   * decides who that is on its board: `board:client` and `board:client:<profile>` on local(), the
   * token's holder with that profile elsewhere.
   */
  self: string | null
  /**
   * What `as(profile)` asked for, its avatar included, or null for yourself. Absent on the
   * handle itself, whose caller is whoever the environment picks: a backend elsewhere sends
   * the profile `BOARD_AS` or the agent it runs in names.
   */
  profile?: ProfileOption
  origin: WriteOrigin
}

/** Who's calling a backend's method: one board() verified, or this deployment's own code. Every method honors what it may do. */
export type Caller = VerifiedCaller | SelfCaller

/** One method per protocol route: the caller, the parsed input, and the request's signal. */
export type ProtocolMethods = {
  [M in keyof Protocol]: (caller: Caller, input: Protocol[M]['input'], signal: AbortSignal) => Promise<Protocol[M]['output']>
}

/** A route of a backend's own, beside the protocol: http()'s wake-ups. */
export type BackendRoute = {
  method: 'GET' | 'POST'
  /** Under the board's mount, with `:param` segments, e.g. `/wake`. One at a protocol route's path takes its place. */
  path: string
  /** `caller` is this deployment's own code, or null for a request, which board() doesn't verify for it: the route checks what it needs. */
  handle(request: Request, context: { caller: Caller | null; param: string | null }): Promise<Response>
}

/** The subscription sync's outbound runs on, in `BoardBinding.subscriptions`. No watcher's ID starts with `@`. */
export const SYNC = '@sync'

/** What runs on a board's events. */
export type Subscription =
  /** A watcher: every event its tail prints. */
  | { kind: 'tail'; tail: string }
  /** Sync's outbound: every post, change, and thread sync in every channel, as its own code sees them. */
  | { kind: 'sync' }

/** One of board()'s sync entries: its key and its platform. */
export type SyncEntry = { key: string; platform: string }

/** A platform event sync pushed to an inbox, as the backend delivers it back. */
export type InboxDelivery = { event: ExternalEvent; raw: unknown }

/** What a backend gets from the board it serves: once, in memory, when board() is created. */
export type BoardBinding = {
  /**
   * Which of the team's boards this is, as `board({ name })` says it: `security`, or null for the
   * team's default board. A backend that keeps one board, or reaches one by its URL, may leave it
   * unread.
   */
  name: string | null
  /** Whose board it is, as `board({ team })` says it, by the team's ID or slug: null for the team the environment finds. */
  team: string | null
  /** Whether to make the board `name` names when the team has none by that name: `board({ ensure })`, true unless it says false. */
  ensure: boolean
  /** What runs on this board's events, by ID: this project's watchers, and sync's outbound at `SYNC` when it syncs. */
  subscriptions: Record<string, Subscription>
  /**
   * Runs one subscription on an event. A throw is the backend's to retry; `attempt` counts tries
   * from 1, and sync gives up on a delivery, and says so, before the backend stops trying it.
   */
  run(id: string, event: WatcherContext['event'], meta: { trigger: string; attempt: number }): Promise<void>
  /**
   * Runs one platform event this board's sync pushed to the backend's inbox, for a backend that
   * delivers them in-process: one platform thread at a time, in order. `id` is the event's in the
   * inbox, which the writes it makes derive their IDs from. A throw is the backend's to retry.
   */
  receive(key: string, item: InboxDelivery, meta: { id: string; attempt: number; signal: AbortSignal }): Promise<void>
  /** Pulls and runs what this board's sync queued in a backend's inbox, for one that queues them: http()'s, when it's woken. */
  pull(): Promise<number>
  /** board()'s sync entries: what its sync imports through, and what discovery lists. */
  sync: readonly SyncEntry[]
  /**
   * Reads a platform channel or thread with sync entry `key`'s app, which only board() has: what
   * `readSource` answers. 404 `not_synced_here` for an entry it doesn't run.
   */
  readSource(key: string, target: string, limit: number, after: string | null): Promise<SourceRead>
  /** Adds sync entry `key`'s app to a channel, where it opted in: what `joinSource` answers. 404 `not_synced_here` likewise. */
  joinSource(key: string, target: string): Promise<SourceJoin>
  /**
   * The message a platform link names, as each platform this board syncs reads it: the platform,
   * and its own thread and message IDs, the message null for a link to a thread. Any entry of that
   * platform may have synced it, so a lookup tries each. Empty when no entry here reads it. It asks
   * no platform anything.
   */
  locate(url: string): { platform: string; thread: string; message: string | null }[]
  /** The platform's link to a copy sync recorded, by entry `key` here: null when none runs it, or its platform has none. */
  linkOf(key: string, thread: string, message: string): Promise<string | null>
  /**
   * Shows typing in the platform threads a board thread (`messages`, its root first) is synced to,
   * through board()'s sync: what `typing` answers. Answers the threads that took it.
   */
  typing(messages: readonly MessageView[], status: string | undefined): Promise<string[]>
  /**
   * What a principal the backend stored may do now, under board()'s defaults and the board's grants:
   * a schedule's creator at each send, a registrant at each event and pull. Null once it may do nothing.
   * With `grants`, under those instead of the board's grants as they are: a grant write's own
   * snapshot, so what it checks is what it appends to.
   */
  accessNow(principal: Known, grants?: readonly StoredGrant[]): Promise<Access | null>
  /** Which grants, or which rule, decide `channel` for a principal under board()'s `access`, and what they give: what `explain` answers. */
  explain(principal: Known, channel: string): Promise<Decided>
  /** The board's own Vercel project and team, as board() knows them: what discovery names, for clients to mint tokens with. */
  project(): Promise<{ id: string | null; teamId: string | null }>
  /**
   * A handle through board(), as `caller`: what a backend writes for someone outside a request
   * goes through it, so board()'s middleware sees it, a schedule's send as its creator, say. A
   * verified caller's posts keep the IDs they're given.
   */
  handle(caller: Caller): Board
  /** The board's own URL, where a board elsewhere can wake it, once it's known. */
  url(): string | null
}

/** A token a backend issued, as board() checks a request that carries it. */
export type StoredToken = {
  id: string
  name: string
  /** Who minted it, as a schedule keeps its creator: what it may do is worked out again on every request, narrowed by its scope. */
  minter: Known
  pinned: Pinned
  expiresAt: Date
}

/**
 * What a backend that keeps the board keeps of who it trusts: its grants, and the tokens it
 * issued. board() reads them on the requests they decide, as they are then, so a revoke takes
 * effect on the next request.
 */
export type Trust = {
  grants(): Promise<readonly StoredGrant[]>
  /** The token whose secret hashes to `hash`, while it and every token it was minted with are live: null otherwise. */
  token(hash: string): Promise<StoredToken | null>
  /** Whether token `id` and every token it was minted with are live: a schedule made with one stops when it doesn't. */
  live(id: string): Promise<boolean>
}

/**
 * Where a board lives. board() serves the protocol over HTTP: it routes, validates, verifies each
 * caller, applies `access`, runs the middleware, watchers, and sync, and calls these with the caller
 * it verified. A backend stores and answers, honoring what each caller may do.
 */
export interface Backend extends ProtocolMethods {
  /** Routes of its own, beside the protocol: one at a protocol route's path takes its place. */
  readonly routes: readonly BackendRoute[]
  /**
   * Whether the board lives here. One that keeps it (`local()`) serves requests: its people, the
   * board's own deployments, and whoever its grants and tokens let in. One that uses another board
   * (Vercel's, or one at `BOARD_URL`) answers only wake-ups and webhooks.
   */
  readonly keeps: boolean
  /**
   * Whether a schedule's sends come back through board(), as local()'s do, so its middleware screens
   * each. A backend whose sends post elsewhere, as vercel()'s do from Vercel's API, says false, and
   * board() screens a schedule's message once, when it's made. True when left out.
   */
  readonly sendsSchedulesHere?: boolean
  /** Its grants and tokens, for a backend that keeps them (`local()`): board() checks requests against them. */
  readonly trust?: Trust
  /**
   * board() calls it once, when it's created, before any request: what background work needs
   * from the board (its subscriptions, its sync, its policy, a handle through it). It does no I/O.
   */
  bind(board: BoardBinding): void
}
