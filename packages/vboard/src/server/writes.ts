import { randomUUID } from 'node:crypto'
import { idempotentId } from 'experimental-a2'
import type { BoardEvent, Link, Origin } from '../contract/contract.ts'
import {
  actorsReducer,
  foldMessages,
  messagesReducer,
  postedReducer,
  syncReducer,
  type Actor,
  type ActorsState,
  type Message,
} from '../contract/reducers.ts'
import type { Attachment, Author, Labels } from '../contract/schemas.ts'
import type { Principal } from './auth.ts'
import { authorize, FULL_ACCESS, type Access, type Permission, type Proof } from './access.ts'
import { actorSeen, resolveMentions } from './actors.ts'
import { extractMentions, replaceMentions } from '../contract/mentions.ts'
import type { BoardSession } from './board.ts'
import { badRequest, duplicateId, forbidden, notFound } from './errors.ts'
import { view } from './feed.ts'
import type { ResolvedTarget } from '../sync/provider.ts'
import type { BoardClient } from '../client/client.ts'
import { runMiddleware, type Middleware, type WriteSource } from './middleware.ts'

/** Who a write is attributed to. */
export type Identity = { principal: Principal; author: Author; actor: Actor }

/** A piece of the board's own deployment, writing as `actor` with full access. */
export function deploymentIdentity(actor: string, handle: string): Identity {
  return {
    principal: { id: actor, kind: 'deployment', handle, access: FULL_ACCESS, expiresAt: null },
    author: { actor, principal: actor, profile: null, session: null },
    actor: { id: actor, kind: 'deployment', handle, name: handle, avatar: null },
  }
}

export type WriteContext = {
  session: BoardSession
  /** External channels a new root in this board channel starts threads in. */
  configTargets: (channel: string) => Promise<ResolvedTarget[]>
  /** Validates a requested target and resolves names (`slack:#prs`) to IDs. */
  normalizeTarget: (target: string) => Promise<ResolvedTarget>
  /** A synced platform's user with this email, for `@[ada@vercel.com]`. */
  findByEmail?: (email: string) => Promise<Actor | null>
  /** Runs on every post and edit, in order, before it lands. */
  middleware?: readonly Middleware[]
  /** The in-process client middleware writes with. */
  middlewareClient?: () => BoardClient
}

/** Where a write came from; `middleware` is the middleware's own client, which skips it. */
export type Via = WriteSource | { kind: 'middleware' }

/** How a write reaches the middleware: where it's from, and how to answer there. */
export type WriteOrigin = { via?: Via; respond?: (text: string) => Promise<void> }

const middlewareFor = (ctx: WriteContext, origin: WriteOrigin) =>
  origin.via?.kind === 'middleware' || !ctx.middleware?.length ? null : ctx.middleware

const sourceOf = (origin: WriteOrigin): WriteSource => (origin.via as WriteSource | undefined) ?? { kind: 'api' }

const middlewareClient = (ctx: WriteContext) => () => {
  if (!ctx.middlewareClient) throw new Error('middleware used before the board bound it')
  return ctx.middlewareClient()
}

/**
 * `@[ada@vercel.com]`: each email a synced platform knows becomes that user's exact
 * mention, `@[slack:user:U0456]`, so it reads natively there; the rest stay plain text.
 */
async function withEmailMentions(ctx: WriteContext, text: string): Promise<{ text: string; found: Actor[] }> {
  const emails = extractMentions(text).flatMap((token) =>
    token.kind === 'actor' && token.actor.includes('@') ? [token.actor] : [],
  )
  if (emails.length === 0) return { text, found: [] }
  const byEmail = new Map<string, Actor | null>()
  for (const email of emails) byEmail.set(email, (await ctx.findByEmail?.(email).catch(() => null)) ?? null)
  return {
    text: replaceMentions(text, (token) => {
      if (token.kind !== 'actor' || !byEmail.has(token.actor)) return null
      const actor = byEmail.get(token.actor)
      return actor ? `@[${actor.id}]` : token.actor
    }),
    found: [...byEmail.values()].filter((actor) => actor !== null),
  }
}

