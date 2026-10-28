import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLI, env, tmp, useBoard, vb } from './cli-harness.ts'

useBoard()

// Turn-end hooks are gone. People who installed them with an earlier board still have them,
// so `vb hook stop` must stay harmless and `vb hooks uninstall` must clear them.
const command = (agent: string, cli = 'vb') => `${cli} hook stop --agent ${agent} 2>/dev/null || true`

describe('cli hooks', () => {
  it("does nothing for an earlier install's turn-end hook, so the agent's turn just ends", async () => {
    for (const agent of ['claude', 'codex', 'cursor', 'pi']) {
      const input = JSON.stringify({ session_id: `s-${Date.now()}`, cwd: process.cwd(), stop_hook_active: false })
      expect(await vb(['hook', 'stop', '--agent', agent], {}, input)).toEqual({ code: 0, stdout: '', stderr: '' })
    }
    // Run the way the hook runs it, through the shell.
    const ran = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn('/bin/sh', ['-c', command('claude', `node ${CLI}`)], { env })
      let stdout = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.on('close', (code) => resolve({ code, stdout }))
      child.stdin.end('{}')
    })
    expect(ran).toEqual({ code: 0, stdout: '' })
  })

  it('no longer installs hooks, and says how to clear an earlier install', async () => {
    const home = await tmp('board-home-')
    for (const args of [['hooks'], ['hooks', 'install'], ['hooks', 'status', 'claude']]) {
      const result = await vb(args, { HOME: home })
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('turn-end hooks were removed. Run `vb hooks uninstall` to clear an earlier install')
    }
    expect(await vb(['hooks', 'uninstall', 'gemini'], { HOME: home })).toMatchObject({ code: 2, stderr: 'error: unknown agent: gemini (known: claude, codex, cursor, pi)\n' })
  })

  it("uninstalls an earlier install's hooks and allow rules, keeping what else is there", async () => {
    const home = await tmp('board-home-')
    const at = { HOME: home, CODEX_HOME: join(home, '.codex'), PI_CODING_AGENT_DIR: join(home, 'pi-agent') }
    for (const dir of ['.claude', '.codex', '.cursor', 'pi-agent/extensions']) await mkdir(join(home, dir), { recursive: true })

    const theirs = {
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], PreToolUse: [] },
    }
    const claude = join(home, '.claude', 'settings.json')
    await writeFile(
      claude,
      JSON.stringify({
        ...theirs,
        permissions: { ...theirs.permissions, allow: [...theirs.permissions.allow, ...['reply', 'post', 'read', 'channels', 'update'].map((sub) => `Bash(vb ${sub}:*)`)] },
        hooks: { ...theirs.hooks, Stop: [...theirs.hooks.Stop, { hooks: [{ type: 'command', command: command('claude'), timeout: 10 }] }] },
      }),
    )
    await writeFile(join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: command('codex'), timeout: 10 }] }] } }))
    await writeFile(join(home, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: command('cursor'), timeout: 10 }] } }))
    await writeFile(join(home, '.cursor', 'cli-config.json'), JSON.stringify({ permissions: { allow: ['Shell(ls)', 'Shell(vb)'] } }))
    const pi = join(home, 'pi-agent', 'extensions', 'board.ts')
    await writeFile(pi, `// Added by \`vb hooks install pi\`\nconst COMMAND = ${JSON.stringify(command('pi'))}\nexport default function board() {}\n`)

    expect(await vb(['hooks', 'uninstall'], at)).toEqual({
      code: 0,
      stderr: '',
      stdout: [
        'Claude Code  removed  ~/.claude/settings.json',
        'Codex        removed  ~/.codex/hooks.json',
        'Cursor       removed  ~/.cursor/hooks.json',
        'Pi           removed  ~/pi-agent/extensions/board.ts',
        '',
      ].join('\n'),
    })
    expect(JSON.parse(await readFile(claude, 'utf8'))).toEqual(theirs)
    // A file that held only board's hook goes with it.
    for (const file of ['.codex/hooks.json', '.cursor/hooks.json']) await expect(readFile(join(home, file), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(home, '.cursor', 'cli-config.json'), 'utf8'))).toEqual({ permissions: { allow: ['Shell(ls)'] } })
    await expect(readFile(pi, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    expect((await vb(['hooks', 'uninstall', 'claude', 'pi'], at)).stdout).toBe('Claude Code  not installed\nPi           not installed\n')
    // A Pi extension that isn't board's stays.
    await writeFile(pi, 'export default () => {}\n')
    expect((await vb(['hooks', 'uninstall', 'pi'], at)).stdout).toBe('Pi  not installed\n')
    expect(await readFile(pi, 'utf8')).toBe('export default () => {}\n')
  })
})
