import { describe, expect, it } from 'vitest'
import { byVercelBot, displayText as display, vercelDeployments, VERCEL_BOT } from '../src/contract/bots.ts'
import { formatMessage } from '../src/cli/format.ts'
import type { MessageView } from '../src/api/routes.ts'
import { VERCEL_BUILDING, VERCEL_WITH_SKIPPED } from './vercel-fixtures.ts'

const displayText = (text: string) => display(text, true)

describe('known bot messages', () => {
  it('reads the deployments out of a Vercel for GitHub comment', () => {
    expect(vercelDeployments(VERCEL_BUILDING)).toEqual([
      {
        project: 'acme-agents',
        projectUrl: 'https://vercel.com/acme/acme-agents',
        status: 'Building',
        deploymentUrl: 'https://vercel.com/acme/acme-agents/7ZEaNBTETQjaUF4Bd1VCxbM8rR3n',
        previewUrl: 'https://acme-agents-git-pi-224.acme.dev',
        updated: 'Oct 6, 2026 8:30pm UTC',
        updatedAt: '2026-10-06T20:30:32.400Z',
        skipped: false,
      },
    ])
    const [built, skipped] = vercelDeployments(VERCEL_WITH_SKIPPED)!
    expect(built).toMatchObject({ project: 'acme-agents', status: 'Building', skipped: false })
    expect(skipped).toMatchObject({ project: 'vboard', status: 'Ignored', previewUrl: null, skipped: true, updated: 'Oct 6, 2026 5:25pm UTC', updatedAt: '2026-10-06T17:25:54.038Z' })
    // A time Vercel wrote only in words, or one that isn't a time, is no time.
    expect(vercelDeployments(VERCEL_BUILDING.replace(/<relative-time[^>]*>([^<]*)<\/relative-time>/, '$1'))![0]).toMatchObject({ updated: 'Oct 6, 2026 8:30pm UTC', updatedAt: null })
    expect(vercelDeployments(VERCEL_BUILDING.replace('datetime="2026-10-06T20:30:32.400Z"', 'datetime="soon"'))![0]).toMatchObject({ updatedAt: null })
  })

  it('shows one line per deployment, without the marker, the HTML, or the table', () => {
    const text = displayText(VERCEL_WITH_SKIPPED)
    expect(text).toBe(
      [
        '**▲ Vercel**',
        '- ⏳ **[acme-agents](https://vercel.com/acme/acme-agents)** · [Building](https://vercel.com/acme/acme-agents/AKYQCQiM4Vf5Zp1AAcH6nQDYUC4n) · [Preview](https://acme-agents-git-changeset-release-main.acme.dev) · Oct 6, 2026 5:25pm UTC',
        '- ⚪ **[vboard](https://vercel.com/acme/vboard)** · [Ignored](https://vercel.com/acme/vboard/Go3sKM9tee9TraPTMa71Haa1uZzj) (skipped) · Oct 6, 2026 5:25pm UTC',
      ].join('\n'),
    )
    expect(displayText(VERCEL_BUILDING.replace(/building/gi, 'Ready'))).toContain('- ✅ **[acme-agents]')
    expect(displayText(VERCEL_BUILDING.replace(/building/gi, 'Error'))).toContain('- ❌ **[acme-agents]')
  })

  it('leaves every other message alone, even one that quotes a Vercel table', () => {
    expect(displayText('hello')).toBe('hello')
    const quoted = `look at this:\n${VERCEL_BUILDING}`
    expect(displayText(quoted)).toBe(quoted)
  })

  it('only reads Vercel comments that Vercel wrote', () => {
    expect(display(VERCEL_BUILDING, false)).toBe(VERCEL_BUILDING)
    expect(display(VERCEL_BUILDING, true)).toContain('- ⏳ **[acme-agents]')
  })

  it("takes a sync's checked import of the bot from GitHub for the bot, and nothing that only looks like it", () => {
    const sync = 'vercel:project:prj_web:production'
    const by = (profile: string | null, actor = profile === null ? VERCEL_BOT : `${sync}+${profile}`) => ({ actor, profile })
    const imported = { kind: 'external', platform: 'github', verified: true as const }
    expect(byVercelBot({ by: by(null), from: 'github' }, null)).toBe(true)
    expect(byVercelBot({ by: by(VERCEL_BOT), from: 'github' }, imported)).toBe(true)
    // Another GitHub user, one the board didn't check, one from another platform, and a write that isn't an import.
    expect(byVercelBot({ by: by('github:user:42'), from: 'github' }, imported)).toBe(false)
    expect(byVercelBot({ by: by(VERCEL_BOT), from: 'github' }, { kind: 'external', platform: 'github' })).toBe(false)
    expect(byVercelBot({ by: by(VERCEL_BOT), from: 'github' }, { ...imported, platform: 'slack' })).toBe(false)
    expect(byVercelBot({ by: by(VERCEL_BOT), from: null }, imported)).toBe(false)
    expect(byVercelBot({ by: by(VERCEL_BOT), from: 'github' }, { ...imported, kind: 'agent' })).toBe(false)
  })

  it('reads a comment with CRLF line endings', () => {
    expect(displayText(VERCEL_WITH_SKIPPED.replace(/\n/g, '\r\n'))).toBe(
      [
        '**▲ Vercel**',
        '- ⏳ **[acme-agents](https://vercel.com/acme/acme-agents)** · [Building](https://vercel.com/acme/acme-agents/AKYQCQiM4Vf5Zp1AAcH6nQDYUC4n) · [Preview](https://acme-agents-git-changeset-release-main.acme.dev) · Oct 6, 2026 5:25pm UTC',
        '- ⚪ **[vboard](https://vercel.com/acme/vboard)** · [Ignored](https://vercel.com/acme/vboard/Go3sKM9tee9TraPTMa71Haa1uZzj) (skipped) · Oct 6, 2026 5:25pm UTC',
      ].join('\n'),
    )
  })

  it('shows the readable form in vb read, and the original in --json', () => {
    const message = {
      id: 253, channel: 'dev', text: VERCEL_BUILDING, re: null, replyTo: null, labels: {}, reactions: {}, createdAt: new Date().toISOString(), editedAt: null,
      deleted: false, attachments: [], undelivered: {}, by: { actor: 'github:user:35613825', principal: 'github:user:35613825', profile: null },
      author: { kind: 'external', handle: 'vercel[bot]', name: 'vercel[bot]', avatar: null },
    } as unknown as MessageView
    const out = formatMessage(message)
    expect(out).toContain('⏳ **[acme-agents]')
    expect(out).not.toContain('[vc]:')
    expect(out).not.toContain('<relative-time')
  })
})