/** The actors a write can mention: the ones the board knows, plus the ones an email named. */
const knownWith = (actors: ActorsState, found: Actor[]): ActorsState =>
  found.length === 0 ? actors : { ...actors, byId: { ...actors.byId, ...Object.fromEntries(found.map((a) => [a.id, a])) } }

const messageNotFound = (id: number) => () => notFound(`message not found: #${id}`, 'message_not_found')

/**
 * A message the board looked up and the caller may act on with `permission`,
 * proved against its own channel. A message they can't read answers 404, as if
 * it didn't exist: IDs are sequential, so a 403 would confirm it does.
 */
export async function authorizeMessage<P extends Permission>(
  ctx: WriteContext,
  access: Access,
  permission: P,
  id: number,
): Promise<{ message: Message; proof: Proof<P> }> {
  const { state } = await ctx.session.state(messagesReducer)
  const message = state.byId[id]
  if (!message) throw messageNotFound(id)()
  return { message, proof: authorize(access, permission, message.channel, messageNotFound(id)) }
}

/**
 * Your own message, to edit or delete: `post` in its channel, and no `read`,
 * so a write-only source can fix what it wrote. Someone else's answers 404
 * where you can't read it, and 403 where you can.
 */
export async function authorizeOwn(
  ctx: WriteContext,
  principal: Principal,
  id: number,
  verb: 'edit' | 'delete',
): Promise<{ message: Message; proof: Proof<'post'> }> {
  const { state } = await ctx.session.state(messagesReducer)
  const message = state.byId[id]
  if (!message) throw messageNotFound(id)()
  if (message.by.principal !== principal.id) {
    if (!principal.access.readable(message.channel)) throw messageNotFound(id)()
    throw forbidden(`only the author can ${verb} a message`)
  }
  return { message, proof: authorize(principal.access, 'post', message.channel) }
}

/** What a post was proved for: `post` where it lands, and `label` and `sync` when it carries them. */
export type PostProofs = { post: Proof<'post'>; label?: Proof<'label'>; sync?: Proof<'sync'> }

const hasLabels = (labels: Labels | undefined) => Object.keys(labels ?? {}).length > 0

/**
 * Proofs for a post. A root lands in the channel it names, which the caller
 * needn't read: write-only is `['post']`. A reply lands in its root's channel,
 * looked up here and never taken from the request, and needs `read` there too,
 * since addressing a thread you can't see would confirm it exists.
 */
export async function authorizePost(
  ctx: WriteContext,
  access: Access,
  input: { channel?: string | undefined; re?: number | undefined; labels?: Labels | undefined; sync?: string[] | undefined },
): Promise<PostProofs> {
  let channel: string
  let post: Proof<'post'>
  if (input.re !== undefined) {
    const { message } = await authorizeMessage(ctx, access, 'read', input.re)
    channel = message.channel
    post = authorize(access, 'post', channel)
  } else {
    if (!input.channel) throw badRequest('a post needs a channel')
    channel = input.channel
    post = authorize(access, 'post', channel)
  }
  return {
    post,
    ...(hasLabels(input.labels) ? { label: authorize(access, 'label', channel) } : {}),
    ...(input.sync?.length ? { sync: authorize(access, 'sync', channel) } : {}),
  }
}

/**
 * Spends a proof on its target: a write checked against one channel can't land
 * in another. A mismatch is the board's own bug, never the caller's.
 */
function spend(proof: Proof | undefined, permission: Permission, target: { channel: string }) {
  if (!proof || proof.permission !== permission || proof.channel !== target.channel)
    throw new Error(`a ${permission} write in ${target.channel} needs a proof for that channel`)
}

/** Full-access proofs for the board's own code (sync), still checked against the channel each write lands in. */
export const trusted = {
  message: <P extends Permission>(ctx: WriteContext, permission: P, id: number) => authorizeMessage(ctx, FULL_ACCESS, permission, id),
  post: (ctx: WriteContext, input: Parameters<typeof authorizePost>[2]) => authorizePost(ctx, FULL_ACCESS, input),
}

