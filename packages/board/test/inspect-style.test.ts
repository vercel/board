import { describe, expect, it } from 'vitest'
import { CSS } from '../src/inspect/style.ts'

/**
 * A small cascade over the inspector's stylesheet: enough to say what
 * font-size each text field ends up with on a phone and on a desktop. iOS
 * zooms the page in when a focused field's text is under 16px (#636).
 */

interface Rule {
  selector: string
  media: string | null
  order: number
  fontSize: string | null
  important: boolean
}

/** Every rule in `css`, with the media query it sits in. */
function rules(css: string): Rule[] {
  const out: Rule[] = []
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let i = 0
  const read = (media: string | null) => {
    while (i < text.length) {
      const open = text.indexOf('{', i)
      const close = text.indexOf('}', i)
      if (close !== -1 && (open === -1 || close < open)) {
        i = close + 1
        return
      }
      if (open === -1) return
      const head = text.slice(i, open).trim()
      i = open + 1
      if (head.startsWith('@media')) {
        read(head.slice('@media'.length).trim())
        continue
      }
      const end = text.indexOf('}', i)
      const body = text.slice(i, end)
      i = end + 1
      // `font: inherit` resets the size along with the rest of the font.
      let fontSize: string | null = null
      let important = false
      for (const decl of body.split(';')) {
        const [name, ...rest] = decl.split(':')
        const raw = rest.join(':').trim()
        const value = raw.replace(/\s*!important$/, '')
        if (name?.trim() === 'font-size' || name?.trim() === 'font') {
          fontSize = value
          important = value !== raw
        }
      }
      for (const selector of head.split(','))
        out.push({ selector: selector.trim().replace(/\s+/g, ' '), media, order: out.length, fontSize, important })
    }
  }
  read(null)
  return out
}

/** A compound selector's parts: its tag and its classes, or null for anything fancier. */
function compound(part: string): { tag: string | null; classes: string[] } | null {
  if (/[:[#>+~*]/.test(part)) return null
  const tag = part.match(/^[a-z]+/)?.[0] ?? null
  return { tag, classes: [...part.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!) }
}

const covers = (rule: ReturnType<typeof compound>, field: ReturnType<typeof compound>) =>
  !!rule && !!field && (!rule.tag || rule.tag === field.tag) && rule.classes.every((c) => field.classes.includes(c))

/** Whether `selector` matches the element `field` describes (plain descendant chains only). */
function matches(selector: string, field: string): boolean {
  const want = selector.split(' ').map(compound)
  const have = field.split(' ').map(compound)
  if (!covers(want.at(-1)!, have.at(-1)!)) return false
  let j = have.length - 2
  for (let k = want.length - 2; k >= 0; k--) {
    while (j >= 0 && !covers(want[k]!, have[j]!)) j--
    if (j < 0) return false
    j--
  }
  return true
}

const specificity = (selector: string) => {
  const parts = selector.split(' ').map(compound)
  const classes = parts.reduce((n, p) => n + (p?.classes.length ?? 0), 0)
  const tags = parts.reduce((n, p) => n + (p?.tag ? 1 : 0), 0)
  return classes * 100 + tags
}

/** The font-size `field` gets where `active` says which media queries hold. */
function fontSize(field: string, active: (media: string) => boolean): string {
  const all = rules(CSS).filter((r) => r.fontSize && (r.media === null || active(r.media)) && matches(r.selector, field))
  all.sort((a, b) => Number(a.important) - Number(b.important) || specificity(a.selector) - specificity(b.selector) || a.order - b.order)
  const size = all.at(-1)?.fontSize ?? 'inherit'
  return size === 'inherit' ? '13px' : size // the body's size
}

/** Every text field the stylesheet styles: an input or textarea at the end of a plain selector. */
const fields = [
  ...new Set(
    rules(CSS)
      .map((r) => r.selector)
      .filter((s) => /(^|[ .])(input|textarea|select)(\.[\w-]+)*$/.test(s) && s.split(' ').every((p) => compound(p))),
  ),
]

/** A font-size in px: px as is, rem against the browser's 16px. */
const px = (size: string) => (size.endsWith('rem') ? parseFloat(size) * 16 : parseFloat(size))

const phone = (media: string) => !media.includes('prefers-color-scheme')
const desktop = (media: string) => !media.includes('pointer: coarse') && !media.includes('max-width')

describe('the inspector on a touch device', () => {
  it('finds the fields the stylesheet sizes', () => {
    expect(fields).toEqual(
      expect.arrayContaining(['.composer-box textarea', '.editor textarea', '.ask textarea', '.ask textarea.code', '.new-channel input', '.whoami.naming input', '.suggest input']),
    )
  })

  it.each(fields)('gives %s text of at least 16px, so iOS does not zoom when it takes focus', (field) => {
    expect(px(fontSize(field, phone))).toBeGreaterThanOrEqual(16)
  })

  it('keeps the desktop sizes', () => {
    expect(fontSize('.composer-box textarea', desktop)).toBe('14px')
    expect(fontSize('.ask textarea', desktop)).toBe('13px')
    expect(fontSize('.ask textarea.code', desktop)).toBe('12px')
    expect(fontSize('.new-channel input', desktop)).toBe('12px')
    expect(fontSize('.suggest input', desktop)).toBe('13px')
  })
})
