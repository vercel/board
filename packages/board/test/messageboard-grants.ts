// The grants of the fake `/v1/messageboard`, in the protocol's shapes, as Vercel's API keeps them: a
// board starts with g1 (every person on the team), g2 (every project on it), and g3 (every app
// installed on it), names come in and IDs
// are stored, and a person's team role caps what grants give them. A combination of its own answers
// explain and decides who may change grants, so `vercel()` runs the conformance kit's grants group
// against something that decides, not against board's own code.

export type Permission = 'read' | 'post' | 'react' | 'label' | 'sync' | 'manage'
const PERMISSIONS: Permission[] = ['read', 'post', 'react', 'label', 'sync', 'manage']
const IMPLIES: Record<Permission, Permission[]> = {
  read: [],
  post: [],
  react: ['read'],
  label: ['read'],
  sync: ['read'],
  manage: ['read', 'post', 'react', 'label', 'sync'],
}

type Can = Record<string, 'all' | Permission[]>
type Stored =
  | { kind: 'user'; userId: string }
  | { kind: 'project'; projectId: string; environments: string[] }
  | { kind: 'github'; repositoryId: string; repository: string; workflow?: string; branch?: string; event?: string }
  | { kind: 'oidc'; issuer: string; claims: Record<string, string | string[]> }
  | { kind: 'all-users' }
  | { kind: 'all-projects'; environments: string[] }
  | { kind: 'app'; clientId: string }
  | { kind: 'all-apps' }
  | { kind: 'everyone' }
type Grant = { id: string; principals: Stored[]; can: Can; by: string | null; at: number | null }
type Level = 'principal' | 'group' | 'everyone'

/**
 * Who asks, or whom explain asks about, as the API knows them from a token. The `x-board-can` it's
 * held to is its `limit`: the most it may do, whatever the grants give it.
 */
export type Who = (
  | { kind: 'user'; userId: string }
  | { kind: 'project'; projectId: string; environment: string }
  | { kind: 'github'; repositoryId: string; repository: string; workflowRef?: string; ref?: string; event?: string }
  | { kind: 'oidc'; issuer: string; claims: Record<string, string> }
  | { kind: 'app'; clientId: string }
) & { limit?: Can }

/** A person's role on the team. */
export type Role = 'owner' | 'member' | 'developer' | 'viewer'

export class GrantRefused extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message = code) {
    super(message)
    this.status = status
    this.code = code
  }
}

const LEVEL: Record<Level, number> = { principal: 0, group: 1, everyone: 2 }
const levelOf = (principal: Stored): Level => (principal.kind === 'everyone' ? 'everyone' : principal.kind === 'all-users' || principal.kind === 'all-projects' || principal.kind === 'all-apps' ? 'group' : 'principal')

/** What a `sub` pattern, `project_path:acme/api:*`, matches the start of, or null for one that matches exactly. */
const subPrefix = (sub: string) => (/^[^*]+[:/]\*$/.test(sub) ? sub.slice(0, -1) : null)

/** Whether grant pattern `pattern` covers `target`, a channel or a pattern of its own. */
function covers(pattern: string, target: string): boolean {
  if (pattern === '*' || pattern === target) return true
  if (!pattern.endsWith('/')) return false
  return target === pattern.slice(0, -1) || target.startsWith(pattern)
}
const specificity = (pattern: string) => (pattern === '*' ? 0 : pattern.endsWith('/') ? pattern.length : Number.MAX_SAFE_INTEGER)

function expand(grant: 'all' | Permission[]): Set<Permission> {
  const out = new Set<Permission>()
  const add = (permission: Permission) => {
    if (out.has(permission)) return
    out.add(permission)
    for (const implied of IMPLIES[permission]) add(implied)
  }
  for (const permission of grant === 'all' ? PERMISSIONS : grant) add(permission)
  return out
}

