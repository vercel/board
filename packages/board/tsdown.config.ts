import { fileURLToPath } from 'node:url'
import { build, defineConfig, type InlineConfig, type Rolldown } from 'tsdown'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// `inspect`'s page: one prebuilt file, React included, so installing the
// package installs no UI dependencies.
const page = {
  config: false,
  cwd: here('.'),
  entry: { app: 'src/inspect/app/main.tsx' },
  outDir: 'dist/inspect',
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  dts: false,
  clean: true,
  hash: false,
  fixedExtension: false,
  outExtensions: () => ({ js: '.js' }),
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warn',
} satisfies InlineConfig

export default defineConfig([
  {
    entry: {
      // `@vercel/board` has a `node` build, which finds boards and credentials in the environment and
      // serves them, and a default one with nothing that needs Node, for browsers.
      index: 'src/server/index.default.ts',
      'index.node': 'src/server/index.ts',
      access: 'src/access/index.ts',
      // `@vercel/board/schemas`: how a board checks a schema, a value, and a message's blocks, with no imports.
      schemas: 'src/schemas/index.ts',
      conformance: 'src/conformance/index.ts',
      // `@vercel/board/backend-local`: a board kept in this process, Node only.
      'backend-local': 'src/backend-local/index.ts',
      sync: 'src/sync/index.ts',
      'sync-chat-sdk': 'src/sync/chat-sdk.ts',
      'sync-slack': 'src/sync/slack.ts',
      'sync-github': 'src/sync/github.ts',
      'sync-linear': 'src/sync/linear.ts',
      'sync-vercel': 'src/sync/vercel.ts',
      cli: 'src/cli/bin.ts',
      // `@vercel/board/cli`: the CLI for another one to embed, as `vercel board`, without `inspect`
      // or `serve`.
      'cli-embedded': 'src/cli/embedded.ts',
      // `@vercel/board/cli/commands`: the CLI's commands as data, for a host to render, with no imports.
      'cli-commands': 'src/cli/commands.ts',
      // `@vercel/board/inspect`: the inspector as a route handler in your app, with its page beside it.
      inspect: 'src/inspect/handler.ts',
    },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    // A module one entry shares with a lazily loaded chunk stays in a chunk of its own: merged
    // into the entry, it would load that entry (the CLI, say) wherever the chunk loads.
    inputOptions: { experimental: { chunkOptimization: false } },
    dts: true,
    // The local board's engine is inlined: what board runs of experimental-a2 ships in dist, its types
    // too, so installing board installs no experimental-a2, and nothing else from node_modules is.
    deps: {
      alwaysBundle: [/^experimental-a2(\/|$)/],
      onlyBundle: [/^experimental-a2(\/|$)/],
      dts: { alwaysBundle: [/^experimental-a2(\/|$)/] },
    },
    plugins: [inspectorPage()],
    clean: true,
  },
])

/**
 * `inspect`'s page is built with the rest, into `dist/inspect/app.js`, which the standalone CLI
 * reads where board is installed, and running from source too.
 */
function inspectorPage(): Rolldown.Plugin {
  return {
    name: 'board:inspector-page',
    async buildStart() {
      await build(page)
    },
  }
}
