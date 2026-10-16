const FENCED_CODE = /```[\s\S]*?```/g
const INLINE_CODE = /`[^`\n]*`/g
const NAME = '[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?'
// `@ada` and `@julian/claude`; never part of an email or a longer token.
const MENTION = new RegExp(
  `(?<![\\w@.-])@(${NAME}(?:/${NAME})?)(?!:|[a-z0-9_/-]|\\.(?=[a-z0-9]))`,
  'gi',
)
// `@[slack:T0123:U0456]` names an exact actor.
const EXACT = /(?<![\w@.-])@\[([^\]\s]+)\]/g

/** Blanks out code so mentions inside it never count. */
const proseOnly = (text: string): string =>
  text
    .replace(FENCED_CODE, (match) => ' '.repeat(match.length))
    .replace(INLINE_CODE, (match) => ' '.repeat(match.length))

export type MentionToken =
  | { kind: 'handle'; handle: string }
  | { kind: 'actor'; actor: string }

/** Mentions in prose order, deduplicated. Handles are lowercased. */
export function extractMentions(text: string): MentionToken[] {
  const prose = proseOnly(text)
  const found: { index: number; token: MentionToken; key: string }[] = []
  for (const match of prose.matchAll(EXACT)) {
    const actor = match[1]
    if (actor !== undefined)
      found.push({
        index: match.index,
        token: { kind: 'actor', actor },
        key: `actor:${actor}`,
      })
  }
  for (const match of prose.replace(EXACT, (m) => ' '.repeat(m.length)).matchAll(MENTION)) {
    const handle = match[1]?.toLowerCase()
    if (handle !== undefined)
      found.push({
        index: match.index,
        token: { kind: 'handle', handle },
        key: `handle:${handle}`,
      })
  }
  const seen = new Set<string>()
  return found
    .sort((a, b) => a.index - b.index)
    .filter(({ key }) => !seen.has(key) && seen.add(key))
    .map(({ token }) => token)
}

/**
 * Rewrites each mention in prose with `replace`, which also gets the mention as
 * written; one it returns null for stays as written.
 * Code is left alone, as in `extractMentions`.
 */
export function replaceMentions(text: string, replace: (token: MentionToken, written: string) => string | null): string {
  const prose = proseOnly(text)
  const found: { index: number; length: number; token: MentionToken }[] = []
  for (const match of prose.matchAll(EXACT))
    found.push({ index: match.index, length: match[0].length, token: { kind: 'actor', actor: match[1]! } })
  for (const match of prose.replace(EXACT, (m) => ' '.repeat(m.length)).matchAll(MENTION))
    found.push({ index: match.index, length: match[0].length, token: { kind: 'handle', handle: match[1]!.toLowerCase() } })
  let out = ''
  let at = 0
  for (const { index, length, token } of found.sort((a, b) => a.index - b.index)) {
    const written = text.slice(index, index + length)
    out += text.slice(at, index) + (replace(token, written) ?? written)
    at = index + length
  }
  return out + text.slice(at)
}
