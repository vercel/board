import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { compileAccess, FULL_ACCESS, InvalidCan } from '../src/access/index.ts'

// What `@vercel/board/access` gives a backend that decides access itself, as Vercel's API does.

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void

describe('@vercel/board/access', () => {
  it('throws an InvalidCan, code invalid_can, for a can that does not parse', () => {
    for (const can of [{ 'feedback/*': ['post'] }, ['write'], { 'Not A Channel': ['read'] }] as never[]) {
      let thrown: unknown
      try {
        compileAccess(can)
      } catch (error) {
        thrown = error
      }
      expect(thrown, JSON.stringify(can)).toBeInstanceOf(InvalidCan)
      expect((thrown as InvalidCan).code).toBe('invalid_can')
    }
  })

  it('remembers a bounded number of channels, however many a long-lived access is asked about', () => {
    for (const [name, access] of [
      ['everything', FULL_ACCESS],
      ['nothing', compileAccess([])],
      ['a pattern', compileAccess({ '*': ['read'], 'secret/': [] })],
    ] as const) {
      gc()
      const before = process.memoryUsage().heapUsed
      for (let i = 0; i < 200_000; i++) access.readable(`team/channel-${i}`)
      gc()
      expect(process.memoryUsage().heapUsed - before, name).toBeLessThan(4 * 1024 * 1024)
    }
  })

  it('answers what it may read the same once it has started over', () => {
    const access = compileAccess({ '*': ['read'], 'secret/': [] })
    for (let i = 0; i < 10_000; i++) expect(access.readable(i % 2 ? `secret/${i}` : `team/${i}`)).toBe(i % 2 === 0)
    expect([access.readable('secret'), access.readable('team'), FULL_ACCESS.readable('secret'), compileAccess([]).readable('team')]).toEqual([false, true, true, false])
  })
})
