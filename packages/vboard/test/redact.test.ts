import { describe, expect, it } from 'vitest'
import { redact, redactPII } from '../src/server/index.ts'
import { caller, personToken, testBoard } from './harness.ts'

describe('redact', () => {
  it('strips emails, phone numbers, card numbers, and secrets', () => {
    expect(redact('mail ada@example.com or ada.lovelace+vb@mail.co.uk')).toBe('mail [email] or [email]')
    expect(redact('call +1 415 555 0123, (415) 555-0123, 415-555-0123 or +44 20 7946 0958')).toBe(
      'call [phone], [phone], [phone] or [phone]',
    )
    expect(redact('card 4242 4242 4242 4242, amex 378282246310005, 5555-5555-5555-4444')).toBe('card [card], amex [card], [card]')
    expect(redact('key sk-proj-abcdefghijklmnopqrstuvwx and ghp_' + 'a'.repeat(36))).toBe('key [secret] and [secret]')
    expect(redact('xoxb-1234567890-abcdefghij, AKIAIOSFODNN7EXAMPLE')).toBe('[secret], [secret]')
    expect(redact('Authorization: Bearer abcdefghijklmnop.qrstuvwx')).toBe('Authorization: Bearer [secret]')
    expect(redact('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe('jwt [secret]')
  })

  it('leaves the numbers a board is full of alone', () => {
    const text = [
      'see #4137 and PR 144, v0.8.1, on 2026-10-09 at 00:16',
      'ts 1791505001.402589, 1791505001402, order 1234567890, run 18234567890123456',
      'ip 192.168.100.200, sha 8b9a90d, 4242 4242 4242 4241',
      'https://vercel.slack.com/archives/C0C6MNT9LLC/p1791505001402589',
    ].join('\n')
    expect(redact(text)).toBe(text)
  })

  it('takes only some kinds, your own patterns, and your own replacement', () => {
    expect(redact('ada@example.com +1 415 555 0123', { only: ['phone'] })).toBe('ada@example.com [phone]')
    expect(redact('customer CUS-12345 and CUS-999', { patterns: { customer: /CUS-\d+/ } })).toBe('customer [customer] and [customer]')
    expect(redact('ada@example.com', { replace: (kind) => `<${kind} removed>` })).toBe('<email removed>')
  })
})

describe('redactPII middleware', () => {
  it('strips posts and edits before they land, from any source', async () => {
    const board = testBoard({ middleware: [redactPII()] })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const posted = await julian('POST', '/messages', { channel: 'dev', text: 'export broke for ada@example.com', labels: { kind: 'bug' } })
    expect(posted.status).toBe(201)
    expect(posted.body.message).toMatchObject({ text: 'export broke for [email]', labels: { kind: 'bug' } })

    const { id } = posted.body.message
    await julian('POST', `/messages/${id}/edit`, { text: 'her number is +1 415 555 0123' })
    const read = await julian('GET', '/messages?channel=dev')
    expect(read.body.messages.map((m: { text: string }) => m.text)).toEqual(['her number is [phone]'])

    // The original never reaches the log.
    expect(JSON.stringify(read.body)).not.toContain('ada@example.com')
  })

  it('drops a message that was nothing but PII', async () => {
    const board = testBoard({ middleware: [redactPII({ replace: () => '' })] })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    expect((await julian('POST', '/messages', { channel: 'dev', text: 'ada@example.com' })).status).toBe(422)
  })
})
