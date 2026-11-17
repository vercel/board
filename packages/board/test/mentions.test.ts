import { describe, expect, it } from 'vitest'
import { extractMentions, settleMentions } from '../src/contract/mentions.ts'
import { importedHandle, typableHandle } from '../src/contract/profiles.ts'
import type { ActorsState, Message } from '../src/contract/folds.ts'
import { compileFilter } from '../src/server/feed.ts'
import { FULL_ACCESS } from '../src/server/access.ts'

describe('extractMentions', () => {
  it('finds handles and profile handles in prose, in order', () => {
    expect(extractMentions('hey @Ada and @julian/claude, see @ada')).toEqual([
      { kind: 'handle', handle: 'ada' },
      { kind: 'handle', handle: 'julian/claude' },
    ])
  })

  it('ignores mentions inside code', () => {
    expect(extractMentions('run `@ada` and\n```\n@bob\n```\nthen @carol')).toEqual([
      { kind: 'handle', handle: 'carol' },
    ])
  })

  it('ignores emails and trailing punctuation', () => {
    expect(extractMentions('mail ada@example.com, ping @bob.')).toEqual([
      { kind: 'handle', handle: 'bob' },
    ])
  })

  it('takes a colon after a handle as punctuation, and not one that joins it to more', () => {
    expect(extractMentions('@ada: can you look?\n@julian/claude:\nand @bob:')).toEqual([
      { kind: 'handle', handle: 'ada' },
      { kind: 'handle', handle: 'julian/claude' },
      { kind: 'handle', handle: 'bob' },
    ])
    expect(extractMentions('see @slack:U0456 and @media:print')).toEqual([])
  })

  it('reads exact actor mentions', () => {
    expect(extractMentions('cc @[slack:T0123:U0456] and @ada')).toEqual([
      { kind: 'actor', actor: 'slack:T0123:U0456' },
      { kind: 'handle', handle: 'ada' },
    ])
  })
})

describe('a mentions filter', () => {
  const nobody: ActorsState = { byId: {}, byHandle: {} }
  const message = (text: string) => ({ id: 1, channel: 'dev', text, re: null }) as Message

  it('takes names every object has as names nobody has', () => {
    const matcher = (name: string) => compileFilter({ mentions: name }, { me: null, actors: nobody, access: FULL_ACCESS })
    for (const name of ['constructor', 'toString', 'valueOf']) {
      const matches = matcher(name)
      expect([matches(message(`thanks @${name}`)), matches(message(`cc @[${name}]`)), matches(message('thanks @someone'))], name).toEqual([true, true, false])
    }
    expect([matcher('__proto__')(message('cc @[__proto__]')), matcher('__proto__')(message('cc @[someone]'))]).toEqual([true, false])
  })
})

describe("an imported platform user's handle", () => {
  it('is typable as a mention, and made so in one pass, however long a run of punctuation it holds', () => {
    expect(typableHandle('Malte Ubl', 'user:U_MALTE')).toBe('malte-ubl')
    // Diacritics come off first, so what's left reads as the name.
    expect(typableHandle('Jürgen', 'user:U_J')).toBe('jurgen')
    expect(typableHandle('--.Ünïcode_ ', 'user:U_X')).toBe('unicode')
    // With nothing left, their ID on the platform, the same way.
    expect(typableHandle('🙂', 'T_EU:U0MALTE')).toBe('t_eu-u0malte')
    // A run a trim by regex would backtrack over from every dash in it.
    const long = `x${'-'.repeat(200_000)}x`
    const started = performance.now()
    expect(typableHandle(long, 'user:U_X')).toBe(long)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it("fits the 128 characters a handle holds under its principal's name, cut on whole characters with the ends trimmed again", () => {
    expect(importedHandle('support', 'a'.repeat(125), 'user:U1')).toBe(`support/${'a'.repeat(120)}`)
    // A cut that ends on a separator trims it off, as the rule does.
    expect(importedHandle('support', `${'a'.repeat(119)}--b`, 'user:U1')).toBe(`support/${'a'.repeat(119)}`)
    expect(importedHandle('support', 'Malte Ubl', 'user:U1')).toBe('support/malte-ubl')
  })
})

describe('settleMentions', () => {
  const ada = { id: 'vercel:user:u_ada', handle: 'ada', name: 'Ada Lovelace' }
  const claude = { id: 'vercel:user:u_ada+claude', handle: 'ada/claude', name: 'claude' }
  const malte = { id: 'vercel:project:prj_support:production+slack:user:U1', handle: 'support/malte', name: 'Malte Ubl' }
  const otherMalte = { id: 'vercel:project:prj_www:production+slack:user:U9', handle: 'www/malte', name: 'Malte' }

  it('writes the one actor a handle names as @[actor-id], and says who', () => {
    expect(settleMentions('hey @Ada, cc @support/malte and @ada again', [ada, claude, malte])).toEqual({
      text: 'hey @[vercel:user:u_ada], cc @[vercel:project:prj_support:production+slack:user:U1] and @[vercel:user:u_ada] again',
      mentions: [
        { written: '@Ada', actor: ada, candidates: [] },
        { written: '@support/malte', actor: malte, candidates: [] },
      ],
    })
  })

  it("takes no one for a handle they only have under a name, and says who that is", () => {
    // A project could import a Malte to take the name, so `@malte` is never `support/malte`.
    expect(settleMentions('@malte and @claude', [ada, claude, malte])).toEqual({
      text: '@malte and @claude',
      mentions: [
        { written: '@malte', actor: null, candidates: [malte] },
        { written: '@claude', actor: null, candidates: [claude] },
      ],
    })
    // Someone who has it in full is the one it names, whoever else has it under a name.
    const support = { id: 'vercel:project:prj_support:production', handle: 'malte', name: 'malte' }
    expect(settleMentions('@malte', [malte, support]).mentions).toEqual([{ written: '@malte', actor: support, candidates: [] }])
  })

  it('leaves a handle no one has, or several have, as typed, and says who goes by it', () => {
    expect(settleMentions('@nobody and @malte, @www/malte', [ada, malte, otherMalte])).toEqual({
      text: `@nobody and @malte, @[${otherMalte.id}]`,
      mentions: [
        { written: '@nobody', actor: null, candidates: [] },
        { written: '@malte', actor: null, candidates: [malte, otherMalte] },
        { written: '@www/malte', actor: otherMalte, candidates: [] },
      ],
    })
  })

  it('takes the one its caller prefers of several who have a handle in full', () => {
    const twin = { id: 'vercel:user:u_ada2', handle: 'ada', name: 'Ada B.' }
    expect(settleMentions('@ada', [ada, twin]).mentions).toEqual([{ written: '@ada', actor: null, candidates: [ada, twin] }])
    const settled = settleMentions('@ada', [ada, twin], (candidates) => candidates.find((actor) => actor.id === twin.id) ?? null)
    expect(settled).toEqual({ text: `@[${twin.id}]`, mentions: [{ written: '@ada', actor: twin, candidates: [] }] })
  })

  it('leaves exact mentions, emails, code, and addresses alone', () => {
    const text = 'cc @[vercel:user:u_x] and @[ada@acme.com], run `@ada` or mail ada@acme.com'
    expect(settleMentions(text, [ada])).toEqual({ text, mentions: [] })
  })
})
