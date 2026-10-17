import { execFileSync, spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CLI, env, tmp, url, useBoard, vb, vb_in } from './cli-harness.ts'

useBoard()

describe('cli hooks', () => {
  it('installs turn-end hooks, and the permissions their reminder needs, keeping what else is there', async () => {
    const home = await tmp('vboard-home-')
    const at = { HOME: home, CODEX_HOME: join(home, '.codex') }
    await mkdir(join(home, '.claude'), { recursive: true })
    const settings = join(home, '.claude', 'settings.json')
    const theirs = {
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], PreToolUse: [] },
    }
    await writeFile(settings, JSON.stringify(theirs))

    const installed = await vb(['hooks', 'install', 'claude', 'codex'], at)
    expect(installed).toMatchObject({ code: 0, stderr: '' })
    expect(installed.stdout).toContain('Codex  ~/.codex/hooks.json\n  added the turn-end hook\n')
    // One short block per agent: home as ~, and what's allowed said in words, not as the rules' raw commands.
    expect(installed.stdout).toContain('Claude Code  ~/.claude/settings.json\n  added the turn-end hook\n  reply, post, read, and channels run without asking\n\n')
    expect(installed.stdout).not.toContain('Bash(')
    expect(installed.stdout).not.toContain(home)
    expect(installed.stdout).toContain('They stay quiet outside projects linked with `vb link <url>`.\n')
    // Prose fits 80 columns; only the pasted config (indented four) and its domains can run over.
    expect(installed.stdout.split('\n').filter((line) => line.length > 80 && !line.startsWith('    '))).toEqual([])
    // Codex has no command allowlist; its sandbox needs network, so it's told how to allow just the board.
    expect(installed.stdout).toContain("to let vb reach the board from Codex's sandbox, add to ~/.codex/config.toml:\n\n    # a permission profile (beta) that opens the network to just the board\n\n    # at the top, before any [table]\n    default_permissions = \"vboard\"\n")
    expect(installed.stdout).toContain(`"${new URL(url).hostname}" = "allow"`)
    expect((await vb(['hooks', 'install', 'claude'], at)).stdout).toContain('Claude Code  ~/.claude/settings.json\n  already installed\n')
    const claude = JSON.parse(await readFile(settings, 'utf8'))
    expect(claude.model).toBe('opus')
    expect(claude.hooks.PreToolUse).toEqual([])
    expect(claude.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'say done' }] },
      { hooks: [{ type: 'command', command: expect.stringMatching(/ hook stop --agent claude 2>\/dev\/null \|\| true$/), timeout: 10 }] },
    ])
    const cli = (claude.hooks.Stop[1].hooks[0].command as string).replace(/ hook stop .*$/, '')
    expect(claude.permissions).toEqual({
      allow: ['Bash(ls:*)', `Bash(${cli} reply:*)`, `Bash(${cli} post:*)`, `Bash(${cli} read:*)`, `Bash(${cli} channels:*)`],
      deny: ['Bash(rm:*)'],
    })
    const codex = JSON.parse(await readFile(join(home, '.codex', 'hooks.json'), 'utf8'))
    expect(codex.hooks.Stop[0].hooks[0].command).toMatch(/ hook stop --agent codex 2>\/dev\/null \|\| true$/)
    expect((await vb(['hooks', 'status'], at)).stdout).toBe('Claude Code  installed  ~/.claude/settings.json\nCodex        installed  ~/.codex/hooks.json\nCursor       not installed\nPi           not installed\n')

    // Whatever the saved command runs into (say, an older vb without `hook`, which exits 2), it can't fail a turn.
    const stale = join(home, 'bin')
    await mkdir(stale)
    await writeFile(join(stale, 'vb'), '#!/bin/sh\necho "error: unknown command: hook" >&2\nexit 2\n', { mode: 0o755 })
    const ran = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn('/bin/sh', ['-c', 'vb hook stop --agent claude 2>/dev/null || true'], { env: { ...env, PATH: `${stale}:${process.env.PATH}` } })
      let stderr = ''
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (code) => resolve({ code, stderr }))
      child.stdin.end('{}')
    })
    expect(ran).toEqual({ code: 0, stderr: '' })

    // A rule an earlier install added for the since-removed `vb update` goes on reinstall, and on uninstall.
    const legacy = `Bash(${cli} update:*)`
    await writeFile(settings, JSON.stringify({ ...claude, permissions: { ...claude.permissions, allow: [...claude.permissions.allow, legacy] } }))
    await vb(['hooks', 'install', 'claude'], at)
    expect(JSON.parse(await readFile(settings, 'utf8')).permissions.allow).not.toContain(legacy)
    await writeFile(settings, JSON.stringify({ ...claude, permissions: { ...claude.permissions, allow: [...claude.permissions.allow, legacy] } }))
    expect((await vb(['hooks', 'uninstall', 'claude'], at)).stdout).toBe('Claude Code  removed  ~/.claude/settings.json\n')
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual(theirs)
    expect((await vb(['hooks', 'install', 'gemini'], at))).toMatchObject({ code: 2, stderr: 'error: unknown agent: gemini (known: claude, codex, cursor, pi)\n' })
  })

  // pnpm installs global bins as shell scripts that exec node on the package, through its node_modules symlink:
  // pnpm 10 quotes "$basedir/…", pnpm 11 quotes "$basedir_abs/…" (and "$basedir_win/…" for Windows shells).
  const shims = {
    'pnpm 10': (rel: string) => [
      '#!/bin/sh',
      'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
      'if [ -x "$basedir/node" ]; then',
      `  exec "$basedir/node"  "$basedir/${rel}" "$@"`,
      'else',
      `  exec node  "$basedir/${rel}" "$@"`,
      'fi',
    ],
    'pnpm 11': (rel: string) => [
      '#!/bin/sh',
      'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
      'basedir_abs=$(cd "$basedir" && pwd)',
      'basedir_win=$basedir_abs',
      'case `uname` in',
      `    *CYGWIN*|*MINGW*|*MSYS*) exec node.exe  "$basedir_win/${rel}" "$@";;`,
      'esac',
      'if [ -x "$basedir/node" ]; then',
      `  exec "$basedir/node"  "$basedir_abs/${rel}" "$@"`,
      'else',
      `  exec node  "$basedir_abs/${rel}" "$@"`,
      'fi',
    ],
  }
  for (const [pnpm, shim] of Object.entries(shims)) {
    it(`reminds with plain vb when the vb on PATH is a ${pnpm} shim for this CLI`, async () => {
      const home = await tmp('vboard-home-')
      const bin = join(home, 'pnpm', 'bin')
      await mkdir(join(home, 'pnpm', 'global', 'node_modules'), { recursive: true })
      await mkdir(bin)
      await symlink(dirname(dirname(CLI)), join(home, 'pnpm', 'global', 'node_modules', 'vboard'))
      await writeFile(join(bin, 'vb'), `${shim('../global/node_modules/vboard/cli/main.ts').join('\n')}\n`, { mode: 0o755 })
      const at = { HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}` }

      expect(await vb(['hooks', 'install', 'claude'], at)).toMatchObject({ code: 0, stderr: '' })
      const claude = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'))
      expect(claude.hooks.Stop[0].hooks[0].command).toBe('vb hook stop --agent claude 2>/dev/null || true')

      const repo = await tmp('vboard-repo-')
      execFileSync('git', ['init', '-q', '-b', 'feat/shim'], { cwd: repo })
      const { stdout } = await vb(['hook', 'stop', '--agent', 'claude'], at, JSON.stringify({ session_id: `shim-${Date.now()}`, cwd: repo }))
      const reason = (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
      expect(reason).toContain(': vb reply <id> "<text>" in a board thread')
      expect(reason).not.toContain(process.execPath)
    })
  }

  it('tells an outdated install from a current one, and how to fix it', async () => {
    const home = await tmp('vboard-home-')
    const at = { HOME: home, CODEX_HOME: join(home, '.codex'), PI_CODING_AGENT_DIR: join(home, 'pi-agent') }
    const { version } = JSON.parse(await readFile(join(dirname(CLI), '../../package.json'), 'utf8')) as { version: string }
    // Pi's is current to begin with; then its extension changes under it.
    expect(await vb(['hooks', 'install', 'pi'], at)).toMatchObject({ code: 0, stderr: '' })
    expect((await vb(['hooks', 'status', 'pi'], at)).stdout).toBe('Pi  installed  ~/pi-agent/extensions/vboard.ts\n')
    const extension = join(home, 'pi-agent', 'extensions', 'vboard.ts')
    await writeFile(extension, (await readFile(extension, 'utf8')).replace('let reminded = false', 'let reminded = 0'))
    // What vboard 0.8.0 wrote for Claude Code: a `vb` that's still 0.8.0, `vb update` allowed, no post or channels.
    const old = join(home, 'old-bin')
    await mkdir(old)
    await writeFile(join(old, 'vb'), '#!/bin/sh\necho 0.8.0\n', { mode: 0o755 })
    await mkdir(join(home, '.claude'))
    const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'vb hook stop --agent claude 2>/dev/null || true', timeout: 10 }] }] } }
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ ...settings, permissions: { allow: ['Bash(vb update:*)', 'Bash(vb reply:*)', 'Bash(vb read:*)'] } }))
    // Codex's hook pins this version through npx, with a flag installs no longer write.
    await mkdir(join(home, '.codex'))
    await writeFile(join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `npx -y vboard@${version} hook stop --agent codex --channel dev 2>/dev/null || true` }] }] } }))

    const status = await vb(['hooks', 'status'], { ...at, PATH: `${old}${delimiter}${process.env.PATH}` })
    expect(status).toMatchObject({ code: 0, stderr: '' })
    expect(status.stdout).toBe(
      [
        'Claude Code  outdated   ~/.claude/settings.json',
        '  allows update, which is gone',
        "  doesn't allow post or channels",
        `  runs vboard 0.8.0, not ${version}`,
        '  fix with npm i -g vboard, then vb hooks install claude',
        'Codex        outdated   ~/.codex/hooks.json',
        '  runs an older hook command',
        '  fix with vb hooks install codex',
        'Cursor       not installed',
        'Pi           outdated   ~/pi-agent/extensions/vboard.ts',
        '  the extension is from another version',
        '  fix with vb hooks install pi',
        '',
      ].join('\n'),
    )
    // With vb current, only what's in the file is left to fix.
    const current = join(home, 'new-bin')
    await mkdir(current)
    await writeFile(join(current, 'vb'), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 })
    expect((await vb(['hooks', 'status', 'claude'], { ...at, PATH: `${current}${delimiter}${process.env.PATH}` })).stdout).toBe(
      "Claude Code  outdated   ~/.claude/settings.json\n  allows update, which is gone\n  doesn't allow post or channels\n  fix with vb hooks install claude\n",
    )
    // Installing again brings each up to date.
    expect(await vb(['hooks', 'install', 'claude', 'codex', 'pi'], at)).toMatchObject({ code: 0, stderr: '' })
    expect((await vb(['hooks', 'status'], at)).stdout).toBe(
      'Claude Code  installed  ~/.claude/settings.json\nCodex        installed  ~/.codex/hooks.json\nCursor       not installed\nPi           installed  ~/pi-agent/extensions/vboard.ts\n',
    )
  }, 30_000)

  it('installs the Claude Code hook in CLAUDE_CONFIG_DIR when it is set', async () => {
    const home = await tmp('vboard-home-')
    const config = await tmp('vboard-claude-')
    const at = { HOME: home, CLAUDE_CONFIG_DIR: config }
    expect(await vb(['hooks', 'install', 'claude'], at)).toMatchObject({ code: 0, stderr: '' })
    const settings = JSON.parse(await readFile(join(config, 'settings.json'), 'utf8'))
    expect(settings.hooks.Stop[0].hooks[0].command).toMatch(/ hook stop --agent claude /)
    expect(settings.permissions.allow).toHaveLength(4)
    expect(readdirSync(home)).toEqual([])
    expect((await vb(['hooks', 'status', 'claude'], at)).stdout).toBe(`Claude Code  installed  ${join(config, 'settings.json')}\n`)
    expect((await vb(['hooks', 'status', 'claude'], { HOME: home })).stdout).toBe('Claude Code  not installed\n')
    expect((await vb(['hooks', 'uninstall', 'claude'], at)).stdout).toContain('removed')
    expect(JSON.parse(await readFile(join(config, 'settings.json'), 'utf8'))).toEqual({ hooks: {}, permissions: { allow: [] } })
    expect(readdirSync(home)).toEqual([])
  }, 20_000)

  it('says it updated an earlier install that it changed, and already installed only when nothing changed', async () => {
    // The command this checkout's hook runs, from a scratch install.
    const scratch = await tmp('vboard-claude-')
    await vb(['hooks', 'install', 'claude'], { HOME: await tmp('vboard-home-'), CLAUDE_CONFIG_DIR: scratch })
    const command = JSON.parse(await readFile(join(scratch, 'settings.json'), 'utf8')).hooks.Stop[0].hooks[0].command as string
    const cli = command.replace(/ hook stop .*$/, '')

    // What 0.8 wrote: the same hook, `vb update` allowed, and no `vb post` or `vb channels`.
    const home = await tmp('vboard-home-')
    const config = await tmp('vboard-claude-')
    const at = { HOME: home, CLAUDE_CONFIG_DIR: config, CODEX_HOME: join(home, '.codex'), PI_CODING_AGENT_DIR: join(home, 'pi') }
    const settings = join(config, 'settings.json')
    const hook = { Stop: [{ hooks: [{ type: 'command', command, timeout: 10 }] }] }
    await writeFile(settings, JSON.stringify({ hooks: hook, permissions: { allow: [`Bash(${cli} update:*)`, `Bash(${cli} reply:*)`, `Bash(${cli} read:*)`] } }))
    const updated = await vb(['hooks', 'install', 'claude'], at)
    expect(updated).toMatchObject({ code: 0, stderr: '' })
    expect(updated.stdout).toContain(`Claude Code  ${settings}\n  updated\n  reply, post, read, and channels run without asking\n\n`)
    expect(JSON.parse(await readFile(settings, 'utf8')).permissions.allow).toEqual(['reply', 'read', 'post', 'channels'].map((sub) => `Bash(${cli} ${sub}:*)`))

    // Only a legacy rule to drop is a change too.
    const parsed = JSON.parse(await readFile(settings, 'utf8'))
    await writeFile(settings, JSON.stringify({ ...parsed, permissions: { allow: [...parsed.permissions.allow, `Bash(${cli} update:*)`] } }))
    expect((await vb(['hooks', 'install', 'claude'], at)).stdout).toContain(`Claude Code  ${settings}\n  updated\n\n`)

    // Nothing to change: the file stays byte for byte.
    const settled = await readFile(settings, 'utf8')
    expect((await vb(['hooks', 'install', 'claude'], at)).stdout).toContain(`Claude Code  ${settings}\n  already installed\n\n`)
    expect(await readFile(settings, 'utf8')).toBe(settled)

    // An older hook command is replaced, and says so.
    await writeFile(settings, JSON.stringify({ ...JSON.parse(settled), hooks: { Stop: [{ hooks: [{ type: 'command', command: 'vb hook stop --agent claude 2>/dev/null || true', timeout: 10 }] }] } }))
    expect((await vb(['hooks', 'install', 'claude'], at)).stdout).toContain(`Claude Code  ${settings}\n  updated\n\n`)

    // So is Pi's extension, rewritten when an earlier vboard wrote it.
    const extension = join(home, 'pi', 'extensions', 'vboard.ts')
    await mkdir(dirname(extension), { recursive: true })
    await writeFile(extension, '// Added by `vb hooks install pi`: an older version.\nconst COMMAND = "vb hook stop --agent pi"\n')
    expect((await vb(['hooks', 'install', 'pi'], at)).stdout).toContain('Pi  ~/pi/extensions/vboard.ts\n  updated\n')
    expect((await vb(['hooks', 'install', 'pi'], at)).stdout).toContain('Pi  ~/pi/extensions/vboard.ts\n  already installed\n')
  }, 20_000)

  it("reminds an agent once when its turn didn't update the board, and the agent posts where it fits", async () => {
    const repo = await tmp('vboard-repo-')
    execFileSync('git', ['init', '-q', '-b', 'feat/hooks'], { cwd: repo })
    // Markers live in the temp directory: fresh session IDs keep runs apart.
    const s1 = `s1-${Date.now()}`
    const claude = { CLAUDE_CODE_SESSION_ID: s1 }
    const stop = (session: string, continuing = false, extra: NodeJS.ProcessEnv = {}) =>
      vb(['hook', 'stop', '--agent', 'claude'], extra, JSON.stringify({ session_id: session, cwd: repo, hook_event_name: 'Stop', stop_hook_active: continuing }))
    const reminds = async (result: Promise<{ stdout: string; code: number }>) => {
      const { stdout, code } = await result
      expect(code).toBe(0)
      if (!stdout) return null
      // Feedback, not a blocked stop: Claude Code shows it once, without a hook error.
      const output = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
      expect(output).toEqual({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: expect.any(String) } })
      return { reason: output.hookSpecificOutput.additionalContext }
    }

    // A turn that didn't touch the board is reminded once, with the commands to run; the follow-up stops.
    const reminded = await reminds(stop(s1))
    expect(reminded!.reason).toContain(' post <channel> "<text>"')
    expect(reminded!.reason).toContain(' reply <id> "<text>"')
    expect(reminded!.reason).not.toContain('main.ts update')
    // Codex reads a blocked stop.
    const codex = await vb(['hook', 'stop', '--agent', 'codex'], {}, JSON.stringify({ session_id: `c1-${Date.now()}`, cwd: repo, stop_hook_active: false }))
    expect(JSON.parse(codex.stdout)).toEqual({ decision: 'block', reason: expect.stringContaining(' post <channel> "<text>"') })
    expect(await reminds(stop(s1, true))).toBeNull()

    // The agent posts in a channel it picked: the turn's end isn't reminded. The next turn, with no write, is.
    const root = (await vb_in(repo, ['post', 'dev', 'Added the turn-end hook; tests next.'], claude)).stdout.trim()
    expect(await reminds(stop(s1))).toBeNull()
    expect(await reminds(stop(s1))).not.toBeNull()
    // With nothing to share, it just finishes: reminded already this turn, so it stops.
    expect(await reminds(stop(s1))).toBeNull()
    // A reply in a thread it's working in counts too.
    expect(await vb_in(repo, ['reply', root, 'Tests pass.'], claude)).toMatchObject({ code: 0, stderr: '' })
    expect(await reminds(stop(s1))).toBeNull()

    // An older hook, installed with --channel, still runs; the reminder no longer names a channel.
    const old = await reminds(vb(['hook', 'stop', '--agent', 'claude', '--channel', 'eng/work'], {}, JSON.stringify({ session_id: `s3-${Date.now()}`, cwd: repo })))
    expect(old!.reason).not.toContain('eng/work')

    // `vb update` is gone, and says what to run instead.
    expect(await vb_in(repo, ['update', 'hi'], claude)).toMatchObject({ code: 2, stderr: expect.stringContaining('vb reply <id>') })

    // Outside a linked project, the hook stays out of the way.
    expect(await reminds(stop(`s2-${Date.now()}`, false, { VBOARD_URL: '' }))).toBeNull()
  }, 60_000)

  it('offers once per board, after the first reminder, to link the person\'s accounts', async () => {
    const repo = await tmp('vboard-repo-')
    execFileSync('git', ['init', '-q', '-b', 'feat/link'], { cwd: repo })
    // Its own config directory: the offer's marker lives there, not with the per-turn markers.
    const at = { XDG_CONFIG_HOME: await tmp('vboard-config-') }
    const stop = async (extra: NodeJS.ProcessEnv = {}) => {
      const payload = JSON.stringify({ session_id: `l-${Math.random()}`, cwd: repo, stop_hook_active: false })
      const { stdout } = await vb(['hook', 'stop', '--agent', 'claude'], { ...at, ...extra }, payload)
      return JSON.parse(stdout).hookSpecificOutput.additionalContext as string
    }

    const first = await stop()
    expect(first).toContain(' post <channel> "<text>"')
    expect(first).toContain(' identity link <key> --no-wait')
    // Every later reminder, in any session, is just the reminder.
    const later = await stop()
    expect(later).toContain(' post <channel> "<text>"')
    expect(later).not.toContain('identity')
    // Another board gets its own offer.
    expect(await stop({ VBOARD_URL: `${url}?other` })).toContain(' identity link <key> --no-wait')
  })

  it('reminds Cursor with a follow-up message, keyed by project since its shell has no session', async () => {
    const home = await tmp('vboard-home-')
    expect((await vb(['hooks', 'install', 'cursor'], { HOME: home })).stdout).toContain('Cursor  ~/.cursor/hooks.json\n  added the turn-end hook\n')
    expect(JSON.parse(await readFile(join(home, '.cursor', 'hooks.json'), 'utf8'))).toEqual({
      version: 1,
      hooks: { stop: [{ command: expect.stringMatching(/ hook stop --agent cursor 2>\/dev\/null \|\| true$/), timeout: 10 }] },
    })

    const repo = await tmp('vboard-repo-')
    execFileSync('git', ['init', '-q', '-b', 'feat/cursor'], { cwd: repo })
    const stop = (payload: Record<string, unknown>) =>
      vb(['hook', 'stop', '--agent', 'cursor'], {}, JSON.stringify({ conversation_id: `c-${Date.now()}`, workspace_roots: [repo], hook_event_name: 'stop', ...payload }))

    expect(JSON.parse((await stop({ status: 'completed', loop_count: 0 })).stdout)).toEqual({ followup_message: expect.stringContaining(' post <channel> "<text>"') })
    expect((await stop({ status: 'completed', loop_count: 1 })).stdout).toBe('')
    // The agent posts from Cursor's shell, which says only CURSOR_AGENT=1: the project's next turn end isn't reminded.
    expect(await vb_in(repo, ['post', 'dev', 'Renamed the helper.'], { CURSOR_AGENT: '1' })).toMatchObject({ code: 0, stderr: '' })
    expect((await stop({ status: 'completed', loop_count: 0 })).stdout).toBe('')
    // An aborted turn isn't reminded.
    expect((await stop({ status: 'aborted', loop_count: 0 })).stdout).toBe('')

    // Uninstalling removes the file it created.
    expect((await vb(['hooks', 'uninstall', 'cursor'], { HOME: home })).stdout).toContain('removed')
    await expect(readFile(join(home, '.cursor', 'hooks.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it("reminds Pi through an extension before its run settles, once, and not after it posts with vb", async () => {
    const home = await tmp('vboard-home-')
    const agentDir = join(home, 'pi-agent')
    const at = { HOME: home, PI_CODING_AGENT_DIR: agentDir }
    const file = join(agentDir, 'extensions', 'vboard.ts')
    expect((await vb(['hooks', 'install', 'pi'], at)).stdout).toContain('Pi  ~/pi-agent/extensions/vboard.ts\n  added the turn-end hook\n')
    expect((await vb(['hooks', 'install', 'pi'], at)).stdout).toContain('  already installed\n')
    expect((await vb(['hooks', 'status', 'pi'], at)).stdout).toBe('Pi  installed  ~/pi-agent/extensions/vboard.ts\n')

    // Load it as Pi does, with a stand-in for Pi's API, and run its handler as Pi would before settling.
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {}
    const { default: extension } = await import(file)
    extension({ on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => (handlers[name] = handler) })
    expect(Object.keys(handlers)).toEqual(['agent_before_settle'])
    const repo = await tmp('vboard-repo-')
    execFileSync('git', ['init', '-q', '-b', 'feat/pi'], { cwd: repo })
    const session = `pi-${Date.now()}`
    const ctx = { cwd: repo, sessionManager: { getSessionId: () => session } }
    const settle = (outcome = 'completed') => handlers.agent_before_settle!({ type: 'agent_before_settle', outcome, entries: [], continue: false }, ctx)
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    try {
      // A run that didn't touch the board continues once, with the reminder as a message; the follow-up settles.
      expect(await settle()).toEqual({
        entries: [{ type: 'custom_message', customType: 'vboard', content: expect.stringContaining(' post <channel> "<text>"'), display: true }],
        continue: true,
      })
      expect(await settle()).toBeUndefined()
      // Pi's bash tool exports the session as PI_SESSION_ID: its post counts, so the next run settles freely.
      expect(await vb_in(repo, ['post', 'dev', 'Taught Pi the hook.'], { PI_CODING_AGENT: 'true', PI_SESSION_ID: session })).toMatchObject({ code: 0, stderr: '' })
      expect(await settle()).toBeUndefined()
      // An aborted run isn't reminded.
      expect(await settle('aborted')).toBeUndefined()
      expect(await settle()).toMatchObject({ continue: true })
    } finally {
      vi.unstubAllEnvs()
    }
    const { stdout } = await vb(['read', 'dev', '--text', 'Taught Pi', '--json'])
    expect(stdout.trim().split('\n').map((line) => JSON.parse(line).message).map((m) => [m.by.profile, m.by.session, m.text])).toEqual([['pi', session, 'Taught Pi the hook.']])

    // It won't overwrite an extension that isn't its own; uninstalling removes only its file.
    expect((await vb(['hooks', 'uninstall', 'pi'], at)).stdout).toBe('Pi  removed  ~/pi-agent/extensions/vboard.ts\n')
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(file, 'export default () => {}\n')
    expect(await vb(['hooks', 'install', 'pi'], at)).toMatchObject({ code: 1, stderr: `error: ${file} isn't vboard's: move it, then install again\n` })
    expect((await vb(['hooks', 'status', 'pi'], at)).stdout).toBe('Pi  not installed\n')
    expect(await readFile(file, 'utf8')).toBe('export default () => {}\n')
  }, 30_000)
})