export type PostInput = WriteOrigin & {
  identity: Identity
  /** From `authorizePost`. */
  proofs: PostProofs
  channel?: string | undefined
  re?: number | undefined
  text: string
  labels?: Labels | undefined
  noSync?: boolean | undefined
  id?: string | undefined
  sync?: string[] | undefined
  origin?: Origin | null
  from?: string | null
  /** Platform text: mentions the board can't resolve are left as plain text. */
  lenientMentions?: boolean
  /** Files the board stored, as it recorded them. */
  attachments?: Attachment[]
  /** Platform messages it links to. */
  links?: Link[]
  /** The schedule send that posts it. */
  schedule?: { id: number; n: number }
}

export async function writePost(ctx: WriteContext, input: PostInput) {
  const { state: messages } = await ctx.session.state(messagesReducer)
  const { identity } = input
  let channel = input.channel
  let re: number | null = null
  let replyTo: number | null = null
  let thread: string
  const id = input.id ?? (input.re === undefined ? randomUUID() : undefined)
  if (input.re !== undefined) {
    const target = messages.byId[input.re]
    if (!target) throw notFound(`message not found: #${input.re}`, 'message_not_found')
    re = target.re ?? target.id
    replyTo = target.id === re ? null : target.id
    channel = target.channel
    thread = messages.byId[re]!.thread
    if (input.sync?.length)
      throw badRequest('sync attaches whole threads: use `vboard sync <id> <target>`')
  } else {
    if (!channel) throw badRequest('a post needs a channel')
    thread = id!
  }
  spend(input.proofs.post, 'post', { channel })
  if (hasLabels(input.labels)) spend(input.proofs.label, 'label', { channel })
  if (input.sync?.length) spend(input.proofs.sync, 'sync', { channel })

  const chain = middlewareFor(ctx, input)
  if (chain && id !== undefined) {
    // A retry of a write that landed: what's on the board stands, whatever the middleware would say now.
    const { state: posted } = await ctx.session.state(postedReducer)
    const landed = posted[id] === undefined ? undefined : messages.byId[posted[id]]
    if (landed) {
      // Only the same author's post in the same place is a retry. Text and labels can't tell:
      // the middleware may have changed them, and edits may have since.
      if (!sameAuthor(landed.by, identity.author) || landed.channel !== channel || landed.re !== re || landed.replyTo !== replyTo)
        throw duplicateId()
      return view(landed, (await ctx.session.state(actorsReducer)).state)
    }
  }
  if (chain)
    return runMiddleware(
      chain,
      {
        write: { kind: 'post', channel: channel!, re, text: input.text, labels: input.labels ?? {}, attachments: input.attachments ?? [] },
        author: identity.actor,
        source: sourceOf(input),
        board: middlewareClient(ctx),
        ...(input.respond ? { respond: input.respond } : {}),
      },
      (write) => commitPost(ctx, { ...input, text: write.text, labels: write.labels }, { channel: channel!, re, replyTo, thread, id }),
    )
  return commitPost(ctx, input, { channel: channel!, re, replyTo, thread, id })
}

const sameAuthor = (a: Author, b: Author) =>
  a.actor === b.actor && a.principal === b.principal && a.profile === b.profile && a.session === b.session

