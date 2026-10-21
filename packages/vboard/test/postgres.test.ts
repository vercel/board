import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// The engine itself, as a2() starts it.
import { mount as board } from './harness.ts'
import { postgres } from '../src/store/postgres.ts'
import type { BoardStore } from '../src/store/types.ts'
import { BOARD_URL, caller, PROJECT_ID, personToken, TEAM_ID, testAuth } from './harness.ts'

// The production shape: A2's Postgres store and vboard's tables on one real database.
// Runs when TEST_DATABASE_URL points at a server that may create databases (CI has one).
const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('vboard on Postgres', () => {
  const name = `vboard_test_${process.pid}_${Date.now()}`
  let database: string
  let store: BoardStore

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url })
    await admin.connect()
    await admin.query(`create database ${name}`)
    await admin.end()
    const at = new URL(url!)
    at.pathname = `/${name}`
    database = at.toString()
    const setup = new pg.Client({ connectionString: database })
    await setup.connect()
    await setup.query(readFileSync(join(import.meta.dirname, '..', 'sql', 'postgres', 'schema.sql'), 'utf8'))
    await setup.end()
    store = postgres({ connectionString: database })
  })

  afterAll(async () => {
    await store?.close()
    const admin = new pg.Client({ connectionString: url })
    await admin.connect()
    await admin.query(`drop database if exists ${name} with (force)`)
    await admin.end()
  })

  it('posts, replies, labels, and reads back from its tables', async () => {
    const mounted = board({ store, url: BOARD_URL, project: { id: PROJECT_ID, teamId: TEAM_ID }, auth: testAuth })
    const julian = caller(mounted.fetch, await personToken())
    const root = await julian('POST', '/messages', { channel: 'dev', text: 'Deploy is red', labels: { kind: 'bug' } })
    expect(root.status).toBe(201)
    const id = root.body.message.id as string
    await julian('POST', '/messages', { re: id, text: 'looking' })
    await julian('POST', '/messages', { re: id, text: 'fixed' })
    await julian('POST', `/messages/${id}/labels`, { set: { status: 'done' } })

    // A write's own read sees it at once: the tables are caught up before it answers.
    const thread = await julian('GET', `/messages/${id}`)
    expect(thread.body.message.labels).toEqual({ kind: 'bug', status: 'done' })
    expect(thread.body.replies.map((reply: { text: string }) => reply.text)).toEqual(['looking', 'fixed'])

    const filtered = await julian('GET', '/messages?label=status=done&text=red')
    expect(filtered.body.messages.map((m: { id: string }) => m.id)).toEqual([id])
    const threads = await julian('GET', '/threads?channel=dev')
    expect(threads.body.threads).toEqual([expect.objectContaining({ replies: 2, last: expect.objectContaining({ text: 'fixed' }) })])
    expect(Number(threads.body.cursor)).toBeGreaterThanOrEqual(Number(id))
  })

  it('shares a pool it was given between A2 and the tables', async () => {
    const pool = new pg.Pool({ connectionString: database, max: 3 })
    const shared = postgres({ client: pool })
    const mounted = board({ store: shared, url: BOARD_URL, project: { id: PROJECT_ID, teamId: TEAM_ID }, auth: testAuth })
    const julian = caller(mounted.fetch, await personToken())
    const root = await julian('POST', '/messages', { channel: 'pool', text: 'one pool' })
    await julian('POST', '/messages', { re: root.body.message.id, text: 'for both' })
    const thread = await julian('GET', `/messages/${root.body.message.id}`)
    expect(thread.body.replies.map((reply: { text: string }) => reply.text)).toEqual(['for both'])
    await shared.close()
    expect(pool.ending).toBe(true)
  })

  it('says which file to apply when the tables are missing', async () => {
    const at = new URL(url!)
    at.pathname = '/postgres'
    const missing = postgres({ connectionString: at.toString() })
    await expect(missing.tables.message(1)).rejects.toThrow(/apply node_modules\/vboard\/sql\/postgres\/schema\.sql/)
    await missing.close()
  })
})
