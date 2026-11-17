import { describe, expect, it } from 'vitest'
import { createSlackAdapter } from '@chat-adapter/slack'
import { slack, withoutBroadcasts, withoutHtml, type SlackClient } from '../src/sync/slack.ts'
import { channels } from '../src/sync/fn.ts'

const thread = 'C1:1700000000.000100'

// Vercel's Agent review comments on GitHub, as they reach the board: markdown with GitHub's inline HTML.
const vercelSuggestion = [
  '**vercel[bot] (github)**: Source-mode setup aborts when the last file returned by `git ls-files` has been deleted.',
  '',
  '<a href="https://vercel.com/team/~/agent/tasks/eb78#suggestion-3f6d" rel="noreferrer"><picture><source media="(prefers-color-scheme: dark)" srcset="https://vercel.com/vercel-agent-view-suggestion-dark"><source media="(prefers-color-scheme: light)" srcset="https://vercel.com/vercel-agent-view-suggestion-light"><img src="https://vercel.com/vercel-agent-view-suggestion-light" alt="Fix on Vercel"></picture></a>',
].join('\n')

function slackWith() {
  const adapter = createSlackAdapter({ signingSecret: 'secret', botToken: 'xoxb-test' })
  const internals = adapter as unknown as { initialize(chat: unknown): Promise<void>; chat: unknown }
  internals.initialize = async function (chat) {
    internals.chat = chat
  }
  const sent: unknown[] = []
  adapter.postMessage = async (threadId, message) => {
    sent.push(message)
    return { id: '1700000000.000300', threadId, raw: {} }
  }
  adapter.editMessage = async (threadId, id, message) => {
    sent.push(message)
    return { id, threadId, raw: {} }
  }
  const posted: Record<string, unknown>[] = []
  const client: SlackClient = {
    conversations: { list: async () => ({}), info: async () => ({}), replies: async () => ({ messages: [] }) },
    chat: { postMessage: async (args) => (posted.push(args), { ts: '1700000000.000200' }) },
    auth: { test: async () => ({ response_metadata: { scopes: ['chat:write.customize'] } }) },
  }
  return { provider: slack({ adapter, client: async () => client }, channels({})), sent, posted }
}

describe('GitHub HTML in Slack', () => {
  it("reaches Slack as a link, not as raw tags", async () => {
    const { provider, sent } = slackWith()
    await provider.post(thread, 'thread', { markdown: vercelSuggestion })
    const { markdown } = sent[0] as { markdown: string }
    expect(markdown).not.toMatch(/<\/?(a|picture|source|img)\b/)
    expect(markdown).toContain('[Fix on Vercel](https://vercel.com/team/~/agent/tasks/eb78#suggestion-3f6d)')
    expect(markdown).toContain('`git ls-files`')
  })

  it('stays out of edits and of messages sent under an agent’s name', async () => {
    const { provider, sent, posted } = slackWith()
    await provider.edit(thread, '1700000000.000300', { markdown: vercelSuggestion })
    await provider.post(thread, 'thread', { markdown: vercelSuggestion, as: { name: 'pi', avatar: null } })
    expect((sent[0] as { markdown: string }).markdown).not.toContain('<picture>')
    expect(posted[0]!.markdown_text).not.toContain('<picture>')
  })
})

describe('withoutHtml', () => {
  it('turns the HTML GitHub comments use into markdown', () => {
    expect(withoutHtml('a<!-- hidden\nnote -->b')).toBe('ab')
    expect(withoutHtml('<img src="https://x/y.png" alt="chart">')).toBe('chart')
    expect(withoutHtml('one<br>two<br/>three')).toBe('one\ntwo\nthree')
    expect(withoutHtml('<details><summary>Logs</summary>\n\nall good\n</details>')).toBe('**Logs**\n\nall good')
    expect(withoutHtml('<b>bold</b> <sub>small</sub> <kbd>K</kbd>')).toBe('**bold** small `K`')
    expect(withoutHtml('<a href="https://x.dev">site</a>')).toBe('[site](https://x.dev)')
    expect(withoutHtml('<p align="center">hi</p>')).toBe('hi')
  })

  it("leaves code, Slack's own <@U123> and <https://…> syntax, and comparisons alone", () => {
    const text = 'use `<a href="x">` and\n\n```html\n<picture></picture>\n```\n\nping <@U123> at <https://x.dev|x> if a < b > c'
    expect(withoutHtml(text)).toBe(text)
    expect(withoutHtml('see ``a `<b>` c`` <b>x</b>')).toBe('see ``a `<b>` c`` **x**')
  })

  it('hides a whole HTML comment, code and all, but keeps a `<!--` in code', () => {
    expect(withoutHtml('hi <!-- secret `token` here --> there')).toBe('hi  there')
    expect(withoutHtml('hi <!-- ```\nsecret\n``` --> there')).toBe('hi  there')
    expect(withoutHtml('write `<!--` then <b>x</b>')).toBe('write `<!--` then **x**')
  })

  it('keeps the URL of a link whose label has code in it', () => {
    expect(withoutHtml('see <a href="https://x.dev">the `foo` docs</a>')).toBe('see [the `foo` docs](https://x.dev)')
  })

  it('tidies whitespace around code blocks, never inside them', () => {
    const block = '```\nkeep  \n\n\n\nthis\n```'
    expect(withoutHtml(`<b>x</b>\n\n\n\n${block}`)).toBe(`**x**\n\n${block}`)
  })
})

describe('Slack broadcasts from other platforms', () => {
  const comment = 'cc <!channel> <!here> <!everyone> <!subteam^S123|oncall> and <@U123>, <https://x.dev|x>, <!-- note -->'

  it('reach Slack as text, in posts, edits, and messages sent under an agent’s name', async () => {
    const { provider, sent, posted } = slackWith()
    await provider.post(thread, 'thread', { markdown: comment })
    await provider.edit(thread, '1700000000.000300', { markdown: comment })
    await provider.post(thread, 'thread', { markdown: comment, as: { name: 'pi', avatar: null } })
    for (const text of [(sent[0] as { markdown: string }).markdown, (sent[1] as { markdown: string }).markdown, String(posted[0]!.markdown_text)]) {
      expect(text).not.toMatch(/<!(channel|here|everyone|subteam)/)
      expect(text).toContain('<@U123>')
      expect(text).toContain('<https://x.dev|x>')
    }
  })

  it('keep their words', () => {
    expect(withoutBroadcasts('hey <!channel>').replace('\u2060', '')).toBe('hey <!channel>')
    expect(withoutBroadcasts('<!-- c --> a <! b')).toBe('<!-- c --> a <! b')
  })
})
