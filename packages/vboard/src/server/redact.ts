import type { Middleware } from './middleware.ts'

/** The kinds of personal data and secrets `redact` finds on its own. */
export type PIIKind = 'email' | 'phone' | 'card' | 'secret'

export type RedactOptions = {
  /** Which built-in kinds to strip. Defaults to all of them. */
  only?: readonly PIIKind[]
  /** Your own patterns, by name: each match becomes `[name]`. Global or not, every match is replaced. */
  patterns?: Record<string, RegExp>
  /** What a match becomes. Defaults to `[kind]`, like `[email]`. */
  replace?: (kind: string, match: string) => string
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g

// API keys and tokens with a known shape, plus `Bearer …` and JWTs.
const SECRET = new RegExp(
  [
    String.raw`\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}`, // OpenAI, Anthropic
    String.raw`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}`, // GitHub
    String.raw`\bgithub_pat_[A-Za-z0-9_]{22,}`,
    String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,}`, // Slack
    String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`, // AWS access key IDs
    String.raw`\bAIza[A-Za-z0-9_-]{35}`, // Google
    String.raw`\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}`, // Stripe
    String.raw`\bvc[pkia]_[A-Za-z0-9]{24,}`, // Vercel
    String.raw`\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`, // JWT
    String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`,
  ].join('|'),
  'g',
)
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g

// 13 to 19 digits, in groups split by single spaces or dashes, that pass the Luhn
// check. Written without separators, only 15 or 16 digits (Amex, Visa, Mastercard)
// count, so a millisecond timestamp or a 13-digit ID stays.
const CARD = /(?<![\d#])\d(?:[ -]?\d){12,18}(?!\d)/g

// An international number (+ and 8 to 15 digits), or a 10-digit one written with
// separators, like (415) 555-0123 or 415-555-0123. Bare digit runs aren't phones:
// they're IDs, timestamps and order numbers far more often.
const PHONE =
  /(?<![\w#+])(?:\+\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d{1,4}(?:[ .-]?\d{2,4}){1,4}|\(\d{3}\)[ .-]?\d{3}[ .-]?\d{4}|\d{3}[.-]\d{3}[.-]\d{4})(?![\w])/g

function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

const global = (re: RegExp) => (re.global ? re : new RegExp(re.source, re.flags + 'g'))

/**
 * Replaces emails, phone numbers, card numbers, and API keys or tokens in `text`
 * with `[email]`, `[phone]`, `[card]`, and `[secret]`, plus matches of your own patterns.
 */
export function redact(text: string, options: RedactOptions = {}): string {
  const only = new Set<PIIKind>(options.only ?? ['email', 'phone', 'card', 'secret'])
  const replace = options.replace ?? ((kind: string) => `[${kind}]`)
  let out = text
  // Secrets first: a token can contain what looks like an email or a phone number.
  if (only.has('secret')) {
    out = out.replace(SECRET, (m) => replace('secret', m))
    out = out.replace(BEARER, (m, prefix: string) => prefix + replace('secret', m.slice(prefix.length)))
  }
  for (const [name, re] of Object.entries(options.patterns ?? {})) out = out.replace(global(re), (m) => replace(name, m))
  if (only.has('email')) out = out.replace(EMAIL, (m) => replace('email', m))
  if (only.has('card')) out = out.replace(CARD, (m) => {
      const digits = m.replace(/\D/g, '')
      if (digits === m && digits.length !== 15 && digits.length !== 16) return m
      return luhn(digits) ? replace('card', m) : m
    })
  if (only.has('phone')) {
    out = out.replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, '').length
      return digits >= 8 && digits <= 15 ? replace('phone', m) : m
    })
  }
  return out
}

/**
 * Middleware that strips personal data and secrets from every post and edit
 * before it lands, with `redact`. A write it changes keeps everything else.
 */
export function redactPII(options: RedactOptions = {}): Middleware {
  return async ({ write, next }) => {
    const text = redact(write.text, options)
    await (text === write.text ? next() : next({ text }))
  }
}