export function fakeGrants(options: {
  teamId: string
  /** The team's people: user ID to email. */
  members: Record<string, string>
  roles: Record<string, Role>
  /** The team's projects, by ID, with their names. */
  projects: Record<string, string>
  /** GitHub repositories, by `owner/repo`, with their IDs. */
  repositories: Record<string, string>
  /** Apps installed on the team, by client ID, with their slugs. */
  apps: Record<string, string>
}) {
  const grants = new Map<string, Grant>()
  let next = 1
  const add = (principals: Stored[], can: Can, by: string | null) => {
    const grant: Grant = { id: `g${next++}`, principals, can, by, at: by === null ? null : Date.now() }
    grants.set(grant.id, grant)
    return grant
  }
  // What Vercel's API starts every board with.
  add([{ kind: 'all-users' }], { '*': 'all' }, null)
  add([{ kind: 'all-projects', environments: ['production', 'preview', 'development'] }], { '*': ['read', 'post', 'react', 'label', 'sync'] }, null)
  add([{ kind: 'all-apps' }], { '*': ['read', 'post', 'react', 'label'] }, null)

  const invalid = (message: string) => new GrantRefused(400, 'invalid_grant', message)

  /** A principal as people name it, to what the API stores: an email to a user ID, a project's name to its ID, a repository to its ID. */
  function resolve(input: Record<string, any>, removal = false): Stored {
    switch (input.kind) {
      case 'user': {
        const userId = input.userId ?? Object.keys(options.members).find((id) => options.members[id] === input.email)
        if (typeof userId !== 'string' || !(userId in options.members)) throw new GrantRefused(400, 'user_not_found', `no one on the team is ${input.email ?? input.userId}`)
        return { kind: 'user', userId }
      }
      case 'project': {
        const projectId = input.project in options.projects ? input.project : Object.keys(options.projects).find((id) => options.projects[id] === input.project)
        if (!projectId) throw new GrantRefused(400, 'project_not_found', `no project ${input.project} on the team`)
        if (!removal && !Array.isArray(input.environments)) throw invalid('a project names its environments')
        return { kind: 'project', projectId, environments: input.environments ?? [] }
      }
      case 'github': {
        const repositoryId = options.repositories[input.repository]
        if (!repositoryId) throw new GrantRefused(400, 'repository_not_found', `no GitHub repository ${input.repository}`)
        const { workflow, branch, event } = input
        return { kind: 'github', repositoryId, repository: input.repository, ...(workflow ? { workflow } : {}), ...(branch ? { branch } : {}), ...(event ? { event } : {}) }
      }
      case 'oidc': {
        if (typeof input.issuer !== 'string' || !input.issuer.startsWith('https://')) throw invalid('an oidc issuer is an https URL')
        const claims: Record<string, string | string[]> = input.claims ?? {}
        // A removal goes by who it is, so one stored without a sub can still be taken out.
        if (!removal) {
          if (claims.sub === undefined) throw invalid('an oidc principal names a sub')
          const wild = [claims.sub].flat().find((one) => one.includes('*') && subPrefix(one) === null)
          if (wild !== undefined) throw invalid(`a sub's * goes last, after a : or a /: got ${wild}`)
        }
        return { kind: 'oidc', issuer: input.issuer, claims }
      }
      case 'app': {
        // A slug or a client ID, kept by client ID.
        const clientId = input.app in options.apps ? input.app : Object.keys(options.apps).find((id) => options.apps[id] === input.app)
        if (!clientId) throw new GrantRefused(400, 'app_not_found', `no app ${input.app} on the team`)
        return { kind: 'app', clientId }
      }
      case 'all-users':
      case 'all-apps':
      case 'everyone':
        return { kind: input.kind }
      case 'all-projects':
        if (!removal && !Array.isArray(input.environments)) throw invalid('all-projects names its environments')
        return { kind: 'all-projects', environments: input.environments ?? [] }
      default:
        throw invalid(`no principal kind ${input.kind}`)
    }
  }

  function checkCan(can: unknown): Can {
    if (!can || typeof can !== 'object' || Array.isArray(can) || Object.keys(can).length === 0) throw invalid('can maps channel patterns to permissions')
    for (const [pattern, grant] of Object.entries(can)) {
      if (!/^(\*|[a-z0-9_-]+(\/[a-z0-9_-]+)*\/?)$/.test(pattern)) throw invalid(`${pattern} isn't a channel pattern`)
      if (grant !== 'all' && !(Array.isArray(grant) && grant.every((permission) => PERMISSIONS.includes(permission)))) throw invalid(`${pattern} takes 'all' or permissions`)
    }
    return can as Can
  }

  const sameKey = (a: Stored, b: Stored) => JSON.stringify(a) === JSON.stringify(b)
  function removes(removal: Stored, principal: Stored): boolean {
    if (removal.kind !== principal.kind) return false
    if (removal.kind === 'user') return removal.userId === (principal as typeof removal).userId
    if (removal.kind === 'project') return removal.projectId === (principal as typeof removal).projectId
    if (removal.kind === 'app') return removal.clientId === (principal as typeof removal).clientId
    if (removal.kind === 'github') {
      const other = principal as typeof removal
      return removal.repositoryId === other.repositoryId && (removal.workflow ?? other.workflow) === other.workflow && (removal.branch ?? other.branch) === other.branch && (removal.event ?? other.event) === other.event
    }
    if (removal.kind === 'oidc') return sameKey(removal, principal)
    return true
  }

  const workflowPath = (workflow: string) => (workflow.includes('/') ? workflow : `.github/workflows/${workflow}`)
  const isMember = (userId: string) => userId in options.members
  const onTeam = (projectId: string) => projectId in options.projects

  /** Whether `principal` names `who`, and how closely. */
  function names(principal: Stored, who: Who, admitted: boolean): boolean {
    switch (principal.kind) {
      case 'user':
        return who.kind === 'user' && who.userId === principal.userId
      case 'all-users':
        return who.kind === 'user' && isMember(who.userId)
      case 'project':
        return who.kind === 'project' && who.projectId === principal.projectId && principal.environments.includes(who.environment)
      case 'all-projects':
        return who.kind === 'project' && onTeam(who.projectId) && principal.environments.includes(who.environment)
      case 'app':
        return who.kind === 'app' && who.clientId === principal.clientId
      case 'all-apps':
        return who.kind === 'app' && who.clientId in options.apps
      case 'github':
        return (
          who.kind === 'github' &&
          who.repositoryId === principal.repositoryId &&
          // All of workflow_ref, with the token's own ref, as Vercel's API matches it.
          (principal.workflow === undefined || (who.ref !== undefined && who.workflowRef === `${principal.repository}/${workflowPath(principal.workflow)}@${who.ref}`)) &&
          (principal.branch === undefined || who.ref === `refs/heads/${principal.branch}`) &&
          (principal.event === undefined || who.event === principal.event)
        )
      case 'oidc':
        return (
          who.kind === 'oidc' &&
          who.issuer === principal.issuer &&
          Object.entries(principal.claims).every(([name, value]) => {
            const given = who.claims[name]
            if (given === undefined) return false
            return [value].flat().some((one) => {
              const prefix = name === 'sub' ? subPrefix(one) : null
              return prefix === null ? given === one : given.startsWith(prefix)
            })
          })
        )
      case 'everyone':
        return admitted
    }
  }

  /** What decides `target` (a channel, or a pattern) for `who`, and what it gives: by `who`'s own limits alone, without everyone's grants, when `own`. */
  function decide(who: Who, target: string, own = false) {
    // Something other than everyone has to let it in: a person's place on the team, or a grant that names it.
    const admitted = (who.kind === 'user' && isMember(who.userId)) || [...grants.values()].some((grant) => grant.principals.some((principal) => principal.kind !== 'everyone' && names(principal, who, false)))
    const nothing = { pattern: null, over: [] as string[], level: null, grants: [] as Grant[], capped: null as string | null, can: [] as Permission[] }
    if (!admitted) return nothing
    const candidates: { grant: Grant; level: Level; pattern: string }[] = []
    for (const grant of grants.values()) {
      const levels = grant.principals.filter((principal) => !(own && principal.kind === 'everyone') && names(principal, who, true)).map(levelOf)
      if (levels.length === 0) continue
      const level = levels.sort((a, b) => LEVEL[a] - LEVEL[b])[0]!
      for (const pattern of Object.keys(grant.can)) if (covers(pattern, target)) candidates.push({ grant, level, pattern })
    }
    if (candidates.length === 0) return nothing
    const [pattern, ...over] = [...new Set(candidates.map((candidate) => candidate.pattern))].sort((a, b) => specificity(b) - specificity(a)) as [string, ...string[]]
    const at = candidates.filter((candidate) => candidate.pattern === pattern)
    const level = at.map((candidate) => candidate.level).sort((a, b) => LEVEL[a] - LEVEL[b])[0]!
    const deciding = at.filter((candidate) => candidate.level === level)
    const given = new Set<Permission>()
    for (const { grant } of deciding) for (const permission of expand(grant.can[pattern]!)) given.add(permission)
    // A narrowed caller gets what its limit says at its closest pattern, and no more.
    const limited = who.limit && Object.keys(who.limit).filter((spot) => covers(spot, target)).sort((a, b) => specificity(b) - specificity(a))[0]
    const limit = who.limit ? (limited === undefined ? new Set<Permission>() : expand(who.limit[limited]!)) : null
    let can = PERMISSIONS.filter((permission) => given.has(permission) && (limit === null || limit.has(permission)))
    let capped: string | null = null
    // A viewer only reads and reacts, whatever a grant says.
    const VIEWER: readonly Permission[] = ['read', 'react']
    if (who.kind === 'user' && options.roles[who.userId] === 'viewer' && can.some((permission) => !VIEWER.includes(permission))) {
      can = can.filter((permission) => VIEWER.includes(permission))
      capped = 'viewer'
    }
    return { pattern, over, level, grants: deciding.map((candidate) => candidate.grant), capped, can }
  }

  // A narrowed caller is held to its limit, an owner too.
  const isOwner = (who: Who) => who.kind === 'user' && options.roles[who.userId] === 'owner' && who.limit === undefined
  /** Whether `who` may list the grants, or explain anyone: manage at `*`, or a team owner. */
  const lists = (who: Who) => isOwner(who) || decide(who, '*').can.includes('manage')
  /** What `everyone` gives at `spot`, by the grants in `after` that name it: what anyone a grant lets in gets there, where nothing closer decides. */
  function everyoneAt(after: readonly Grant[], spot: string): Set<Permission> {
    const covering = after.filter((grant) => grant.principals.some((principal) => principal.kind === 'everyone')).flatMap((grant) => Object.keys(grant.can).filter((pattern) => covers(pattern, spot)).map((pattern) => ({ grant, pattern })))
    const best = Math.max(...covering.map(({ pattern }) => specificity(pattern)))
    const given = new Set<Permission>()
    for (const { grant, pattern } of covering) if (specificity(pattern) === best) for (const permission of expand(grant.can[pattern]!)) given.add(permission)
    return given
  }
  /**
   * A 403 unless `who` may make or widen a grant to `patterns`, judged by the grants as they'd be
   * after it (`after`), as the board's `checkGrantChange` does. Reach: manage at each pattern, with
   * everyone's grants and without, and at every spot under it by `who`'s own limits, without them.
   * Admission: whatever `everyone` gives anywhere, `who` has too, since anyone a grant lets in gets
   * it. A team owner always may.
   */
  function mayGrant(who: Who, patterns: Iterable<string>, after: readonly Grant[], what: string) {
    if (isOwner(who)) return
    // Its own limits' patterns are spots too: its x-board-can, and the grants that name it.
    const spots = [...grants.values()].filter((grant) => grant.principals.some((principal) => names(principal, who, true))).flatMap((grant) => Object.keys(grant.can)).concat(Object.keys(who.limit ?? {}))
    const everyone = after.filter((grant) => grant.principals.some((principal) => principal.kind === 'everyone')).flatMap((grant) => Object.keys(grant.can))
    const manages = (spot: string, own = false) => decide(who, spot, own).can.includes('manage')
    for (const pattern of patterns) {
      if (!manages(pattern) || !manages(pattern, true) || [...spots, ...everyone].some((spot) => spot !== pattern && covers(pattern, spot) && !manages(spot, true)))
        throw new GrantRefused(403, 'grant_forbidden', `${what} takes manage wherever the grant reaches`)
    }
    for (const spot of new Set([...everyone, ...spots])) {
      const has = new Set(decide(who, spot).can)
      if ([...everyoneAt(after, spot)].some((permission) => !has.has(permission))) throw new GrantRefused(403, 'grant_forbidden', `${what} would let someone in where everyone gets more than you have`)
    }
  }
  /** A 403 unless `who` manages each of `patterns`: what revoking a grant, or removing from one, takes. */
  function mayManage(who: Who, patterns: Iterable<string>, what: string) {
    if (isOwner(who)) return
    for (const pattern of patterns) if (!decide(who, pattern).can.includes('manage')) throw new GrantRefused(403, 'grant_forbidden', `${what} takes manage wherever the grant applies`)
  }
  /**
   * Makes `change`, and takes it back with a 409 when it leaves `who` without manage at one of
   * `patterns`, where it had it: a change `who` couldn't undo. Nothing locks a team owner out, and
   * `lockMeOut` says to go ahead.
   */
  function unlessLockedOut<T>(who: Who, patterns: Iterable<string>, lockMeOut: unknown, what: string, change: () => T): T {
    const before = { grants: [...grants.values()].map((grant) => structuredClone(grant)), next }
    const made = change()
    if (isOwner(who) || lockMeOut === true) return made
    const lost = [...patterns].find((pattern) => !decide(who, pattern).can.includes('manage') || !decide(who, pattern, true).can.includes('manage'))
    if (lost === undefined) return made
    grants.clear()
    for (const grant of before.grants) grants.set(grant.id, grant)
    next = before.next
    throw new GrantRefused(409, 'grant_lockout', `${what} would leave you unable to manage grants in ${lost}`)
  }
  function mayList(who: Who, what: string) {
    if (!lists(who)) throw new GrantRefused(403, 'grant_forbidden', `${what} takes manage at *`)
  }
  /** Naming an issuer makes the API fetch its keys: it takes manage everywhere. */
  const namesIssuer = (principals: readonly Stored[]) => principals.some((principal) => principal.kind === 'oidc')

  function viewOf(grant: Grant) {
    return {
      id: grant.id,
      principals: grant.principals.map((principal) => {
        if (principal.kind === 'user') return { ...principal, email: options.members[principal.userId] ?? null }
        // The API keeps the team a project was on, and matches its tokens only while they're that team's.
        if (principal.kind === 'project') return { kind: 'project', projectId: principal.projectId, name: options.projects[principal.projectId] ?? null, environments: principal.environments, teamId: options.teamId }
        if (principal.kind === 'app') return { kind: 'app', clientId: principal.clientId, name: options.apps[principal.clientId] ?? null }
        return principal
      }),
      can: grant.can,
      // The team's roles cap what it gives a person.
      capped: grant.principals.some((principal) => principal.kind === 'user' || principal.kind === 'all-users'),
      by: grant.by,
      at: grant.at,
    }
  }

  /** Whom an explain query names, by what people type: an email or user ID, a project's name or ID, a repository. */
  function named(url: URL): Who | null {
    const query = (name: string) => url.searchParams.get(name) ?? undefined
    const user = query('user')
    if (user !== undefined) {
      const userId = user in options.members ? user : Object.keys(options.members).find((id) => options.members[id] === user)
      if (!userId) throw new GrantRefused(400, 'user_not_found', `no one on the team is ${user}`)
      return { kind: 'user', userId }
    }
    const project = query('project')
    if (project !== undefined) {
      const projectId = project in options.projects ? project : Object.keys(options.projects).find((id) => options.projects[id] === project)
      if (!projectId) throw new GrantRefused(400, 'project_not_found', `no project ${project} on the team`)
      return { kind: 'project', projectId, environment: query('environment') ?? 'production' }
    }
    const app = query('app')
    if (app !== undefined) {
      const clientId = app in options.apps ? app : Object.keys(options.apps).find((id) => options.apps[id] === app)
      if (!clientId) throw new GrantRefused(400, 'app_not_found', `no app ${app} on the team`)
      return { kind: 'app', clientId }
    }
    const repository = query('github')
    if (repository !== undefined) {
      const repositoryId = options.repositories[repository]
      if (!repositoryId) throw new GrantRefused(400, 'repository_not_found', `no GitHub repository ${repository}`)
      const workflow = query('workflow')
      const branch = query('branch')
      const event = query('event')
      return {
        kind: 'github',
        repositoryId,
        repository,
        // A run on main unless the query says.
        ...(workflow ? { workflowRef: `${repository}/${workflowPath(workflow)}@refs/heads/${branch ?? 'main'}` } : {}),
        ref: `refs/heads/${branch ?? 'main'}`,
        ...(event ? { event } : {}),
      }
    }
    const issuer = query('oidc')
    if (issuer !== undefined) return { kind: 'oidc', issuer, claims: Object.fromEntries(url.searchParams.getAll('claim').map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])) }
    return null
  }

  const patternsOf = (can: Can) => Object.keys(can)

  return {
    grants,
    /**
     * `can`, what a credential may do as `GET /me` says, within what the grants give `who`: at
     * each pattern either names, or `who`'s limit does, what both allow there. A board's `/me`.
     */
    within(who: Who, can: Record<string, string[]>): Record<string, string[]> {
      const patterns = new Set(['*', ...Object.keys(can), ...[...grants.values()].flatMap((grant) => Object.keys(grant.can)), ...Object.keys(who.limit ?? {})])
      const own = (target: string) => Object.keys(can).filter((pattern) => covers(pattern, target)).sort((a, b) => specificity(b) - specificity(a))[0]
      return Object.fromEntries(
        [...patterns].map((pattern) => {
          const said = own(pattern)
          const given: readonly string[] = decide(who, pattern).can
          return [pattern, said === undefined ? [] : can[said]!.filter((permission) => given.includes(permission))]
        }),
      )
    },
    /** The grants routes, under `/boards/:id`: undefined for any other. */
    route(method: string, rest: string, who: Who, by: string, body: Record<string, any>, url: URL): unknown {
      let found: RegExpExecArray | null
      if (method === 'GET' && rest === '/grants') {
        mayList(who, 'listing grants')
        return { grants: [...grants.values()].map(viewOf) }
      }
      if (method === 'POST' && rest === '/grants') {
        if (!Array.isArray(body.principals) || body.principals.length === 0) throw invalid('a grant names its principals')
        const principals = body.principals.map((input: Record<string, any>) => resolve(input))
        const can = checkCan(body.can)
        const after = [...grants.values(), { id: '', principals, can, by, at: 0 }]
        mayGrant(who, patternsOf(can), after, 'granting')
        if (namesIssuer(principals)) mayGrant(who, ['*'], after, 'naming an oidc issuer')
        return { grant: viewOf(unlessLockedOut(who, patternsOf(can), body.lockMeOut, 'this grant', () => add(principals, can, by))) }
      }
      if (method === 'POST' && rest === '/grants/batch') {
        if (!Array.isArray(body.grants) || body.grants.length === 0 || body.grants.length > 16) throw invalid('a batch makes 1 to 16 grants')
        const made: { principals: Stored[]; can: Can }[] = body.grants.map((input: Record<string, any>) => {
          if (!Array.isArray(input.principals) || input.principals.length === 0) throw invalid('a grant names its principals')
          return { principals: input.principals.map((principal: Record<string, any>) => resolve(principal)), can: checkCan(input.can) }
        })
        // Each by the grants as they are, and what everyone gets with all of them made: all, or none.
        const after = [...grants.values(), ...made.map((grant) => ({ id: '', ...grant, by, at: 0 }))]
        for (const grant of made) {
          mayGrant(who, patternsOf(grant.can), after, 'granting')
          if (namesIssuer(grant.principals)) mayGrant(who, ['*'], after, 'naming an oidc issuer')
        }
        const patterns = made.flatMap((grant) => patternsOf(grant.can))
        return { grants: unlessLockedOut(who, patterns, body.lockMeOut, 'these grants', () => made.map((grant) => add(grant.principals, grant.can, by))).map(viewOf) }
      }
      if (method === 'GET' && rest === '/grants/explain') {
        const channel = url.searchParams.get('channel')
        if (!channel) throw new GrantRefused(400, 'invalid_request', 'explain takes a channel')
        const other = named(url)
        if (other) mayList(who, 'explaining what someone else may do')
        const decided = decide(other ?? who, channel)
        const shown = lists(who) ? decided.grants : []
        return { channel, pattern: decided.pattern, over: decided.over, level: decided.level, grants: shown.map(viewOf), rule: null, capped: decided.capped, can: decided.can }
      }
      if ((found = /^\/grants\/([^/]+)$/.exec(rest)) && method === 'PATCH') {
        const grant = grants.get(decodeURIComponent(found[1]!))
        if (!grant) throw new GrantRefused(404, 'grant_not_found')
        mayManage(who, patternsOf(grant.can), `updating ${grant.id}`)
        let principals = [...grant.principals]
        for (const input of body.remove ?? []) {
          const removal = resolve(input, true)
          const kept = principals.filter((principal) => !removes(removal, principal))
          if (kept.length === principals.length) throw new GrantRefused(400, 'not_in_grant', `${grant.id} doesn't name that ${removal.kind} principal`)
          principals = kept
        }
        for (const input of body.add ?? []) {
          const added = resolve(input)
          // One it names already gets the new environments: an add never narrows.
          const at = principals.findIndex((principal) => principal.kind === added.kind && (added.kind === 'project' ? (principal as typeof added).projectId === added.projectId : added.kind === 'all-projects' || sameKey(principal, added)))
          const found = principals[at]
          if (!found) principals.push(added)
          else if ('environments' in found && 'environments' in added) principals[at] = { ...found, environments: [...new Set([...found.environments, ...added.environments])] }
        }
        if (principals.length === 0) throw new GrantRefused(400, 'grant_empty', `that leaves ${grant.id} naming no one`)
        const can = body.can === undefined ? grant.can : checkCan(body.can)
        // Adding or setting can widens it; removing only narrows, which manage there allows.
        if (body.add !== undefined || body.can !== undefined) {
          const after = [...[...grants.values()].filter((other) => other.id !== grant.id), { ...grant, principals, can }]
          mayGrant(who, patternsOf(can), after, `updating ${grant.id}`)
          if (namesIssuer(principals.filter((principal) => !grant.principals.includes(principal)))) mayGrant(who, ['*'], after, 'naming an oidc issuer')
        }
        const touched = new Set([...patternsOf(grant.can), ...patternsOf(can)])
        return { grant: viewOf(unlessLockedOut(who, touched, body.lockMeOut, `updating ${grant.id}`, () => Object.assign(grant, { principals, can, by, at: Date.now() }))) }
      }
      if ((found = /^\/grants\/([^/]+)\/revoke$/.exec(rest)) && method === 'POST') {
        const grant = grants.get(decodeURIComponent(found[1]!))
        if (!grant) {
          mayList(who, 'revoking grants')
          return { revoked: false }
        }
        mayManage(who, patternsOf(grant.can), `revoking ${grant.id}`)
        unlessLockedOut(who, patternsOf(grant.can), body.lockMeOut, `revoking ${grant.id}`, () => grants.delete(grant.id))
        return { revoked: true }
      }
      return undefined
    },
  }
}
