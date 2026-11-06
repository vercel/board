import { describe, expect, it } from 'vitest'
import {
  authorize,
  compileAccess,
  expand,
  FULL_ACCESS,
  IMPLIES,
  parsePattern,
  parseScope,
  PERMISSIONS,
  type Access,
  type Can,
  type Permission,
} from '../src/server/access.ts'
import * as publicAccess from '../src/access/index.ts'
import { HttpError } from '../src/server/errors.ts'

const CHANNELS = ['dev', 'dev/pi', 'dev/pi/deep', 'devops', 'ci', 'ci/main', 'security', 'security/vuln', 'feedback']

/** Every channel's permissions, as a table, so a whole map is checked at once. */
const table = (access: Access) =>
  Object.fromEntries(CHANNELS.map((channel) => [channel, PERMISSIONS.filter((permission) => access.can(permission, channel))]))

describe('permissions', () => {
  it('implies read from every verb that addresses a message, and everything from manage', () => {
    // A truth table, like the git broker's: what each permission brings in.
    expect(Object.fromEntries(PERMISSIONS.map((permission) => [permission, [...expand([permission])].sort()]))).toEqual({
      read: ['read'],
      post: ['post'],
      react: ['react', 'read'],
      label: ['label', 'read'],
      sync: ['read', 'sync'],
      manage: [...PERMISSIONS].sort(),
    })
    expect(expand('all')).toEqual(new Set(PERMISSIONS))
  })

  it('keeps write-only write-only: post implies nothing', () => {
    expect(IMPLIES.post).toEqual([])
    const access = compileAccess(['post'])
    expect(access.can('post', 'feedback')).toBe(true)
    expect(access.readable('feedback')).toBe(false)
    expect(access.readsAll).toBe(false)
  })

  it('rejects a permission it doesn’t know', () => {
    expect(() => compileAccess(['write' as Permission])).toThrow('unknown permission write: use read, post, react, label, sync, manage')
  })
})

describe('channel patterns', () => {
  it('reads *, a channel, and a channel with its subtree', () => {
    expect(parsePattern('*')).toEqual({ kind: 'all' })
    expect(parsePattern('dev')).toEqual({ kind: 'exact', path: 'dev' })
    expect(parsePattern('dev/')).toEqual({ kind: 'subtree', path: 'dev' })
    expect(parsePattern('www/production/')).toEqual({ kind: 'subtree', path: 'www/production' })
  })

  it('refuses every other *, and says what to type', () => {
    expect(() => parsePattern('feedback/*')).toThrow('invalid channel pattern feedback/*: write feedback/ for feedback and its subtree')
    expect(() => parsePattern('feedback/**')).toThrow('write feedback/ for feedback and its subtree')
    expect(() => parsePattern('a/*/b')).toThrow('write a/ for a and its subtree')
    expect(() => parsePattern('feed*')).toThrow('write feed/ for feed and its subtree')
    expect(() => parsePattern('**')).toThrow('write * for every channel')
    expect(() => parsePattern('*/')).toThrow('write * for every channel')
  })

  it('refuses what isn’t a channel', () => {
    for (const pattern of ['', '/', 'Dev', 'dev//', '/dev', 'dev pi', '-dev'])
      expect(() => parsePattern(pattern), pattern).toThrow('write *, a channel, or a channel and its subtree (feedback/)')
  })

  it('throws at config time, not at the first request', () => {
    expect(() => compileAccess({ 'feedback/*': ['post'] })).toThrow('write feedback/ for feedback and its subtree')
  })
})

describe('resolution', () => {
  it('lets the most specific pattern decide: an exact channel, then the longest subtree, then *', () => {
    const access = compileAccess({
      '*': ['read'],
      'dev/': ['read', 'post'],
      'dev/pi/': ['react'],
      dev: 'all',
      security: [],
    })
    expect(table(access)).toEqual({
      dev: [...PERMISSIONS],
      'dev/pi': ['read', 'react'],
      'dev/pi/deep': ['read', 'react'],
      devops: ['read'], // `dev/` is dev and what's under it, not every name that starts with dev
      ci: ['read'],
      'ci/main': ['read'],
      security: [],
      'security/vuln': ['read'], // an exact channel doesn't cover its subtree
      feedback: ['read'],
    })
  })

  it('hides a subtree with an empty list: deny without a deny verb', () => {
    const access = compileAccess({ '*': 'all', 'security/': [] })
    expect(access.readable('security')).toBe(false)
    expect(access.readable('security/vuln')).toBe(false)
    expect(access.can('manage', 'dev')).toBe(true)
    expect(access.readsAll).toBe(false)
    expect(access.everywhere('manage')).toBe(false)
  })

  it('gives nothing where nothing matches', () => {
    const access = compileAccess({ 'ci/': ['read', 'post'] })
    expect(table(access)).toMatchObject({ ci: ['read', 'post'], 'ci/main': ['read', 'post'], dev: [], feedback: [] })
    expect(compileAccess({}).anywhere('read')).toBe(false)
    expect(compileAccess([]).anywhere('read')).toBe(false)
  })

  it('reads the array shorthand as every channel', () => {
    expect(table(compileAccess(['post']))).toEqual(table(compileAccess({ '*': ['post'] })))
    expect(table(compileAccess('all'))).toEqual(table(compileAccess({ '*': 'all' })))
  })

  it('knows full access, readers of everything, and what exists somewhere', () => {
    expect(FULL_ACCESS.everywhere('manage')).toBe(true)
    expect(FULL_ACCESS.readsAll).toBe(true)
    const reader = compileAccess({ '*': ['read'], 'ci/': ['read', 'post'] })
    expect(reader.readsAll).toBe(true)
    expect(reader.everywhere('post')).toBe(false)
    expect(reader.anywhere('post')).toBe(true)
    expect(reader.anywhere('label')).toBe(false)
  })

  it('remembers what it has resolved for a channel', () => {
    const access = compileAccess({ 'dev/': ['read'] })
    expect(access.readable('dev/pi')).toBe(true)
    expect(access.readable('dev/pi')).toBe(true)
    expect(access.readable('ci')).toBe(false)
  })
})

