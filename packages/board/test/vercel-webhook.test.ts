import { createHmac } from 'node:crypto'
import { expect, it } from 'vitest'
import { blocksIn } from '../src/contract/blocks.ts'
import { into } from '../src/sync/fn.ts'
import type { ReceivedEvent } from '../src/sync/provider.ts'
import { vercel, type VercelOptions } from '../src/sync/vercel.ts'

const secret = 'whsec_test'

function setup(options: VercelOptions = { secret }) {
  const provider = vercel(options, into('deploys'))
  return async (delivery: unknown, headers: Record<string, string> = {}) => {
    const body = JSON.stringify(delivery)
    const request = new Request('https://board.test/webhooks/deploys', {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-vercel-signature': createHmac('sha1', secret).update(body).digest('hex'), ...headers },
    })
    const received: ReceivedEvent[] = []
    const response = await provider.receive('deploys', request, async (event) => void received.push(event))
    return { status: response.status, received }
  }
}

const deployment = (type: string, id: string, branch = 'main') => ({
  id, type, createdAt: 1_790_000_000_000,
  payload: {
    name: 'web', target: 'production', project: { id: 'prj_web' },
    deployment: { id: `dpl_${id}`, name: 'web', url: 'web-abc.vercel.app', meta: { githubCommitRef: branch } },
    links: { deployment: `https://vercel.com/acme/web/dpl_${id}`, project: 'https://vercel.com/acme/web' },
  },
})

it("lands a delivery as a message from Vercel: a line to read, its link, and the payload as a block", async () => {
  const send = setup()
  const failed = deployment('deployment.error', 'evt_1')
  const { status, received } = await send(failed)
  expect(status).toBe(200)
  expect(received).toHaveLength(1)
  const { event, dedupe, raw } = received[0]!
  expect([dedupe, raw]).toEqual(['evt_1', failed])
  expect(event).toMatchObject({
    kind: 'message',
    channel: 'deploys:prj_web',
    thread: 'deploys:prj_web:deployment:prj_web:main',
    message: 'evt_1',
    author: { id: 'deploys:user:vercel', name: 'Vercel', isBot: true },
  })
  const text = event.kind === 'message' ? event.text : ''
  expect(text.split('\n').slice(0, 2)).toEqual(['web: production deployment failed (main)', 'https://vercel.com/acme/web/dpl_evt_1'])
  expect(blocksIn(text)).toEqual([{ schema: 'vercel.deployment.error', version: 1, data: failed.payload }])
})

it("keeps a project's deployments on one branch in one thread, and another branch's in another", async () => {
  const send = setup()
  const threads = []
  for (const [type, id, branch] of [['deployment.error', 'evt_1', 'main'], ['deployment.succeeded', 'evt_2', 'main'], ['deployment.error', 'evt_3', 'fix/login']] as const)
    threads.push((await send(deployment(type, id, branch))).received[0]!.event.thread)
  expect(threads).toEqual(['deploys:prj_web:deployment:prj_web:main', 'deploys:prj_web:deployment:prj_web:main', 'deploys:prj_web:deployment:prj_web:fix/login'])
})

it('threads any other event by the domain or project it names, or by its type with neither', async () => {
  const send = setup()
  const thread = async (type: string, payload: object) => (await send({ id: `evt_${type}`, type, payload })).received[0]!.event
  expect(await thread('domain.renewal.failed', { domain: { name: 'acme.com' } })).toMatchObject({ channel: 'deploys:team', thread: 'deploys:team:domain:acme.com' })
  expect(await thread('project.env-variable.created', { project: { id: 'prj_web' } })).toMatchObject({ channel: 'deploys:prj_web', thread: 'deploys:prj_web:project:prj_web' })
  expect(await thread('marketplace.invoice.paid', {})).toMatchObject({ channel: 'deploys:team', thread: 'deploys:team:marketplace.invoice.paid' })
})

it('takes nothing from a delivery its secret did not sign', async () => {
  const send = setup()
  const { status, received } = await send(deployment('deployment.error', 'evt_1'), { 'x-vercel-signature': createHmac('sha1', 'another').update('{}').digest('hex') })
  expect([status, received]).toEqual([401, []])
  const unsigned = await vercel({ secret }, into('deploys')).receive('deploys', new Request('https://board.test/webhooks/deploys', { method: 'POST', body: '{}' }), async () => {
    throw new Error('emitted')
  })
  expect(unsigned.status).toBe(401)
})

it('leaves a payload the message has no room for off it, and still says what happened', async () => {
  const send = setup()
  const big = deployment('deployment.error', 'evt_1')
  const { received } = await send({ ...big, payload: { ...big.payload, deployment: { ...big.payload.deployment, meta: { githubCommitRef: 'main', githubCommitMessage: 'x'.repeat(12_000) } } } })
  const { event } = received[0]!
  expect(event.kind === 'message' && event.text).toBe('web: production deployment failed (main)\nhttps://vercel.com/acme/web/dpl_evt_1')
})

it('lets what runs it verify a delivery itself, and say which channel it is in', async () => {
  const seen: string[] = []
  const send = setup({
    secret: (request) => {
      seen.push(request.headers.get('x-checked-by') ?? 'no one')
      return request.headers.get('x-checked-by') === 'host'
    },
    channel: (request) => request.headers.get('x-board-sync')!,
  })
  expect((await send(deployment('deployment.error', 'evt_1'), { 'x-vercel-signature': 'unsigned' })).status).toBe(401)
  const { received } = await send(deployment('deployment.error', 'evt_2'), { 'x-vercel-signature': 'unsigned', 'x-checked-by': 'host', 'x-board-sync': 'syn_1' })
  expect(received[0]!.event).toMatchObject({ channel: 'deploys:syn_1', thread: 'deploys:syn_1:deployment:prj_web:main' })
  expect(seen).toEqual(['no one', 'host'])
})

it('hands a check of your own the request whole, so one that reads the body verifies it, and the delivery still lands', async () => {
  const bodies: string[] = []
  const send = setup({
    secret: async (request) => {
      bodies.push(await request.text())
      return true
    },
  })
  const delivery = deployment('deployment.error', 'evt_1')
  const { status, received } = await send(delivery)
  expect(status).toBe(200)
  expect(bodies).toEqual([JSON.stringify(delivery)])
  expect(received[0]!.event).toMatchObject({ message: 'evt_1' })
})
