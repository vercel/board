import { describe, expect, it } from 'vitest'
import { useBoard, vb } from './cli-harness.ts'

useBoard()

describe('cli tokens and grants', () => {
  it('mints a token that posts as you only where it may, lists it, and revokes it', async () => {
    const minted = await vb(['tokens', 'create', 'feedback-widget', '--can', 'feedback/=post'])
    expect(minted).toMatchObject({ code: 0, stderr: '' })
    const secret = minted.stdout.trim()
    expect(secret).toMatch(/^board_[A-Za-z0-9_-]{43}$/)

    // Whoever holds it is you, narrowed: a coding agent with it writes as itself under you.
    const widget = { BOARD_TOKEN: secret, CLAUDECODE: '1' }
    const whoami = await vb(['whoami'], widget)
    expect(whoami.stdout).toMatch(/^claude via julian \(vercel:user:u_julian\+claude\)\n/)
    expect(whoami.stdout).toMatch(/\ncan +feedback\/ +post\n/)
    expect((await vb(['post', 'feedback/web', 'love the new board'], widget)).code).toBe(0)
    const refused = await vb(['post', 'dev', 'not here'], widget)
    expect(refused.code).toBe(1)
    expect(refused.stderr).toMatch(/can't post in dev/)

    const listed = await vb(['tokens', 'list'])
    expect(listed.stdout).toMatch(/^t\d+ +feedback-widget +feedback\/=post +expires in 30d\n$/)
    const id = listed.stdout.split(' ')[0]!
    expect((await vb(['tokens', 'revoke', id])).stdout).toBe(`revoked ${id}\n`)
    expect((await vb(['tokens', 'revoke', id])).stdout).toBe(`${id} isn't a live token of yours\n`)
    const revoked = await vb(['post', 'feedback/web', 'again'], widget)
    expect(revoked).toMatchObject({ code: 1, stderr: expect.stringMatching(/^error: The board didn't accept your credentials\.\n {2}invalid token: revoked, expired, or not this board's\n[\s\S]*Pass a token it accepts in BOARD_TOKEN, or unset it/) })
    expect(revoked.stderr).not.toContain('vercel login')
    expect((await vb(['tokens', 'list'])).stdout).toBe('no tokens\n')
  }, 30_000)

  it('lists the grants the board starts with, who each names and what it lets them do, and revokes one', async () => {
    expect((await vb(['grants'])).stdout).toBe(
      [
        'g1  --all-users                                                  everything',
        'g2  --all-projects --environment production,preview,development  read post react label',
        'g3  --all-apps                                                   read post react label',
        '',
      ].join('\n'),
    )
    expect((await vb(['grants', 'revoke', 'g2'])).stdout).toBe('revoked g2\n')
    expect((await vb(['grants', 'revoke', 'g2'])).stdout).toBe('g2 is already gone\n')
    expect((await vb(['grants', 'list'])).stdout).toBe('g1  --all-users  everything\ng3  --all-apps   read post react label\n')
  }, 30_000)

  it('lists with tokens alone, and names a subcommand it lacks', async () => {
    expect((await vb(['tokens', 'create', 'ci-bot', '--can', 'ci/=post'])).code).toBe(0)
    expect(await vb(['tokens'])).toMatchObject({ code: 0, stdout: expect.stringMatching(/^t\d+ +ci-bot +ci\/=post +expires in 30d\n$/) })
    expect(await vb(['tokens', 'mint', 'x'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: Unknown command mint for vb tokens\.\n/) })
  })
})
