import { readdirSync, readFileSync } from 'node:fs'
import { posix, sep } from 'node:path'
import GithubSlugger from 'github-slugger'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// The docs ship in the package, and the docs site serves them. Pages link to each other by
// relative file path (`../02-sync/03-slack.md#files`), so they read the same on GitHub and in
// node_modules, and the site turns those into URLs: a link to no page, or to no heading on one, is
// a broken link there. This checks the docs in this checkout, whatever release the site runs.

const DOCS = new URL('../docs/', import.meta.url)
const FILES = readdirSync(DOCS, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.split(sep).join('/'))
  .sort()

type Node = { type: string; value?: unknown; url?: string; children?: Node[] }
const textOf = (node: Node): string => (typeof node.value === 'string' ? node.value : (node.children ?? []).map(textOf).join(''))

/** A page's frontmatter, its heading anchors as the site and GitHub make them, and the links it holds. */
function read(file: string) {
  const source = readFileSync(new URL(file, DOCS), 'utf8')
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
  const data = (match ? parse(match[1]!) : null) as Record<string, unknown> | null
  const tree = unified().use(remarkParse).use(remarkGfm).parse(match?.[2] ?? source) as Node
  const slugger = new GithubSlugger()
  const anchors = new Set<string>()
  const links: string[] = []
  visit(tree, (node: Node) => {
    if (node.type === 'heading') anchors.add(slugger.slug(textOf(node)))
    if ((node.type === 'link' || node.type === 'definition') && node.url) links.push(node.url)
  })
  return { data, anchors, links }
}

const PAGES = new Map(FILES.map((file) => [file, read(file)]))

/** A link to another page or a heading, not to a site or a path on one. */
const isRelative = (url: string) => !/^([a-z][a-z0-9+.-]*:|\/)/i.test(url)

describe('the docs', () => {
  it('are pages in the package', () => {
    expect(FILES).toContain('index.md')
    expect(FILES.length).toBeGreaterThan(10)
  })

  it.each(FILES)('%s has a title and a description in its frontmatter', (file) => {
    const { data } = PAGES.get(file)!
    expect(typeof data?.title === 'string' && data.title.length > 0, 'title').toBe(true)
    expect(typeof data?.description === 'string' && data.description.length > 0, 'description').toBe(true)
  })

  it('link only to pages, and to headings on them that exist', () => {
    const broken: string[] = []
    for (const [file, { links }] of PAGES) {
      for (const url of links.filter(isRelative)) {
        const [path = '', anchor] = url.split('#')
        const target = path === '' ? file : posix.normalize(posix.join(posix.dirname(file), path))
        const page = PAGES.get(target)
        if (!page) broken.push(`${file}: ${url} isn't a page`)
        else if (anchor && !page.anchors.has(anchor)) broken.push(`${file}: ${url} has no such heading`)
      }
    }
    expect(broken).toEqual([])
  })
})
