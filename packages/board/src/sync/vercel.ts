// `@vercel/board/sync-vercel`: Vercel's own events, as its webhooks send them, onto a board.
import { z } from 'zod'
import { block } from '../contract/blocks.ts'
import type { ExternalAuthor } from '../contract/external.ts'
import { MESSAGE_TEXT_MAX } from '../contract/schemas.ts'
import { envelope, eventSchema } from './events.ts'
import type { SyncFn } from './fn.ts'
import { SyncProvider, type Receive, type ResolvedTarget, type SyncContext } from './provider.ts'

/** A webhook delivery's body, as Vercel sends it: the event's ID and type, and what it's about. */
export const VercelWebhook = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  createdAt: z.number().optional(),
  payload: z.looseObject({}).optional(),
})
export type VercelWebhook = z.infer<typeof VercelWebhook>

const [messageEvent] = eventSchema('vercel', 'event').options
/** A Vercel event on its way in: `name` is the webhook's type (`deployment.error`), and `raw` the delivery. */
export const VercelEvent = messageEvent.extend({ name: z.string().min(1), raw: VercelWebhook })
export type VercelEvent = z.infer<typeof VercelEvent>

export type VercelOptions = {
  /**
   * The webhook's secret, which signs each delivery (`x-vercel-signature`), or a check of your own
   * for requests something in front of the board already verified.
   */
  secret: string | ((request: Request) => boolean | Promise<boolean>)
  /**
   * The platform channel a delivery is in, which the sync function routes by. By default its
   * project's ID, or `team` for an event with none.
   */
  channel?: (request: Request, delivery: VercelWebhook) => string
}