async function commitPost(
  ctx: WriteContext,
  input: PostInput,
  placed: { channel: string; re: number | null; replyTo: number | null; thread: string; id: string | undefined },
) {
  const { identity } = input
  const { channel, re, replyTo, thread, id } = placed
  const { state: actors } = await ctx.session.state(actorsReducer)
  const targets: { target: string; kind: 'channel' | 'thread'; cause: 'config' | 'request' }[] = []
  if (re === null) {
    const originChannel = input.origin ? input.origin.channel ?? channelOf(input.origin.thread) : null
    if (!input.noSync)
      for (const target of await ctx.configTargets(channel!))
        if (target.target !== originChannel) targets.push({ target: target.target, kind: target.kind, cause: 'config' })
    for (const requested of input.sync ?? []) {
      const target = await ctx.normalizeTarget(requested)
      if (!targets.some((t) => t.target === target.target)) targets.push({ target: target.target, kind: target.kind, cause: 'request' })
    }
  }

  const seen = actorSeen(identity.actor, actors)
  const { text, found } = await withEmailMentions(ctx, input.text)
  const named = found.map((actor) => actorSeen(actor, actors)).filter((event) => event !== null)
  const mentions = resolveMentions(
    text,
    knownWith(actors, found),
    seen ? identity.actor : undefined,
    input.lenientMentions ?? false,
    identity.principal.access.readsAll,
  )
  const synced = await Promise.all(
    targets.map(async ({ target, kind, cause }) => ({
      type: 'thread.synced' as const,
      id: await idempotentId('vboard', thread, 'sync', target),
      payload: { thread, target, kind, cause, by: identity.author },
    })),
  )
  const rows = await ctx.session.append(
    ...(seen ? [seen] : []),
    ...named,
    {
      type: 'message.posted',
      ...(id ? { id } : {}),
      payload: {
        channel: channel!,
        text,
        re,
        replyTo,
        thread,
        labels: input.labels ?? {},
        noSync: input.noSync ?? false,
        mentions,
        by: identity.author,
        origin: input.origin ?? null,
        from: input.from ?? null,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.links?.length ? { links: input.links } : {}),
        ...(input.schedule ? { schedule: input.schedule } : {}),
      },
    },
    ...synced,
  )
  const posted = rows.find((row) => row.type === 'message.posted') as BoardEvent
  const message = foldMessages({ byId: {}, replies: {} }, posted).byId[posted.index]!
  const known = seen ? { ...actors, byId: { ...actors.byId, [identity.actor.id]: identity.actor } } : actors
  return view(message, known)
}

/** `slack:C0123ABC:1727.1` → `slack:C0123ABC`; `github:o/r:12` → `github:o/r`. */
export const channelOf = (externalThread: string) => {
  const at = externalThread.indexOf(':')
  const rest = externalThread.slice(at + 1)
  const colon = rest.indexOf(':')
  return colon === -1 ? externalThread : externalThread.slice(0, at + 1 + colon)
}

/** The message a by-ID write targets, as the board has it, once its proof is for the message's channel. */
async function liveMessage<P extends Permission>(ctx: WriteContext, id: number, permission: P, proof: Proof<P>): Promise<Message> {
  const { state } = await ctx.session.state(messagesReducer)
  const message = state.byId[id]
  if (!message) throw messageNotFound(id)()
  spend(proof, permission, message)
  return message
}

export type EditInput = WriteOrigin & {
  identity: Identity
  proof: Proof<'post'>
  id: number
  text: string
  from?: string | null
  asAuthor?: boolean
}

export async function writeEdit(ctx: WriteContext, input: EditInput) {
  const message = await liveMessage(ctx, input.id, 'post', input.proof)
  if (input.asAuthor !== false && message.by.principal !== input.identity.principal.id)
    throw forbidden('only the author can edit a message')
  if (message.deleted) throw badRequest('message was deleted', 'message_deleted')
  const chain = middlewareFor(ctx, input)
  if (!chain) return commitEdit(ctx, input, message)
  return runMiddleware(
    chain,
    {
      write: { kind: 'edit', id: message.id, channel: message.channel, re: message.re, text: input.text },
      author: input.identity.actor,
      source: sourceOf(input),
      board: middlewareClient(ctx),
      ...(input.respond ? { respond: input.respond } : {}),
    },
    (write) => commitEdit(ctx, { ...input, text: write.text }, message),
  )
}