describe('summary', () => {
  it('lists each pattern with its implications, * first', () => {
    expect(compileAccess({ 'ci/': ['post', 'react'], '*': ['read'], dev: ['label'] }).summary()).toEqual({
      '*': ['read'],
      'ci/': ['read', 'post', 'react'],
      dev: ['read', 'label'],
    })
    expect(FULL_ACCESS.summary()).toEqual({ '*': [...PERMISSIONS] })
  })

  it('says the same thing one way: no empty *, no rule that repeats its parent', () => {
    expect(compileAccess({ '*': [], 'ci/': ['read'], 'ci/main': ['read'], 'ci/main/': ['read'] }).summary()).toEqual({ 'ci/': ['read'] })
    expect(compileAccess({ '*': 'all', 'dev/': 'all', 'security/': [] }).summary()).toEqual({ '*': [...PERMISSIONS], 'security/': [] })
    expect(compileAccess([]).summary()).toEqual({})
  })
})

describe('narrowing', () => {
  const cases: [string, Can, Can][] = [
    ['full access, scoped to dev', 'all', { 'dev/': ['read', 'post', 'react', 'label'], 'ci/': ['read'] }],
    ['a hidden subtree stays hidden', { '*': 'all', 'security/': [] }, { '*': ['read', 'post'] }],
    ['a scope can’t add what was never there', { 'ci/': ['read'] }, 'all'],
    ['subtrees on both sides', { 'dev/': 'all', 'dev/pi/': ['read'] }, { dev: ['post'], 'dev/pi/deep': ['read', 'react'], '*': ['read'] }],
    ['implications survive', { '*': ['label'] }, { '*': ['react', 'label'] }],
  ]

  for (const [name, mine, scope] of cases)
    it(`is the intersection, channel by channel: ${name}`, () => {
      const narrowed = compileAccess(mine).narrow(scope)
      const a = compileAccess(mine)
      const b = compileAccess(scope)
      for (const channel of CHANNELS)
        for (const permission of PERMISSIONS)
          expect(narrowed.can(permission, channel), `${permission} in ${channel}`).toBe(a.can(permission, channel) && b.can(permission, channel))
    })

  it('is the intersection for any two maps, and its summary says the same thing', () => {
    const patterns = ['*', 'dev/', 'dev', 'dev/pi/', 'dev/pi', 'ci/', 'security', 'security/']
    const grants: Can[] = [[], ['read'], ['post'], ['label'], ['read', 'post'], 'all']
    let seed = 7
    const next = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
    const random = (): Can =>
      Object.fromEntries(patterns.filter(() => next(3) === 0).map((pattern) => [pattern, grants[next(grants.length)]!])) as Can
    for (let i = 0; i < 300; i++) {
      const [mine, scope] = [random(), random()]
      const a = compileAccess(mine)
      const b = compileAccess(scope)
      const narrowed = a.narrow(scope)
      for (const channel of CHANNELS)
        for (const permission of PERMISSIONS)
          expect(narrowed.can(permission, channel)).toBe(a.can(permission, channel) && b.can(permission, channel))
      expect(table(compileAccess(narrowed.summary() as Can))).toEqual(table(narrowed))
      expect(table(compileAccess(a.summary() as Can))).toEqual(table(a))
    }
  })

  it('can only narrow', () => {
    const access = compileAccess({ 'ci/': ['read'] })
    expect(access.narrow('all').summary()).toEqual({ 'ci/': ['read'] })
    expect(FULL_ACCESS.narrow({ 'dev/': ['read', 'post'] }).summary()).toEqual({ 'dev/': ['read', 'post'] })
    expect(FULL_ACCESS.narrow(access).summary()).toEqual(access.summary())
    expect(FULL_ACCESS.narrow([]).anywhere('read')).toBe(false)
  })
})