type Payload = {
  name?: unknown
  target?: unknown
  url?: unknown
  project?: { id?: unknown; name?: unknown }
  deployment?: { id?: unknown; name?: unknown; url?: unknown; inspectorUrl?: unknown; meta?: Record<string, unknown> }
  domain?: { name?: unknown }
  links?: { deployment?: unknown; project?: unknown }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
const payloadOf = (delivery: VercelWebhook) => (delivery.payload ?? {}) as Payload

/** What a deployment event says happened, after `<project>: <target> deployment`. */
const DEPLOYMENT: Record<string, string> = {
  'deployment.created': 'started',
  'deployment.error': 'failed',
  'deployment.succeeded': 'succeeded',
  'deployment.ready': 'is ready',
  'deployment.canceled': 'was canceled',
  'deployment.promoted': 'was promoted',
  'deployment.checks.failed': 'failed its checks',
  'deployment.checks.succeeded': 'passed its checks',
}

/** The branch a deployment was made from, when its Git provider said. */
function branchOf({ deployment }: Payload): string | null {
  const meta = deployment?.meta ?? {}
  return text(meta.githubCommitRef) ?? text(meta.gitlabCommitRef) ?? text(meta.bitbucketCommitRef)
}

/**
 * What an event is about, which names its thread: a project's deployments on one branch (or to one
 * target, with no branch), a domain, a project, or with none of those, the event's own type.
 */
function subjectOf(delivery: VercelWebhook): string {
  const payload = payloadOf(delivery)
  const project = text(payload.project?.id)
  if (delivery.type.startsWith('deployment') && project) return `deployment:${project}:${branchOf(payload) ?? text(payload.target) ?? 'preview'}`
  const domain = text(payload.domain?.name)
  if (domain) return `domain:${domain}`
  return project ? `project:${project}` : delivery.type
}

/** One line a person reads, and the link that opens what it's about. */
function summaryOf(delivery: VercelWebhook): { line: string; url: string | null } {
  const payload = payloadOf(delivery)
  const project = text(payload.name) ?? text(payload.deployment?.name) ?? text(payload.project?.name) ?? text(payload.project?.id)
  const happened = DEPLOYMENT[delivery.type]
  if (happened && project) {
    const branch = branchOf(payload)
    return {
      line: `${project}: ${text(payload.target) ?? 'preview'} deployment ${happened}${branch ? ` (${branch})` : ''}`,
      url: text(payload.links?.deployment) ?? text(payload.deployment?.inspectorUrl),
    }
  }
  const about = text(payload.domain?.name) ?? project
  return { line: about ? `${delivery.type}: ${about}` : delivery.type, url: text(payload.links?.project) }
}

/** A schema's name from an event's type: `vercel.deployment.error` for `deployment.error`. */
const schemaOf = (type: string) => `vercel.${type.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}@1`

/**
 * A delivery as a message: the line a person reads, its link, and the payload as a block agents
 * read. A payload the message has no room for stays off it: the line and the link still say what
 * happened.
 */
function messageOf(delivery: VercelWebhook): string {
  const { line, url } = summaryOf(delivery)
  const head = url ? `${line}\n${url}` : line
  if (!delivery.payload) return head
  const data = block(schemaOf(delivery.type), delivery.payload)
  return head.length + data.length + 2 > MESSAGE_TEXT_MAX ? head : `${head}\n\n${data}`
}

const author = (key: string): ExternalAuthor => ({ id: `${key}:user:vercel`, handle: 'vercel', name: 'Vercel', avatar: null, isBot: true })

/** Whether `signature` is the HMAC-SHA1 of `body` under `secret`, as Vercel signs a delivery: compared in constant time. */
async function signed(secret: string, body: string, signature: string | null): Promise<boolean> {
  if (!signature) return false
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const expected = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  if (expected.length !== signature.length) return false
  let different = 0
  for (let i = 0; i < expected.length; i++) different |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return different === 0
}

/**
 * Brings Vercel's events onto the board: `options` says how a delivery is verified, and `sync` what
 * each event does, like `into('deploys')`. Each lands as a message from Vercel, with its payload as
 * a block, in one thread per thing it's about. Nothing goes back: Vercel's events only come in.
 */
export function vercel(options: VercelOptions, sync: SyncFn<VercelEvent>): VercelProvider {
  return new VercelProvider(options, sync)
}

export class VercelProvider extends SyncProvider<VercelEvent> {
  private readonly config: VercelOptions

  constructor(options: VercelOptions, sync: SyncFn<VercelEvent>) {
    super({ platform: 'vercel' }, sync)
    this.config = options
  }

  async receive(key: string, request: Request, emit: Receive): Promise<Response> {
    const { secret } = this.config
    // A check of your own gets the request whole, body included: reading it here first would leave it none to read.
    const checked = typeof secret === 'string' ? null : request.clone()
    const body = await request.text()
    // Nothing of the body is parsed before the delivery is verified.
    const verified = typeof secret === 'string' ? await signed(secret, body, request.headers.get('x-vercel-signature')) : await secret(checked!)
    if (!verified) return new Response('invalid signature', { status: 401 })
    let delivery: VercelWebhook
    try {
      delivery = VercelWebhook.parse(JSON.parse(body))
    } catch {
      return new Response('not a Vercel webhook delivery', { status: 400 })
    }
    const channel = `${key}:${this.config.channel?.(request, delivery) ?? text(payloadOf(delivery).project?.id) ?? 'team'}`
    await emit({
      dedupe: delivery.id,
      raw: delivery,
      event: {
        kind: 'message',
        channel,
        thread: `${channel}:${subjectOf(delivery)}`.slice(0, 300),
        subthread: null,
        message: delivery.id,
        isRoot: false,
        text: messageOf(delivery),
        context: null,
        author: author(key),
      },
    })
    return new Response(null, { status: 200 })
  }

  async resolveChannel(name: string): Promise<string> {
    return name
  }

  async resolveTarget(): Promise<ResolvedTarget> {
    throw new Error("Vercel's events only come in: a board thread syncs to none")
  }

  async post(): Promise<never> {
    throw new Error("Vercel's events only come in: nothing is sent back")
  }

  override event(context: SyncContext): VercelEvent {
    const raw = VercelWebhook.parse(context.raw)
    return VercelEvent.parse({ ...envelope(this.platform, context.key, context.event, raw, context.id), type: 'event', name: raw.type })
  }
}
