import type { Protocol } from '../api/protocol.ts'
import type { MessageView, SourceJoin, SourceRead } from '../api/routes.ts'
import type { ProfileOption } from '../client/client.ts'
import type { ExternalEvent } from '../contract/external.ts'
import type { Actor } from '../contract/folds.ts'
import type { Author } from '../contract/schemas.ts'
import type { Access } from './access.ts'
import type { Granted, Known } from './auth.ts'
import type { Board } from './board.ts'
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
   * decides who that is on its board: `board:client` and `board:client:<profile>` on a2(), the
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
  | { kind: 'tail'; tail: string; when: 'matches' | 'enters' }
  /** Sync's outbound: every post, change, and thread sync in every channel, as its own code sees them. */
  | { kind: 'sync' }

/** One of board()'s sync entries: its key, its platform, and whether it can sign people in. */
export type SyncEntry = { key: string; platform: string; signIn: boolean }

/** A platform event sync pushed to an inbox, as the backend delivers it back. */
export type InboxDelivery = { event: ExternalEvent; raw: unknown }

/** What a backend gets from the board it serves: once, in memory, when board() is created. */
export type BoardBinding = {
  /** What runs on this board's events, by ID: this project's watchers, and sync's outbound at `SYNC` when it syncs. */
  subscriptions: Record<string, Subscription>
  /**
   * Runs one subscription on an event. A throw is the backend's to retry; `attempt` counts tries
   * from 1, and sync gives up on a delivery, and says so, before A2 would dead-letter it.
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
  readSource(key: string, target: string, limit: number): Promise<SourceRead>
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
   * What a principal the backend stored may do now, under board()'s `access`: a schedule's creator
   * at each send, a registrant at each event and pull. Null once it may do nothing.
   */
  accessNow(principal: Known): Promise<Access | null>
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

/**
 * Where a board lives. board() serves the protocol over HTTP: it routes, validates, verifies each
 * caller, applies `access`, runs the middleware, watchers, and sync, and calls these with the caller
 * it verified. A backend stores and answers, honoring what each caller may do.
 */
export interface Backend extends ProtocolMethods {
  /** Routes of its own, beside the protocol: one at a protocol route's path takes its place. */
  readonly routes: readonly BackendRoute[]
  /**
   * Whether the board lives here. One that keeps it (`a2()`) lets in, when board()'s `access` is left
   * out, its people and the board's own deployments; one that uses another board (`http()`) serves no
   * requests then but wake-ups and webhooks, and with an `access`, serves its callers as that board's
   * project.
   */
  readonly keeps: boolean
  /**
   * board() calls it once, when it's created, before any request: what background work needs
   * from the board (its subscriptions, its sync, its policy, a handle through it). It does no I/O.
   */
  bind(board: BoardBinding): void
}