describe('x-board-scope', () => {
  it('reads patterns and their permissions', () => {
    expect(parseScope('dev/=read,post,react,label;ci/=read')).toEqual({ 'dev/': ['read', 'post', 'react', 'label'], 'ci/': ['read'] })
    expect(parseScope(' dev/ = read , post ; ')).toEqual({ 'dev/': ['read', 'post'] })
    expect(parseScope('*=all')).toEqual({ '*': 'all' })
    expect(parseScope('security/=')).toEqual({ 'security/': [] })
  })

  it('refuses what it can’t read, so a typo never widens anything', () => {
    expect(() => parseScope('')).toThrow('x-board-scope is empty')
    expect(() => parseScope('dev/')).toThrow('x-board-scope entry dev/ needs =')
    expect(() => parseScope('dev/=write')).toThrow('unknown permission write')
    expect(() => parseScope('dev/=read,')).toThrow('unknown permission (empty)')
    expect(() => parseScope('dev/*=read')).toThrow('write dev/ for dev and its subtree')
    expect(() => parseScope('dev/=read;dev/=post')).toThrow('x-board-scope lists dev/ twice')
  })

  it('reads a channel named like something every object has as any other', () => {
    expect(parseScope('constructor=read;tostring/=post')).toEqual({ constructor: ['read'], 'tostring/': ['post'] })
    expect(() => parseScope('constructor=read;constructor=post')).toThrow('x-board-scope lists constructor twice')
  })
})

describe('authorize', () => {
  const access = compileAccess({ 'feedback/': ['post'], 'dev/': ['read', 'react'] })
  const missing = () => new HttpError(404, 'message_not_found', 'message not found: #7')

  it('returns a proof that carries the channel it checked', () => {
    const proof = authorize(access, 'post', 'feedback/front')
    expect(proof).toEqual({ permission: 'post', channel: 'feedback/front' })
    expect(Object.isFrozen(proof)).toBe(true)
  })

  it('refuses a write you can read with a 403 that names what’s missing', () => {
    const error = (() => {
      try {
        authorize(access, 'label', 'dev', missing)
      } catch (error) {
        return error as HttpError
      }
    })()
    expect(error).toMatchObject({ status: 403, message: "this token can't label in dev" })
  })

  it('answers as if it didn’t exist where you can’t read', () => {
    expect(() => authorize(access, 'react', 'feedback', missing)).toThrow('message not found: #7')
    expect(() => authorize(access, 'react', 'security', missing)).toThrow('message not found: #7')
  })

  it('refuses with a 403 when there’s nothing to hide, like a new thread’s own channel', () => {
    expect(() => authorize(access, 'post', 'dev')).toThrow("this token can't post in dev")
    expect(() => authorize(compileAccess([]), 'read', 'dev')).toThrow("this token can't read dev")
  })
})

describe('@vercel/board/access', () => {
  it('evaluates a can on its own, for a copy of these rules to check itself against', () => {
    const ci = publicAccess.compileAccess({ 'ci/': ['post'] })
    expect(ci.can('post', 'ci/main')).toBe(true)
    expect(ci.readable('ci/main')).toBe(false)
    expect(publicAccess.union([ci, publicAccess.compileAccess({ dev: ['label'] })]).summary()).toEqual({ 'ci/': ['post'], dev: ['read', 'label'] })
    expect(publicAccess.FULL_ACCESS.everywhere('manage')).toBe(true)
    expect(() => publicAccess.compileAccess({ 'ci/*': ['post'] })).toThrow('write ci/ for ci and its subtree')
  })

  it("can't be changed by code that imports it, so board's own decisions stay its own", () => {
    const stub = () => {
      ;(publicAccess.FULL_ACCESS as { can: Access['can'] }).can = () => false
    }
    expect(stub).toThrow(TypeError)
    expect(publicAccess.FULL_ACCESS.can('manage', 'dev')).toBe(true)
    expect(() => Object.assign(publicAccess.compileAccess(['read']), { readsAll: false })).toThrow(TypeError)
  })

  it("can't have its default can widened by code that imports it", () => {
    const defaults = publicAccess.DEFAULT_CAN as Record<string, Permission[]>
    expect(() => defaults['*']!.push('manage')).toThrow(TypeError)
    expect(() => {
      defaults.dev = ['manage']
    }).toThrow(TypeError)
    expect(compileAccess(publicAccess.DEFAULT_CAN).anywhere('manage')).toBe(false)
    expect(compileAccess(publicAccess.DEFAULT_CAN).summary()).toEqual({ '*': ['read', 'post', 'react', 'label'] })
  })

  it('gives a token that names no can read, post, react, and label everywhere', () => {
    expect(publicAccess.compileAccess(publicAccess.DEFAULT_CAN).summary()).toEqual({ '*': ['read', 'post', 'react', 'label'] })
  })

  it('adds up only accesses it made: anything else counts as nothing', () => {
    const handWritten = { can: () => true, readable: () => true, readsAll: true, everywhere: () => true, anywhere: () => true } as unknown as Access
    expect(publicAccess.union([handWritten]).anywhere('read')).toBe(false)
    expect(publicAccess.union([handWritten, publicAccess.compileAccess({ dev: ['read'] })]).summary()).toEqual({ dev: ['read'] })
  })
})
