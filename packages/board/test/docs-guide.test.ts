import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The build-a-ui guide teaches from the inspector's own code. Its samples named `inspector/…` are
// that code, and this keeps them so: the page marks what a guide may quote with
// `// #region guide <name>`, and each sample ends with its region, to the letter.

const guide = readFileSync(new URL('../docs/03-guides/07-build-a-ui.md', import.meta.url), 'utf8')
const app = new URL('../src/inspect/app/', import.meta.url)

const regions = new Map<string, string>()
for (const file of readdirSync(app))
  for (const found of readFileSync(new URL(file, app), 'utf8').matchAll(/\/\/ #region guide (\S+)\n([\s\S]*?)\n\/\/ #endregion/g)) regions.set(found[1]!, found[2]!)

const samples = new Map([...guide.matchAll(/```ts (inspector\/\S+)\n([\s\S]*?)\n```/g)].map((found) => [found[1]!, found[2]!]))

/** What a sample may add before the inspector's code, so it pastes whole: imports from the package, the handle, and a constant. */
const PREAMBLE = /^(import (type )?\{[^}]+\} from '@vercel\/board(\/[a-z-]+)?'|const team = board\(\)|const [A-Z_]+ = \d+)$/

describe('the build-a-ui guide', () => {
  it("quotes the inspector's code as it ships, every sample and every region", () => {
    expect([...samples.keys()].sort()).toEqual([...regions.keys()].sort())
    expect(samples.size).toBeGreaterThan(0)
    for (const [name, sample] of samples) {
      const code = regions.get(name)!
      expect(sample, name).toContain(code)
      expect(sample.endsWith(code), `${name} ends with the inspector's code`).toBe(true)
      const before = sample.slice(0, -code.length).split('\n').filter((line) => line.trim() !== '')
      expect(before.filter((line) => !PREAMBLE.test(line)), `${name} adds only imports, the handle, and constants`).toEqual([])
    }
  })
})
