import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { caller, personToken, testBoard } from './harness.ts'

// What `@vercel/board/schemas` gives a server that keeps a board itself, as Vercel's API does: the
// board's own rules, from the package it installs.

const require = createRequire(import.meta.url)
const entry = require.resolve('@vercel/board/schemas')
const rules = () => import(pathToFileURL(entry).href) as Promise<typeof import('../src/schemas/index.ts')>

const SANDBOX = { type: 'object', required: ['id', 'action'], properties: { id: { type: 'string' }, action: { enum: ['started', 'stopped'] } } }

describe('@vercel/board/schemas', () => {
  it('ships with nothing to import, so a server loads the rules and nothing else of board', async () => {
    expect(entry).toMatch(/dist\/schemas\.mjs$/)
    const seen = new Set<string>()
    const walk = async (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const code = await readFile(file, 'utf8')
      for (const [, specifier] of code.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)) {
        // Only chunks of its own, beside it: no package, and nothing of Node's.
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\//)
        await walk(join(dirname(file), specifier!))
      }
      expect(code).not.toMatch(/\bimport\(\s*["'](?!\.\/)/)
    }
    await walk(entry)
  })

  it('reads who a text mentions by ID as a board on the same version does, for its inboxes', async () => {
    const { mentionedActors } = await rules()
    const julian = 'vercel:user:u_julian'
    // Twice by ID, then where nothing counts: in code, as an email, as a handle typed, and in a fence.
    const text = `for @[${julian}], and @[${julian}] again: not \`@[vercel:user:u_val]\`, @[val@example.com], or @val\n\`\`\`\n@[vercel:user:u_val]\n\`\`\``
    expect(mentionedActors(text)).toEqual([julian])
    const board = testBoard()
    const posted = await caller(board.fetch, await personToken('u_ada'))('POST', '/messages', { channel: 'dev', text })
    const inboxOf = async (user: string) => (await caller(board.fetch, await personToken(user))('GET', '/me/inbox')).body.items.map((item: { thread: string }) => item.thread)
    expect(await inboxOf('u_julian')).toEqual([posted.body.message.id])
    expect(await inboxOf('u_val')).toEqual([])
  })

  it('decides what a board on the same version decides: a definition, a block, and a value', async () => {
    const { canonical, checkDefinition, checkValue, findBlocks, block, parseSchemaId, BUILT_IN_SCHEMAS } = await rules()
    const board = testBoard()
    const julian = caller(board.fetch, await personToken())
    const register = (schema: unknown) => julian('POST', '/schemas', { name: 'sandbox', version: 1, schema })
    const post = (text: string) => julian('POST', '/messages', { channel: 'deploys', text })

    // A definition the rule refuses, the board refuses, and one it takes, the board keeps.
    const withRef = { type: 'object', properties: { next: { $ref: '#' } } }
    expect(checkDefinition(withRef)).not.toBeNull()
    expect((await register(withRef)).status).toBe(400)
    expect(checkDefinition(SANDBOX)).toBeNull()
    expect((await register(SANDBOX)).status).toBe(200)

    // Two definitions it calls the same, the board takes as one version, and two it tells apart, it refuses.
    const reordered = { properties: SANDBOX.properties, required: SANDBOX.required, type: 'object' }
    expect(canonical(reordered)).toBe(canonical(SANDBOX))
    expect((await register(reordered)).body.created).toBe(false)
    const other = { ...SANDBOX, required: ['id'] }
    expect(canonical(other)).not.toBe(canonical(SANDBOX))
    expect((await register(other)).status).toBe(409)

    // A block it finds and a value it checks are what the board checks on a write.
    const good = block('sandbox@1', { id: 'sbx-1', action: 'started' })
    const bad = block('sandbox@1', { id: 'sbx-1', action: 'boot' })
    for (const [text, status] of [[good, 201], [bad, 400], [`\`\`\`\`\n${bad}\n\`\`\`\``, 201]] as const) {
      const problems = findBlocks(text).map((found) => found.problem ?? checkValue(SANDBOX, found.data))
      expect(problems.every((problem) => problem === null), text).toBe(status === 201)
      expect((await post(text)).status, text).toBe(status)
    }
    expect((await post(good)).body.message.blocks).toEqual(findBlocks(good).map(({ name, version, data }) => ({ schema: name, version, data })))

    // And it names schemas, and has the built-ins, as the board lists them.
    expect(parseSchemaId('sandbox@1')).toEqual({ name: 'sandbox', version: 1 })
    expect(parseSchemaId('Sandbox')).toBeNull()
    const listed = (await julian('GET', '/schemas')).body.schemas as { name: string; version: number; schema: unknown; builtIn: boolean }[]
    expect(listed.filter((schema) => schema.builtIn).map(({ name, version, schema }) => ({ name, version, schema }))).toEqual(BUILT_IN_SCHEMAS.map(({ name, version, schema }) => ({ name, version, schema })))
  })
})
