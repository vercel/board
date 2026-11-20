import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env, url, useBoard, vb } from './cli-harness.ts'
import { localUserToken, personToken, workflowToken } from './tokens.ts'

useBoard()
// As `vb serve`'s own user, the board's owner, whom no grant limits.
beforeAll(async () => {
  env.BOARD_TOKEN = await localUserToken('julian', url)
})

/** The board's grants, back to the three it starts with. */
async function startOver() {
  const { stdout } = await vb(['grants', '--json'])
  for (const { id } of JSON.parse(stdout).grants as { id: string }[]) if (!['g1', 'g2', 'g3'].includes(id)) await vb(['grants', 'revoke', id])
}

/** `grants create`, and the ID it made. */
async function create(...args: string[]) {
  const made = await vb(['grants', 'create', ...args])
  expect(made).toMatchObject({ code: 0, stderr: '' })
  return { id: /^created (g\d+) /.exec(made.stdout)![1]!, stdout: made.stdout }
}

beforeEach(startOver)

describe('cli grants', () => {
  it('creates a grant from principal flags, each modifier with the principal before it, and lists it as those flags', async () => {
    const closed = await create('--everyone', '--can', 'security/=none')
    expect(closed.stdout).toBe(`created ${closed.id}  --everyone  security/=none\n`)
    const people = await create('--user', 'u_alice', '--user', 'u_bob', '--can', 'security/=all')
    expect(people.stdout).toBe(`created ${people.id}  --user u_alice --user u_bob  security/=all\n`)
    // -p and -e, as the Vercel CLI writes them, and -e repeated, gathered into one list.
    const project = await create('-p', 'prj_sec', '-e', 'production', '-e', 'preview', '--can', 'security/=read,post', '--can', 'dev/=read')
    expect(project.stdout).toBe(`created ${project.id}  --project prj_sec --environment production,preview  dev/=read security/=read,post\n`)
    const runs = await create('--github', 'acme/web', '--workflow', 'ci.yml', '--git-branch', 'main', '--github', 'acme/api', '--workflow', 'deploy.yml', '--can', 'ci/=post')
    expect(runs.stdout).toBe(`created ${runs.id}  --github acme/web --workflow ci.yml --git-branch main --github acme/api --workflow deploy.yml  ci/=post\n`)
    const issuer = await create('--oidc', 'https://gitlab.com', '--claim', 'sub=project_path:acme/api:*', '--claim', 'project_id=42', '--can', 'ci/=post')
    expect(issuer.stdout).toBe(`created ${issuer.id}  --oidc https://gitlab.com --claim project_id=42 --claim sub=project_path:acme/api:*  ci/=post\n`)
    // A project without --environment is its production deployments.
    const web = await create('--project', 'prj_web', '--can', 'web/=all')
    expect(web.stdout).toBe(`created ${web.id}  --project prj_web --environment production  web/=all\n`)
    // An app by its client ID, as a board that verifies tokens itself takes it.
    const app = await create('--app', 'cl_ship', '--can', 'ship/=post')
    expect(app.stdout).toBe(`created ${app.id}  --app cl_ship  ship/=post\n`)

    // Each column as wide as its widest cell, two spaces apart.
    const width = 93
    expect((await vb(['grants'])).stdout).toBe(
      [
        ['g1', '--all-users', 'everything'],
        ['g2', '--all-projects --environment production,preview,development', 'read post react label sync'],
        ['g3', '--all-apps', 'read post react label'],
        [closed.id, '--everyone', 'security/=none'],
        [people.id, '--user u_alice --user u_bob', 'security/=all'],
        [project.id, '--project prj_sec --environment production,preview', 'dev/=read security/=read,post'],
        [runs.id, '--github acme/web --workflow ci.yml --git-branch main --github acme/api --workflow deploy.yml', 'ci/=post'],
        [issuer.id, '--oidc https://gitlab.com --claim project_id=42 --claim sub=project_path:acme/api:*', 'ci/=post'],
        [web.id, '--project prj_web --environment production', 'web/=all'],
        [app.id, '--app cl_ship', 'ship/=post'],
      ]
        .map(([id, principals, can]) => `${id!.padEnd(3)}  ${principals!.padEnd(width)}  ${can}\n`)
        .join(''),
    )
    const listed = JSON.parse((await vb(['grants', '--json'])).stdout).grants as { id: string; principals: unknown[] }[]
    expect(listed.find((grant) => grant.id === runs.id)!.principals).toEqual([
      { kind: 'github', repositoryId: null, repository: 'acme/web', workflow: '.github/workflows/ci.yml', branch: 'main' },
      { kind: 'github', repositoryId: null, repository: 'acme/api', workflow: '.github/workflows/deploy.yml' },
    ])
    // --branch is --git-branch now, as the Vercel CLI names a Git branch.
    expect(await vb(['grants', 'create', '--github', 'acme/web', '--branch', 'main', '--can', 'ci/=post'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: Unknown option --branch for vb grants\./) })
    const help = (await vb(['grants', 'create', '--help'])).stdout
    expect(help).toMatch(/\n  -p, --project <name\|id>\.\.\. +a project's deployments\n/)
    expect(help).toMatch(/\n  -e, --environment <environment>\.\.\. +where its --project runs/)
    expect(help).toMatch(/\n  --git-branch <branch>\.\.\. +its --github's branch\n/)
  }, 30_000)

  it('updates a grant by its ID: adds and removes principals, and replaces its can', async () => {
    const { id } = await create('--user', 'u_alice', '--user', 'u_bob', '--can', 'security/=all')
    expect((await vb(['grants', 'update', id, '--add-user', 'u_carol'])).stdout).toBe(`updated ${id}  --user u_alice --user u_bob --user u_carol  security/=all\n`)
    const project = await create('--project', 'prj_sec', '--environment', 'production', '--can', 'security/=read,post')
    // Adding a project it names already adds the environments.
    expect((await vb(['grants', 'update', project.id, '--add-project', 'prj_sec', '--environment', 'preview'])).stdout).toBe(
      `updated ${project.id}  --project prj_sec --environment production,preview  security/=read,post\n`,
    )
    // Removing and adding it back in one update narrows it.
    expect((await vb(['grants', 'update', project.id, '--remove-project', 'prj_sec', '--add-project', 'prj_sec', '--environment', 'preview', '--can', 'security/=read'])).stdout).toBe(
      `updated ${project.id}  --project prj_sec --environment preview  security/=read\n`,
    )
    expect((await vb(['grants', 'update', id, '--remove-user', 'u_alice', '--add-github', 'acme/web', '--workflow', 'ci.yml'])).stdout).toBe(
      `updated ${id}  --user u_bob --user u_carol --github acme/web --workflow ci.yml  security/=all\n`,
    )
    // Every app on the team, in place of one.
    const app = await create('--app', 'cl_ship', '--can', 'ship/=post')
    expect((await vb(['grants', 'update', app.id, '--add-all-apps', '--remove-app', 'cl_ship'])).stdout).toBe(`updated ${app.id}  --all-apps  ship/=post\n`)
    const json = JSON.parse((await vb(['grants', 'update', id, '--can', 'security/=read', '--json'])).stdout)
    expect(json).toMatchObject({ grant: { id, can: { 'security/': ['read'] } }, outcome: 'updated' })
  }, 30_000)

  it("says how to drop one environment, and refuses an update that changes nothing or names a principal it can't", async () => {
    const { id } = await create('--project', 'prj_sec', '--environment', 'production,preview', '--can', 'security/=read')
    const narrowed = await vb(['grants', 'update', id, '--remove-project', 'prj_sec', '--environment', 'preview'])
    expect(narrowed).toMatchObject({ code: 2, stdout: '' })
    expect(narrowed.stderr).toBe(
      [
        'error: --remove-project prj_sec removes it whatever its environments, so it takes no --environment.',
        '',
        '  Remove it and add it back with the environments it keeps:',
        `    vb grants update ${id} --remove-project prj_sec --add-project prj_sec --environment <ENVIRONMENTS>`,
        '',
      ].join('\n'),
    )
    const refused = async (...args: string[]) => {
      const { code, stderr } = await vb(['grants', 'update', ...args])
      return [code, stderr.split('\n')[0]]
    }
    expect(await refused(id)).toEqual([2, `error: grants update ${id} changes nothing: add or remove a principal (--add-user, --remove-project, …), or give --can.`])
    expect(await refused(id, '--user', 'u_ada')).toEqual([2, 'error: grants update adds and removes principals: --add-user or --remove-user, not --user.'])
    expect(await refused(id, '--remove-project', 'prj_sec')).toEqual([2, `error: Can't update grant ${id}.`])
    expect(await refused('g999', '--can', 'dev/=read')).toEqual([1, "error: Couldn't find grant g999."])
    expect((await vb(['grants', '--json'])).stdout).toContain('"security/":["read"]')
  }, 30_000)

  it('gathers a repeated --claim into one claim that any of its values meets', async () => {
    const made = await create('--oidc', 'https://gitlab.com', '--claim', 'sub=project_path:acme/api:*', '--claim', 'project_id=42', '--claim', 'ref_type=branch', '--claim', 'project_id=43', '--can', 'ci/=post')
    expect(made.stdout).toBe(`created ${made.id}  --oidc https://gitlab.com --claim project_id=42 --claim project_id=43 --claim ref_type=branch --claim sub=project_path:acme/api:*  ci/=post\n`)
    const listed = JSON.parse((await vb(['grants', '--json'])).stdout).grants.find((grant: { id: string }) => grant.id === made.id)
    expect(listed.principals).toEqual([{ kind: 'oidc', issuer: 'https://gitlab.com', claims: { project_id: ['42', '43'], ref_type: 'branch', sub: 'project_path:acme/api:*' } }])
  })

  it("says the board's refusal of an issuer's grant that names no sub", async () => {
    expect(await vb(['grants', 'create', '--oidc', 'https://gitlab.com', '--claim', 'project_id=42', '--can', 'ci/=post'])).toEqual({
      code: 2,
      stdout: '',
      stderr: "error: Can't create the grant.\n  name a sub for https://gitlab.com, like project_path:acme/api:*: it signs tokens for everyone it serves, and only a sub says whose a token is\n",
    })
  })

  it('reads each modifier with the principal before it, and refuses one without its principal, making nothing', async () => {
    const refused = async (...args: string[]) => {
      const { code, stderr } = await vb(['grants', 'create', ...args])
      return [code, stderr.split('\n')[0]]
    }
    expect(await refused('--environment', 'production', '--project', 'prj_web', '--can', 'dev/=read')).toEqual([2, "error: --environment goes after the --project or --all-projects it's for."])
    expect(await refused('--github', 'acme/web', '--environment', 'production', '--can', 'dev/=read')).toEqual([2, 'error: --environment is for --project or --all-projects, not --github acme/web.'])
    expect(await refused('--project', 'prj_web', '--github', 'acme/web', '--claim', 'a=b', '--can', 'dev/=read')).toEqual([2, 'error: --claim is for --oidc, not --github acme/web.'])
    expect(await refused('--github', 'acme/web', '--workflow', 'a.yml', '--workflow', 'b.yml', '--can', 'ci/=post')).toEqual([2, 'error: --github acme/web takes one --workflow: name the repository again for another.'])
    expect(await refused('--github', 'web', '--can', 'ci/=post')).toEqual([2, 'error: --github takes owner/repo, like acme/web: got web.'])
    expect(await refused('--user', 'u_ada')).toEqual([2, "error: A grant says what it lets them do: --can pattern=permissions, like --can 'ci/=read,post'."])
    expect(await refused('--can', 'dev/=read')).toEqual([2, 'error: A grant names whom it lets in: --user, --project, --github, --oidc, --all-users, --all-projects, or --everyone.'])
    expect(await refused('--add-user', 'u_ada', '--can', 'dev/=read')).toEqual([2, 'error: --add-user is for grants update: grants create names principals as --user.'])
    expect(await refused('--user', 'u_ada', '--can', 'dev/=read,none')).toEqual([2, 'error: --can: none is no permissions, so it goes alone: dev/=none.'])
    expect(await refused('--user', 'u_ada', '--can', 'dev/=all,read')).toEqual([2, 'error: --can: all is every permission, so it goes alone: dev/=all.'])
    expect(await refused('--user', 'u_ada', '--can', 'dev/=write')).toEqual([2, "error: --can: write isn't a permission. Permissions are read, post, react, label, sync, manage, all, or none."])
    expect(await refused('--user', 'u_ada', '--can', 'dev/=read', '--can', 'dev/=post')).toEqual([2, 'error: --can names dev/ twice: say it once, with every permission it gives.'])
    expect((await vb(['grants'])).stdout.trim().split('\n')).toHaveLength(3)
  }, 30_000)

  it('makes the grants a --file holds in one write, from a path or from stdin, or none of them', async () => {
    const grants = [
      { principals: [{ kind: 'everyone' }], can: { 'security/': 'none' } },
      { principals: [{ kind: 'user', userId: 'u_alice' }, { kind: 'user', userId: 'u_bob' }], can: { 'security/': 'all', 'dev/': ['read'] } },
      { principals: [{ kind: 'project', project: 'prj_sec', environments: ['preview'] }], can: { 'security/': ['read'] } },
    ]
    const path = join(await mkdtemp(join(tmpdir(), 'board-grants-')), 'grants.json')
    await writeFile(path, JSON.stringify(grants))
    const made = await vb(['grants', 'create', '--file', path])
    expect(made).toMatchObject({ code: 0, stderr: '' })
    // One line each, in the file's order, with IDs that count up.
    const rows = made.stdout.trimEnd().split('\n')
    const first = Number(/^created g(\d+) /.exec(rows[0]!)![1])
    expect(rows).toEqual([
      `created g${first}  --everyone  security/=none`,
      `created g${first + 1}  --user u_alice --user u_bob  dev/=read security/=all`,
      `created g${first + 2}  --project prj_sec --environment preview  security/=read`,
    ])
    const two = JSON.stringify([{ principals: [{ kind: 'user', userId: 'u_carol' }], can: { 'dev/': ['read'] } }, { principals: [{ kind: 'user', userId: 'u_dan' }], can: { 'dev/': ['post'] } }])
    const json = JSON.parse((await vb(['grants', 'create', '--file', '-', '--json'], {}, two)).stdout)
    expect(json).toMatchObject({ outcome: 'created', grants: [{ id: `g${first + 3}`, can: { 'dev/': ['read'] } }, { id: `g${first + 4}`, can: { 'dev/': ['post'] } }] })
    // A command's own flags are one grant, wherever each sits, as they always were.
    const one = await vb(['grants', 'create', '--can', 'ops/=none', '--user', 'u_erin', '--can', 'dev/=all', '--user', 'u_frank'])
    expect([one.code, one.stdout]).toEqual([0, `created g${first + 5}  --user u_erin --user u_frank  dev/=all ops/=none\n`])
    const refused = async (stdin: string, ...args: string[]) => {
      const { code, stderr } = await vb(['grants', 'create', ...args], {}, stdin)
      return [code, stderr.split('\n')[0]]
    }
    // One of them refused by the board, and none is made.
    expect(await refused(JSON.stringify([{ principals: [{ kind: 'user', userId: 'u_gail' }], can: { 'dev/': ['read'] } }, { principals: [{ kind: 'user', userId: 'not a user' }], can: { 'dev/': ['post'] } }]), '--file', '-')).toEqual([2, "error: Can't create the grants."])
    // What isn't a list of grants, or is too many, never reaches the board.
    expect(await refused('{', '--file', '-')).toEqual([2, "error: stdin isn't JSON."])
    expect(await refused('[]', '--file', '-')).toEqual([2, 'error: stdin holds no grants. It\'s a JSON array of them: [{"principals": [{"kind": "everyone"}], "can": {"ci/": ["read"]}}].'])
    expect(await refused(JSON.stringify(Array.from({ length: 17 }, () => grants[2])), '--file', '-')).toEqual([2, 'error: stdin holds 17 grants, and one write makes 16 at most.'])
    expect(await refused('', '--file', join(tmpdir(), 'no-such-grants.json'))).toEqual([2, `error: Can't read ${join(tmpdir(), 'no-such-grants.json')}. There's no such file.`])
    expect(await refused(two, '--file', '-', '--user', 'u_gail')).toEqual([2, 'error: --file holds the grants: each one in it names its own principals and can, so it goes without theirs.'])
    expect((await vb(['grants'])).stdout.trim().split('\n')).toHaveLength(9)
  }, 30_000)

  it("refuses a grant change its caller couldn't take back, with the command that keeps them in and the one that goes ahead", async () => {
    // A run a grant lets manage everything is no owner: closing factory/ to everyone closes it to the run too.
    await create('--github', 'acme/web', '--can', '*=all')
    const run = { BOARD_TOKEN: await workflowToken({}, url) }
    const lock = ['grants', 'create', '--everyone', '--can', 'factory/=read', '--can', 'factory/memory/=none']
    const refused = await vb(lock, run)
    expect([refused.code, refused.stdout, refused.stderr]).toEqual([
      1,
      '',
      [
        "error: Can't create the grant: it would lock you out.",
        '  this grant would leave you unable to manage grants in factory/',
        '',
        '  Keep manage there yourself first:',
        // Whoever runs it, as a grant would name them: here a repository's runs.
        "    vb grants create --github acme/web --can 'factory/=all;factory/memory/=all'",
        '  Make it anyway:',
        '    vb grants create --everyone --can factory/=read --can factory/memory/=none --lock-me-out',
        '',
      ].join('\n'),
    ])
    expect(JSON.parse((await vb([...lock, '--json'], run)).stderr)).toMatchObject({ status: 'error', reason: 'grant_lockout', data: { error: { code: 'grant_lockout', status: 409 } } })
    // A person is named as a person, on the board the run named, and once that grant is made, the lock is no lockout.
    const ada = { BOARD_TOKEN: await personToken('u_ada', url) }
    const asked = await vb(['grants', 'create', '--everyone', '--can', 'attic/=none', '--url', url], ada)
    expect(asked.stderr.split('\n')[4]).toBe(`    vb grants create --user u_ada --can attic/=all --url ${url}`)
    expect((await vb(['grants', 'create', '--user', 'u_ada', '--can', 'attic/=all'], ada)).code).toBe(0)
    expect((await vb(['grants', 'create', '--everyone', '--can', 'attic/=none'], ada)).code).toBe(0)
    // From a file, the grant that keeps its maker in goes in the file.
    const filed = await vb(['grants', 'create', '--file', '-'], ada, JSON.stringify([{ principals: [{ kind: 'everyone' }], can: { 'cellar/': 'none' } }]))
    expect([filed.code, ...filed.stderr.split('\n').slice(0, 4)]).toEqual([
      1,
      "error: Can't create the grants: it would lock you out.",
      '  this grant would leave you unable to manage grants in cellar/',
      '',
      '  Keep manage there yourself: add a grant to the file that names you, with all there',
    ])
    await startOver()
    await create('--github', 'acme/web', '--can', '*=all')
    expect((await vb(['grants'])).stdout.trim().split('\n')).toHaveLength(4)
    // With the grant that keeps the run in, in the same command, it's made, and the run's to change.
    const both = JSON.stringify([
      { principals: [{ kind: 'everyone' }], can: { 'factory/': ['read'], 'factory/memory/': 'none' } },
      { principals: [{ kind: 'github', repository: 'acme/web' }], can: { 'factory/': 'all', 'factory/memory/': 'all' } },
    ])
    const kept = await vb(['grants', 'create', '--file', '-'], run, both)
    const [closes, keeps] = [...kept.stdout.matchAll(/^created (g\d+) /gm)].map((found) => found[1]!)
    expect([kept.code, kept.stdout]).toEqual([0, `created ${closes}  --everyone  factory/=read factory/memory/=none\ncreated ${keeps}  --github acme/web  factory/=all factory/memory/=all\n`])
    // Revoking or narrowing what keeps it in is the same lockout, until it's told to go ahead.
    const revoked = await vb(['grants', 'revoke', keeps!], run)
    expect([revoked.code, revoked.stderr]).toEqual([
      1,
      [
        `error: Can't revoke grant ${keeps}: it would lock you out.`,
        `  revoking ${keeps} would leave you unable to manage grants in factory/`,
        '',
        '  Keep manage there first, with another grant that names you',
        '  Revoke it anyway:',
        `    vb grants revoke ${keeps} --lock-me-out`,
        '',
      ].join('\n'),
    ])
    const updated = await vb(['grants', 'update', keeps!, '--can', 'factory/=read'], run)
    expect([updated.code, updated.stderr.split('\n')[0], updated.stderr.split('\n').at(-2)]).toEqual([1, `error: Can't update grant ${keeps}: it would lock you out.`, `    vb grants update ${keeps} --can factory/=read --lock-me-out`])
    expect((await vb(['grants', 'update', keeps!, '--can', 'factory/=read', '--lock-me-out'], run)).stdout).toBe(`updated ${keeps}  --github acme/web  factory/=read\n`)
    // Locked out, it lifts nothing there, whatever it says: the owner does.
    expect((await vb(['grants', 'revoke', closes!, '--lock-me-out'], run)).code).toBe(1)
    expect((await vb(['grants', 'revoke', closes!])).stdout).toBe(`revoked ${closes}\n`)
    // A revoke told to go ahead is done.
    const attic = await vb(['grants', 'create', '--file', '-'], run, JSON.stringify([{ principals: [{ kind: 'everyone' }], can: { 'attic/': 'none' } }, { principals: [{ kind: 'github', repository: 'acme/web' }], can: { 'attic/': 'all' } }]))
    const inAttic = /^created (g\d+)  --github/m.exec(attic.stdout)![1]!
    expect((await vb(['grants', 'revoke', inAttic], run)).code).toBe(1)
    expect((await vb(['grants', 'revoke', inAttic, '--lock-me-out'], run)).stdout).toBe(`revoked ${inAttic}\n`)
  }, 30_000)

  it('explains which grant decides a channel, for you or for a principal it names', async () => {
    const closed = await create('--everyone', '--can', 'security/=none')
    const people = await create('--user', 'u_alice', '--user', 'u_bob', '--can', 'security/=all')
    const explain = async (...args: string[]) => (await vb(['grants', 'explain', ...args])).stdout
    expect(await explain('--user', 'u_bob', 'security/incidents')).toBe(`security/ wins over *. Closest grant for u_bob: ${people.id} (--user): all.\n`)
    expect(await explain('--user', 'u_dan', 'security/incidents')).toBe(`security/ wins over *. Closest grant for u_dan: ${closed.id} (--everyone): none.\n`)
    expect(await explain('--user', 'u_dan', 'dev')).toBe('* wins. Closest grant for u_dan: g1 (--all-users): all.\n')
    expect(await explain('--project', 'prj_web', '--environment', 'preview', 'dev')).toBe('* wins. Closest grant for prj_web in preview: g2 (--all-projects): read,post,react,label,sync.\n')
    expect(await explain('--github', 'acme/other', 'dev')).toBe('Nothing lets acme/other into dev.\n')
    // A local board has no apps.
    expect(await explain('--app', 'cl_ship', 'dev')).toBe('Nothing lets cl_ship into dev.\n')
    // Even a team owner reads a closed channel only by a grant.
    expect(await explain('security/incidents')).toBe(`security/ wins over *. Closest grant for you: ${closed.id} (--everyone): none.\n`)
    expect(JSON.parse(await explain('--user', 'u_bob', 'security', '--json'))).toEqual({
      explanation: { channel: 'security', pattern: 'security/', over: ['*'], level: 'principal', grants: [expect.objectContaining({ id: people.id })], capped: null, can: ['read', 'post', 'react', 'label', 'sync', 'manage'] },
    })
    // A caller that can't list grants sees that one decides, not which.
    await create('--github', 'acme/web', '--can', '*=read')
    expect((await vb(['grants', 'explain', 'dev'], { BOARD_TOKEN: await workflowToken({}, url) })).stdout).toBe("* wins. Closest grant for you: one you can't list: read.\n")

    const refused = async (...args: string[]) => {
      const { code, stderr } = await vb(['grants', 'explain', ...args])
      return [code, stderr.split('\n')[0]]
    }
    expect(await refused('--user', 'u_a', '--user', 'u_b', 'dev')).toEqual([2, 'error: explain asks about one principal at a time.'])
    expect(await refused('--all-users', 'dev')).toEqual([2, 'error: explain asks about someone: --user, --project, --github, --oidc, or --app, not --all-users.'])
    expect(await refused('--project', 'prj_web', '--environment', 'production,preview', 'dev')).toEqual([2, 'error: explain asks about one environment at a time: --environment production.'])
    expect(await refused('--user', 'u_a')).toEqual([2, 'error: Missing the channel to explain, such as security/incidents.'])
  }, 30_000)

  it('makes a private channel and the two grants that close it', async () => {
    const made = await vb(['channels', 'create', 'vault', '--private'])
    expect(made).toMatchObject({ code: 0, stderr: '' })
    // The channel, then the grant that lets you in and the one that closes it to everyone else, as they were made.
    const [channel, own, lock] = made.stdout.trimEnd().split('\n')
    expect(channel).toBe('created channel vault')
    expect(own).toMatch(/^created g\d+  --user julian  vault\/=all$/)
    expect(lock).toMatch(/^created g\d+  --everyone  vault\/=none$/)
    // Its grants reach it already, so another private vault would leave them letting in whom they name.
    const [ownId, lockId] = [own, lock].map((line) => /^created (g\d+)/.exec(line!)![1]!)
    const again = await vb(['channels', 'create', 'vault', '--private'])
    expect([again.code, again.stderr]).toEqual([1, `error: ${ownId} and ${lockId} already grant in vault, so a private vault wouldn't be yours alone: nothing was made.\n\n  Revoke them first, each with vb grants revoke <id>.\n`])
    expect(JSON.parse((await vb(['channels', 'create', 'vault', '--private', '--json'])).stderr)).toMatchObject({ reason: 'channel_granted' })
    expect((await vb(['channels', 'create', 'open-plan'])).stdout).toBe('created open-plan\n')
  }, 30_000)

})