async function commitEdit(ctx: WriteContext, input: EditInput, message: Message) {
  const { state: actors } = await ctx.session.state(actorsReducer)
  const seen = actorSeen(input.identity.actor, actors)
  const { text, found } = await withEmailMentions(ctx, input.text)
  const named = found.map((actor) => actorSeen(actor, actors)).filter((event) => event !== null)
  const mentions = resolveMentions(
    text,
    knownWith(actors, found),
    seen ? input.identity.actor : undefined,
    input.from != null,
    input.identity.principal.access.readsAll,
  )
  await ctx.session.append(...(seen ? [seen] : []), ...named, {
    type: 'message.edited',
    payload: {
      id: message.id,
      thread: message.thread,
      text,
      mentions,
      by: input.identity.author,
      from: input.from ?? null,
    },
  })
}

/** A message's links, replaced: a platform edit or unfurl changed what it links to. */
export async function writeLinks(
  ctx: WriteContext,
  input: { identity: Identity; proof: Proof<'post'>; id: number; links: Link[]; from: string | null },
) {
  const message = await liveMessage(ctx, input.id, 'post', input.proof)
  if (message.deleted) return
  await ctx.session.append({
    type: 'message.linked',
    payload: { id: message.id, thread: message.thread, links: input.links, by: input.identity.author, from: input.from },
  })
}

export async function writeDelete(
  ctx: WriteContext,
  input: { identity: Identity; proof: Proof<'post'>; id: number; from?: string | null; asAuthor?: boolean },
) {
  const message = await liveMessage(ctx, input.id, 'post', input.proof)
  if (input.asAuthor !== false && message.by.principal !== input.identity.principal.id)
    throw forbidden('only the author can delete a message')
  if (message.deleted) return
  await ctx.session.append({
    type: 'message.deleted',
    payload: { id: message.id, thread: message.thread, by: input.identity.author, from: input.from ?? null },
  })
}

export async function writeReaction(
  ctx: WriteContext,
  input: { identity: Identity; proof: Proof<'react'>; id: number; emoji: string; remove?: boolean; from?: string | null },
) {
  const message = await liveMessage(ctx, input.id, 'react', input.proof)
  if (message.deleted) throw badRequest('message was deleted', 'message_deleted')
  const { state: actors } = await ctx.session.state(actorsReducer)
  const seen = actorSeen(input.identity.actor, actors)
  await ctx.session.append(...(seen ? [seen] : []), {
    type: input.remove ? 'reaction.removed' : 'reaction.added',
    payload: {
      id: message.id,
      thread: message.thread,
      emoji: input.emoji,
      by: input.identity.author,
      from: input.from ?? null,
    },
  })
}

export async function writeLabels(
  ctx: WriteContext,
  input: { identity: Identity; proof: Proof<'label'>; id: number; set?: Labels | undefined; unset?: string[] | undefined },
) {
  const message = await liveMessage(ctx, input.id, 'label', input.proof)
  if (message.deleted) throw badRequest('message was deleted', 'message_deleted')
  const { state: actors } = await ctx.session.state(actorsReducer)
  const seen = actorSeen(input.identity.actor, actors)
  await ctx.session.append(...(seen ? [seen] : []), {
    type: 'labels.changed',
    payload: {
      id: message.id,
      thread: message.thread,
      set: input.set ?? {},
      unset: input.unset ?? [],
      by: input.identity.author,
    },
  })
}

/** Attaches a thread to an external target. Attaching twice is a no-op. */
export async function writeAttach(
  ctx: WriteContext,
  input: { identity: Identity; proof: Proof<'sync'>; id: number; target: string },
) {
  const message = await liveMessage(ctx, input.id, 'sync', input.proof)
  const { target, kind } = await ctx.normalizeTarget(input.target)
  const { state: sync } = await ctx.session.state(syncReducer)
  if (sync.threads[message.thread]?.targets.includes(target)) return { target, attached: false }
  await ctx.session.append({
    type: 'thread.synced',
    id: await idempotentId('vboard', message.thread, 'sync', target),
    payload: { thread: message.thread, target, kind, cause: 'request', by: input.identity.author },
  })
  return { target, attached: true }
}
