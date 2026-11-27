import { chmodSync, writeFileSync } from 'node:fs'
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
  {
    // The `vb` CLI: alwaysBundle inlines zod, jose, and the rest, so starting a command resolves a
    // handful of files instead of ~390 modules. Code splitting stays on: what a command only reaches
    // through `import()` becomes a chunk of its own, unparsed until that command needs it, so the
    // entry V8 reads at every start is far smaller. Minifying shrinks the bytes that remain.
    entry: { 'cli-main': 'src/cli/bin.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    minify: true,
    dts: false,
    // @vercel/oidc is reached only through a dynamic import on a Vercel credential path: leave it in
    // node_modules (it is a declared dependency), so its whole subtree is not in the startup graph.
    deps: { alwaysBundle: [/.*/], onlyBundle: false, neverBundle: [/^@vercel\/oidc(\/|$)/] },
    plugins: [cliShim()],
    // It adds dist/cli.mjs to the build above rather than replacing it.
    clean: false,
  },
])

/**
 * `dist/cli.mjs` — what the `board` and `vb` bins point at — is a small shim that asks Node for its
 * compile cache and only then loads `cli-main.mjs`, the CLI's eager bundle (and any chunk that
 * command imports). Node compiles those once and keeps V8's bytecode in the cache, so every `vb`
 * after the first skips parsing and compiling them. It has to be a separate file: the cache covers
 * only modules loaded after `enableCompileCache()`, which a file can't do for itself.
 */
function cliShim(): Rolldown.Plugin {
  const shim = `#!/usr/bin/env node
import { enableCompileCache } from 'node:module'
try { enableCompileCache() } catch {}
await import('./cli-main.mjs')
`
  return {
    name: 'board:cli-shim',
    writeBundle() {
      writeFileSync(here('dist/cli.mjs'), shim)
      chmodSync(here('dist/cli.mjs'), 0o755)
    },
  }
}

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
