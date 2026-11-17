import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp, useBoard, vb } from './cli-harness.ts'

useBoard()

const SANDBOX = '{"type":"object","required":["id","action"],"additionalProperties":false,"properties":{"id":{"type":"string"},"action":{"enum":["started","stopped"]},"config":{"type":"object"}}}'
const F = '```'

describe('cli blocks', () => {
  it('posts JSON as a message that is only its block, from an argument, stdin, or a file, and reads it back as data', async () => {
    expect((await vb(['schemas', 'create', 'sandbox@1', '--data', SANDBOX])).stdout).toBe('created sandbox@1\n')
    const posted = await vb(['post', 'deploys', '--schema', 'sandbox@1', '{"id":"sbx-123","action":"started","config":{"vcpus":4}}'])
    expect(posted).toMatchObject({ code: 0, stderr: '' })
    const root = posted.stdout.trim()
    expect((await vb(['reply', root, '--schema', 'sandbox@1', '-'], {}, '{ "id": "sbx-123",\n  "action": "stopped" }\n')).code).toBe(0)
    const dir = await tmp('blocks-')
    await writeFile(join(dir, 'event.json'), '{"id":"sbx-124","action":"started"}\n')
    expect((await vb(['reply', root, '--schema', 'sandbox@1', '--file', 'event.json'], {}, undefined, dir)).code).toBe(0)

    // A person reads each as one line of data, in full.
    const read = await vb(['read', root])
    expect(read.stdout.split('\n').filter((line) => line.includes('data '))).toEqual([
      '      data sandbox@1 · {"id":"sbx-123","action":"started","config":{"vcpus":4}}',
      '    data sandbox@1 · {"id":"sbx-123","action":"stopped"}',
      '    data sandbox@1 · {"id":"sbx-124","action":"started"}',
    ])
    expect(read.stdout).not.toContain(F)

    // A program reads the data itself, and the text as it was written.
    const json = JSON.parse((await vb(['read', root, '--json'])).stdout) as { message: { text: string; blocks: unknown[] }; replies: { blocks: unknown[] }[] }
    expect(json.message.blocks).toEqual([{ schema: 'sandbox', version: 1, data: { id: 'sbx-123', action: 'started', config: { vcpus: 4 } } }])
    expect(json.replies.map((reply) => reply.blocks)).toEqual([
      [{ schema: 'sandbox', version: 1, data: { id: 'sbx-123', action: 'stopped' } }],
      [{ schema: 'sandbox', version: 1, data: { id: 'sbx-124', action: 'started' } }],
    ])
    expect(json.message.text.startsWith(`${F}json#sandbox@1\n`)).toBe(true)
  }, 60_000)

  it('shows a block among prose where its fence was, and edits a message into one', async () => {
    expect((await vb(['schemas', 'create', 'sandbox@1', '--data', SANDBOX])).code).toBe(0)
    const text = `sandbox sbx-200 started\n\n${F}json#sandbox@1\n{ "id": "sbx-200", "action": "started" }\n${F}\n\nmore soon`
    const root = (await vb(['post', 'deploys', '-'], {}, text)).stdout.trim()
    expect((await vb(['read', root])).stdout.split('\n').slice(1, 6)).toEqual(['      sandbox sbx-200 started', '      ', '      data sandbox@1 · {"id":"sbx-200","action":"started"}', '      ', '      more soon'])

    expect((await vb(['edit', root, '--schema', 'sandbox@1', '{"id":"sbx-200","action":"stopped"}'])).code).toBe(0)
    expect((await vb(['read', root])).stdout).toContain('      data sandbox@1 · {"id":"sbx-200","action":"stopped"}')
    expect((await vb(['read', root])).stdout).not.toContain('more soon')
  }, 60_000)

  it("says which field doesn't match, and where to see what the schema holds", async () => {
    expect((await vb(['schemas', 'create', 'sandbox@1', '--data', SANDBOX])).code).toBe(0)
    const before = (await vb(['read', 'deploys', '--json'])).stdout
    const mismatch = await vb(['post', 'deploys', '--schema', 'sandbox@1', '{"id":"sbx-9","action":"boot"}'])
    expect(mismatch).toMatchObject({ code: 2, stdout: '' })
    expect(mismatch.stderr).toMatch(/^error: Can't post to deploys\.\n {2}the sandbox@1 block doesn't match its schema: action must be "started" or "stopped"\n\n {2}See what sandbox@1 holds:\n {4}vb schemas inspect sandbox@1\n$/)

    const unknown = await vb(['post', 'deploys', '--schema', 'sandbox@9', '{"id":"sbx-9"}', '--json'])
    expect(unknown.code).toBe(2)
    expect(JSON.parse(unknown.stderr)).toMatchObject({ status: 'error', reason: 'schema_not_found' })

    // Before it asks the board anything: text that isn't the schema's JSON, and a schema that names none.
    const misuses: [string[], RegExp][] = [
      [['post', 'deploys', '--schema', 'sandbox@1', 'sbx-9 started'], /^error: With --schema, the text is sandbox@1's JSON, and this isn't JSON\.\n/],
      [['post', 'deploys', '--schema', 'sandbox@1', '["sbx-9"]'], /^error: With --schema, the text is a JSON object, like \{"id":"sbx-123"\}\.\n/],
      [['post', 'deploys', '--schema', 'sandbox', '{"id":"sbx-9"}'], /^error: sandbox doesn't name a schema\. One is name@version, like sandbox@1\.\n/],
      [['post', 'deploys', '--schema', 'sandbox@1'], /^error: Missing the message's text/],
    ]
    for (const [args, stderr] of misuses) expect(await vb(args), args.join(' ')).toMatchObject({ code: 2, stdout: '', stderr: expect.stringMatching(stderr) })
    // None of it posted anything.
    expect((await vb(['read', 'deploys', '--json'])).stdout).toBe(before)
  }, 60_000)
})
