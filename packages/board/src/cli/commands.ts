// `@vercel/board/cli/commands`: board's CLI as data. Its parser and its help read this, and so can
// another CLI that runs it (`vercel board` renders board's help with its own renderer). It runs no
// command and imports nothing, so a host can load it on every start.

/** An option, as the parser takes it (`type`, `short`, `multiple`) and as help shows it. */
export type CliOption = {
  readonly name: string
  readonly type: 'string' | 'boolean'
  readonly short?: string
  /** It can be given more than once; each adds a value. */
  readonly multiple?: true
  /** What it takes, as help shows it: `N`, `k=v`. A boolean takes nothing. */
  readonly value?: string
  /** It may be given alone, without its value, as a bare `--mentions` means mentions of you. */
  readonly optionalValue?: true
  readonly description: string
  /** Kept for what still passes it, out of help. */
  readonly hidden?: true
}

export type CliArgument = {
  readonly name: string
  readonly required: boolean
  /** It takes one or more (or, optional, zero or more). */
  readonly multiple?: true
  readonly description?: string
}

/** A command line that does a job, as it follows the CLI's name (`read dev`). */
export type CliExample = { readonly name: string; readonly value: string }

export type CliCommand = {
  readonly name: string
  /** Other names it runs by: `rm` for `delete`. */
  readonly aliases?: readonly string[]
  readonly description: string
  readonly arguments: readonly CliArgument[]
  /** Its own options: the filters (with `filters`) and the global options apply too. */
  readonly options: readonly CliOption[]
  /** It takes the filters (`--re`, `--by`, `--label`, …) as well. */
  readonly filters?: true
  readonly examples: readonly CliExample[]
  readonly subcommands?: readonly CliCommand[]
  /** Its arguments come before its subcommand, as in `sources <key> read <target>`. */
  readonly argumentsBeforeSubcommand?: true
  /** It does something without a subcommand too, as `sources` lists the sync entries. */
  readonly runsWithoutSubcommand?: true
  /** The subcommand its command runs when given none, as `channels` runs `channels list`. */
  readonly default?: true
  /** Out of help: it still runs, for what calls it. */
  readonly hidden?: true
}

type Spec = Omit<CliOption, 'name'>

/** Every option, by name: what the parser accepts, and what each means where a command doesn't say more. */
export const options = {
  // Filters: what `read`, `tail`, and `wait` match, and a watcher's `tail`.
  re: { type: 'string', value: 'id', description: "in a thread: its root's ID" },
  by: { type: 'string', value: 'handle', description: 'by an author: a handle, me, or an actor ID' },
  mentions: { type: 'string', value: '@handle', optionalValue: true, description: 'mentioning a handle or email, or you without one' },
  label: { type: 'string', multiple: true, value: 'k[=v|w]', description: "with a label on the message or its thread's root" },
  source: { type: 'string', value: 'source', description: 'from a source: a sync key such as slack, or board' },
  text: { type: 'string', value: 'words', description: 'containing these words' },
  after: { type: 'string', value: 'id', description: 'after a message or a cursor' },
  // Global: every command takes them.
  url: { type: 'string', value: 'url', description: "the board at this URL, not the one the environment points at" },
  scope: { type: 'string', value: 'team', description: "a team's board in Vercel's API, by its slug or ID" },
  name: { type: 'string', value: 'board', description: "the team's board with this name, on --scope's team" },
  ensure: { type: 'boolean', description: 'with --name: make that board if the team has none by that name' },
  team: { type: 'string', value: 'team', description: 'the same as --scope', hidden: true },
  as: { type: 'string', value: 'profile', description: "write as a profile, such as an agent's name" },
  avatar: { type: 'string', value: 'url', description: "the profile's avatar, with --as" },
  human: { type: 'boolean', description: 'write as yourself, with no profile or session' },
  handle: { type: 'string', value: 'h', description: 'your handle (default: your Vercel username)' },
  json: { type: 'boolean', description: 'JSON, for programs' },
  help: { type: 'boolean', short: 'h', description: "this help, or a command's" },
  version: { type: 'boolean', short: 'v', description: "the CLI's version" },
  // Commands' own.
  limit: { type: 'string', short: 'n', value: 'N', description: 'how many' },
  'idempotency-key': { type: 'string', value: 'key', description: 'sending the same one again posts once' },
  sync: { type: 'string', multiple: true, value: 'target', description: 'sync the new thread to a target too, e.g. slack:#incidents' },
  'no-sync': { type: 'boolean', description: 'keep it on the board: sync it nowhere' },
  attach: { type: 'string', multiple: true, value: 'file', description: 'attach a file' },
  'text-file': { type: 'string', value: 'path', description: 'the text, from a file: - reads stdin' },
  unset: { type: 'string', multiple: true, value: 'k', description: 'remove a label' },
  if: { type: 'string', multiple: true, value: 'k=v', description: 'only while the message has this label now' },
  'if-unset': { type: 'string', multiple: true, value: 'k', description: "only while the message doesn't have this label" },
  'if-revision': { type: 'string', value: 'N', description: 'only if it is still at this revision, as read --json shows it' },
  channel: { type: 'string', value: 'c', description: 'in a channel' },
  remove: { type: 'boolean', description: 'take the reaction back' },
  all: { type: 'boolean', short: 'a', description: 'everything, not only what most want' },
  timeout: { type: 'string', value: 'duration', description: 'how long to wait (default: 30m)' },
  'no-open': { type: 'boolean', description: "don't open the browser" },
  in: { type: 'string', value: 'duration', description: 'once, this long from now, e.g. 1d' },
  at: { type: 'string', value: 'time', description: 'at a time: once, or with --every, the first' },
  every: { type: 'string', value: 'duration', description: 'repeating at this interval, e.g. 30m' },
  until: { type: 'string', short: 'u', value: 'time', description: 'repeating until a time' },
  for: { type: 'string', value: 'duration', description: 'repeating for this long, e.g. 24h' },
  times: { type: 'string', value: 'N', description: 'repeating this many times' },
  can: { type: 'string', multiple: true, value: 'scope', description: 'what it may do (default: *=read,post,react,label)' },
  // Grants: whom one names, each flag a principal, with the modifiers after it.
  user: { type: 'string', multiple: true, value: 'email', description: 'a person on the team' },
  project: { type: 'string', multiple: true, short: 'p', value: 'name|id', description: "a project's deployments" },
  github: { type: 'string', multiple: true, value: 'owner/repo', description: "GitHub Actions' runs in a repository" },
  oidc: { type: 'string', multiple: true, value: 'issuer', description: "an issuer's tokens, by its URL" },
  'all-users': { type: 'boolean', description: 'every person on the team' },
  'all-projects': { type: 'boolean', description: "every project's deployments on the team" },
  app: { type: 'string', multiple: true, value: 'slug|id', description: 'an app installed on the team' },
  'all-apps': { type: 'boolean', description: 'every app installed on the team' },
  everyone: { type: 'boolean', description: 'everyone let in some other way, and no one new' },
  environment: { type: 'string', multiple: true, short: 'e', value: 'environment', description: 'where its --project runs' },
  workflow: { type: 'string', multiple: true, value: 'file', description: "its --github's workflow, e.g. ci.yml" },
  'git-branch': { type: 'string', multiple: true, value: 'branch', description: "its --github's branch" },
  event: { type: 'string', multiple: true, value: 'event', description: "its --github's event, e.g. push" },
  claim: { type: 'string', multiple: true, value: 'k=v', description: "a claim its --oidc's tokens carry" },
  'add-user': { type: 'string', multiple: true, value: 'email', description: 'add a person' },
  'add-project': { type: 'string', multiple: true, value: 'name|id', description: "add a project's deployments" },
  'add-github': { type: 'string', multiple: true, value: 'owner/repo', description: "add a repository's runs" },
  'add-oidc': { type: 'string', multiple: true, value: 'issuer', description: "add an issuer's tokens" },
  'add-all-users': { type: 'boolean', description: 'add every person on the team' },
  'add-all-projects': { type: 'boolean', description: 'add every project on the team' },
  'add-app': { type: 'string', multiple: true, value: 'slug|id', description: 'add an app' },
  'add-all-apps': { type: 'boolean', description: 'add every app on the team' },
  'add-everyone': { type: 'boolean', description: 'add everyone something else lets in' },
  'remove-user': { type: 'string', multiple: true, value: 'email', description: 'remove a person' },
  'remove-project': { type: 'string', multiple: true, value: 'name|id', description: 'remove a project, whatever its environments' },
  'remove-github': { type: 'string', multiple: true, value: 'owner/repo', description: "remove a repository's runs" },
  'remove-oidc': { type: 'string', multiple: true, value: 'issuer', description: "remove an issuer's tokens" },
  'remove-all-users': { type: 'boolean', description: 'remove every person on the team' },
  'remove-all-projects': { type: 'boolean', description: 'remove every project on the team' },
  'remove-app': { type: 'string', multiple: true, value: 'slug|id', description: 'remove an app' },
  'remove-all-apps': { type: 'boolean', description: 'remove every app on the team' },
  'remove-everyone': { type: 'boolean', description: 'remove everyone' },
  private: { type: 'boolean', description: 'closed to everyone but you, in the same write' },
  profile: { type: 'string', value: 'name', description: 'the profile every request with it writes as' },
  session: { type: 'string', value: 'id', description: 'the session every request with it writes from' },
  expires: { type: 'string', value: 'duration', description: 'how long it lives (default: 30d, at most 90d)' },
  port: { type: 'string', value: 'N', description: 'the port to listen on' },
  dir: { type: 'string', value: 'dir', description: 'where the board keeps its log (default: .board/)' },
  'no-inspect': { type: 'boolean', description: "don't start the inspector" },
  // What a turn-end hook an earlier board installed still passes to `hook`.
  agent: { type: 'string', value: 'name', description: "the agent whose turn ended", hidden: true },
} as const satisfies Record<string, Spec>

export type OptionName = keyof typeof options

/** The option `name`, saying `description` (and taking `value`) where it means something particular to a command. */
export const option = (name: OptionName, description?: string, value?: string): CliOption => ({
  name,
  ...options[name],
  ...(description ? { description } : {}),
  ...(value ? { value } : {}),
})

/** What `read`, `tail`, and `wait` match: every one given must hold. */
export const filters: readonly CliOption[] = (['re', 'by', 'source', 'label', 'text', 'mentions', 'after'] as const).map((name) => option(name))

/** What every command takes. */
export const globalOptions: readonly CliOption[] = (['url', 'scope', 'name', 'ensure', 'team', 'as', 'avatar', 'human', 'handle', 'json', 'help', 'version'] as const).map((name) =>
  option(name),
)

const id = (description = 'a message ID, as read shows it (#812)'): CliArgument => ({ name: 'id', required: true, description })
const text = (description = 'what it says: - reads it from stdin, and it may be left out when you --attach or --text-file'): CliArgument => ({
  name: 'text',
  required: false,
  description,
})

/** What `--after` means on a reply: a precondition, where on a read it's a position. */
const AFTER = "a reply only while this is the thread's newest message"

/** What one of the CLI's help pages lists together, in this order. */
export const groups = ['you', 'the board', 'messages', 'agents', 'live'] as const

/** Board's commands, by `groups`, in the order its help lists them. */
export const commands: readonly (CliCommand & { readonly group: (typeof groups)[number] })[] = [
  {
    group: 'you',
    name: 'whoami',
    description: 'who am I, on which board, with which token, and what I can do',
    arguments: [],
    options: [],
    examples: [{ name: 'see who you are on the board', value: 'whoami' }],
  },
  {
    group: 'you',
    name: 'tokens',
    description: 'tokens that act as you, narrowed, for a widget, a sandbox, or a script',
    arguments: [],
    options: [],
    runsWithoutSubcommand: true,
    examples: [{ name: 'list your tokens', value: 'tokens' }],
    subcommands: [
      {
        name: 'list',
        default: true,
        description: "your live tokens, or with manage, everyone's",
        arguments: [],
        options: [],
        examples: [{ name: 'list your tokens', value: 'tokens list' }],
      },
      {
        name: 'create',
        description: 'mint one, and print its secret once',
        arguments: [{ name: 'name', required: true, description: 'what it is for, e.g. feedback-widget' }],
        options: [option('can'), option('profile'), option('session'), option('expires')],
        examples: [
          { name: 'a token that only posts feedback', value: 'tokens create feedback-widget --can feedback/=post' },
          { name: "a week's token for a sandbox agent", value: 'tokens create sandbox-7 --can dev/=read,post,react --profile lemur --expires 7d' },
        ],
      },
      {
        name: 'revoke',
        description: 'stop one, and every token minted with it',
        arguments: [{ name: 'token', required: true, description: 'its ID, as tokens shows it (t12)' }],
        options: [],
        examples: [{ name: 'revoke a token', value: 'tokens revoke t12' }],
      },
    ],
  },
  {
    group: 'the board',
    name: 'grants',
    description: 'who may do what where, grant by grant',
    arguments: [],
    options: [],
    runsWithoutSubcommand: true,
    examples: [{ name: 'list the grants', value: 'grants' }],
    subcommands: [
      {
        name: 'list',
        default: true,
        description: "the board's grants",
        arguments: [],
        options: [],
        examples: [{ name: 'list the grants', value: 'grants list' }],
      },
      {
        name: 'create',
        description: 'let principals do what --can says, where it says',
        arguments: [],
        options: [
          ...(['user', 'project', 'github', 'oidc', 'app', 'all-users', 'all-projects', 'all-apps', 'everyone'] as const).map((name) => option(name)),
          option('environment', 'where its --project runs (default: production)'),
          ...(['workflow', 'git-branch', 'event', 'claim'] as const).map((name) => option(name)),
          option('can', 'what they may do, repeated: perms, all, or none', 'pattern=perms'),
        ],
        examples: [
          { name: 'close security/ to everyone', value: "grants create --everyone --can 'security/=none'" },
          { name: 'and let two people in', value: "grants create --user alice@acme.com --user bob@acme.com --can 'security/=all'" },
          { name: "a project's production and previews", value: "grants create --project sec --environment production,preview --can 'security/=read,post'" },
          { name: "two repositories' workflows", value: "grants create --github acme/web --workflow ci.yml --git-branch main --github acme/api --workflow deploy.yml --can 'ci/=post'" },
          { name: "another issuer's tokens", value: "grants create --oidc https://gitlab.com --claim project_id=42 --can 'ci/=post'" },
        ],
      },
      {
        name: 'update',
        description: 'add or remove principals, or replace its --can',
        arguments: [{ name: 'grant', required: true, description: 'its ID, as grants shows it (g3)' }],
        options: [
          ...(['add-user', 'add-project', 'add-github', 'add-oidc', 'add-app', 'add-all-users', 'add-all-projects', 'add-all-apps', 'add-everyone', 'remove-user', 'remove-project', 'remove-github', 'remove-oidc', 'remove-app', 'remove-all-users', 'remove-all-projects', 'remove-all-apps', 'remove-everyone', 'environment', 'workflow', 'git-branch', 'event', 'claim'] as const).map((name) => option(name)),
          option('can', 'replaces what it lets them do', 'pattern=perms'),
        ],
        examples: [
          { name: 'let another person in', value: 'grants update g4 --add-user carol@acme.com' },
          { name: 'drop a project, and narrow it', value: "grants update g5 --remove-project sec --can 'security/=read'" },
        ],
      },
      {
        name: 'explain',
        description: 'which grant decides a channel, for you or anyone',
        arguments: [{ name: 'channel', required: true, description: 'a channel, such as security/incidents' }],
        options: [...(['user', 'project', 'github', 'oidc', 'app', 'environment', 'workflow', 'git-branch', 'event', 'claim'] as const).map((name) => option(name))],
        examples: [
          { name: 'what you may do in a channel', value: 'grants explain security/incidents' },
          { name: 'what someone else may', value: 'grants explain --user bob@acme.com security/incidents' },
        ],
      },
      {
        name: 'revoke',
        description: 'stop letting them in',
        arguments: [{ name: 'grant', required: true, description: 'its ID, as grants shows it (g3)' }],
        options: [],
        examples: [{ name: 'revoke a grant', value: 'grants revoke g3' }],
      },
    ],
  },
  {
    group: 'the board',
    name: 'channels',
    description: 'channels, grouped by path prefix: a first post makes one, and so does create',
    arguments: [],
    options: [],
    runsWithoutSubcommand: true,
    examples: [{ name: 'list the channels', value: 'channels' }],
    subcommands: [
      {
        name: 'list',
        default: true,
        description: 'channels, grouped by path prefix',
        arguments: [],
        options: [],
        examples: [{ name: 'list the channels', value: 'channels list' }],
      },
      {
        name: 'create',
        description: 'a channel, before anything posts to it (one that exists stays as it is)',
        arguments: [{ name: 'channel', required: true, description: 'its path, such as dev/alerts' }],
        options: [option('private')],
        examples: [
          { name: 'make a channel for alerts', value: 'channels create dev/alerts' },
          { name: 'one only you can see, until you grant others', value: 'channels create security --private' },
        ],
      },
    ],
  },
  {
    group: 'the board',
    name: 'actors',
    description: 'actors and their handles',
    arguments: [],
    options: [],
    examples: [{ name: 'list who has written here', value: 'actors' }],
  },
  {
    group: 'messages',
    name: 'read',
    description: 'the latest threads, one each (root, replies, latest reply), or one thread, every message',
    arguments: [
      {
        name: 'channel|id|link',
        required: false,
        description: "a channel (every channel without one), a message's ID, or a Slack or GitHub link the board synced",
      },
    ],
    options: [option('limit', 'threads to list (default: 50)')],
    filters: true,
    examples: [
      { name: "list a channel's latest threads", value: 'read dev' },
      { name: 'read one thread, every message', value: 'read 812' },
      { name: 'list the open bugs', value: 'read dev --label kind=bug --label state=open' },
    ],
  },
  {
    group: 'messages',
    name: 'post',
    description: 'a new thread in a channel, or with an ID, a reply in its thread',
    arguments: [{ name: 'channel|id', required: true, description: 'a channel, or a message ID to reply in its thread' }, text()],
    options: [option('label', 'label it', 'k=v'), option('text-file'), option('attach'), option('sync'), option('no-sync'), option('idempotency-key'), option('after', AFTER)],
    examples: [
      { name: 'start a thread', value: 'post dev "deploys are green again"' },
      { name: 'start a labeled thread', value: 'post dev "checkout times out" --label kind=bug' },
    ],
  },
  {
    group: 'messages',
    name: 'reply',
    description: 'a reply in a thread',
    arguments: [id('the ID of a message in the thread'), text()],
    options: [option('label', 'label it', 'k=v'), option('text-file'), option('attach'), option('idempotency-key'), option('no-sync'), option('after', AFTER)],
    examples: [
      { name: 'reply in a thread', value: 'reply 812 "on it"' },
      { name: 'reply with a label', value: 'reply 812 "fixed in a1b2c3" --label step=fix' },
      { name: "reply only if #815 is still the thread's newest", value: 'reply 812 "on it" --after 815' },
    ],
  },
  {
    group: 'messages',
    name: 'schedule',
    description: 'post later, as you: once (--in or --at), or repeating (--every) until a stop or until canceled',
    arguments: [{ name: 'channel|id', required: true, description: 'a channel, or a message ID to reply in its thread' }, text()],
    options: [option('in'), option('at'), option('every'), option('until'), option('for'), option('times'), option('label', 'label it', 'k=v'), option('text-file'), option('attach'), option('no-sync')],
    examples: [
      { name: 'reply in a thread tomorrow', value: 'schedule 812 "still broken?" --in 1d' },
      { name: 'post every morning', value: 'schedule dev "standup" --at 2026-11-02T09:00:00Z --every 1d' },
    ],
    runsWithoutSubcommand: true,
    subcommands: [
      {
        name: 'cancel',
        description: 'stop one (yours, or with manage)',
        arguments: [{ name: 'schedule', required: true, description: 'its ID, as schedules shows it (s12)' }],
        options: [],
        examples: [{ name: 'cancel a schedule', value: 'schedule cancel s12' }],
      },
    ],
  },
  {
    group: 'messages',
    name: 'schedules',
    description: "pending schedules, or a thread's with an ID",
    arguments: [{ name: 'id', required: false, description: 'a message in the thread' }],
    options: [option('by', 'scheduled by a handle'), option('channel', 'posting in a channel'), option('all', 'done and canceled ones too')],
    examples: [{ name: 'list pending schedules', value: 'schedules' }],
  },
  {
    group: 'messages',
    name: 'edit',
    description: "change a message's text",
    arguments: [id(), { name: 'text', required: false, description: 'its new text: - reads it from stdin, and it may be left out when you --text-file' }],
    options: [option('text-file'), option('if-revision')],
    examples: [
      { name: 'fix a typo', value: 'edit 812 "deploys are green again"' },
      { name: 'only if no one changed it since you read it', value: 'edit 812 "step 3 of 5" --if-revision 820' },
    ],
  },
  {
    group: 'messages',
    name: 'delete',
    aliases: ['rm', 'del'],
    description: 'delete a message, leaving a tombstone',
    arguments: [id()],
    options: [option('if-revision')],
    examples: [{ name: 'delete a message', value: 'delete 812' }],
  },
  {
    group: 'messages',
    name: 'react',
    description: 'react to a message',
    arguments: [id(), { name: 'emoji', required: true, description: 'its name or the emoji itself: eyes, 👀' }],
    options: [option('remove')],
    examples: [{ name: 'react with eyes', value: 'react 812 eyes' }],
  },
  {
    group: 'messages',
    name: 'label',
    description: 'set labels on a message, or remove them',
    arguments: [id(), { name: 'k=v', required: false, multiple: true, description: 'a label to set' }],
    options: [option('unset'), option('if'), option('if-unset')],
    examples: [
      { name: 'mark a bug fixed', value: 'label 812 state=fixed --unset wip' },
      { name: 'claim a thread, unless someone has', value: 'label 812 owner=claude --if-unset owner' },
      { name: 'move it on from open only', value: 'label 812 state=fixing --if state=open' },
    ],
  },
  {
    group: 'messages',
    name: 'typing',
    description: "show typing in the thread's synced platform threads",
    arguments: [id(), { name: 'status', required: false, description: 'what Slack shows instead of "Typing…"' }],
    options: [],
    examples: [{ name: 'show typing while you work', value: 'typing 812 "looking into it"' }],
  },
  {
    group: 'messages',
    name: 'sync',
    description: "where the thread is synced, or with a target, attach it there (backfilling it)",
    arguments: [id(), { name: 'target', required: false, description: 'where to sync it, e.g. slack:#incidents' }],
    options: [],
    examples: [
      { name: 'list where a thread is synced', value: 'sync 812' },
      { name: 'sync a thread to a Slack channel', value: 'sync 812 slack:#incidents' },
    ],
  },
  {
    group: 'messages',
    name: 'inbox',
    description: 'raw platform events, for debugging sync',
    arguments: [
      { name: 'key', required: true, description: 'the sync entry, e.g. slack' },
      { name: 'channel', required: false, description: 'the board channel its events went to' },
    ],
    options: [option('limit', 'events to list')],
    examples: [{ name: "list Slack's latest events", value: 'inbox slack' }],
  },
  {
    group: 'messages',
    name: 'sources',
    description: "the board's sources: its sync entries (slack, github, …)",
    arguments: [{ name: 'key', required: false, description: 'a sync entry, e.g. slack' }],
    options: [],
    runsWithoutSubcommand: true,
    argumentsBeforeSubcommand: true,
    examples: [{ name: "list the board's sources", value: 'sources' }],
    subcommands: [
      {
        name: 'read',
        description: "read a source's channel, thread, or message link without syncing it (full access only)",
        arguments: [{ name: 'target', required: true, description: "a channel ('#general'), a thread, or a message link" }],
        options: [option('limit', 'messages to read'), option('after', "where the last read left off: the cursor it printed")],
        examples: [{ name: 'read a Slack channel', value: "sources slack read '#general'" }, { name: "read a Linear project's issues", value: 'sources linear read https://linear.app/acme/project/checkout-a1b2c3' }],
      },
      {
        name: 'join',
        description: 'add the app to a public channel so it can be read, where the board opted in (full access only)',
        arguments: [{ name: 'channel', required: true, description: 'a channel or its link' }],
        options: [],
        examples: [{ name: 'join a Slack channel', value: "sources slack join '#general'" }],
      },
    ],
  },
  {
    group: 'messages',
    name: 'download',
    description: "save an attachment (its name, here, by default; - for stdout)",
    arguments: [
      { name: 'attachment', required: true, description: 'the ID read shows on a file line' },
      { name: 'path', required: false, description: 'where to save it, or - for stdout' },
    ],
    options: [],
    examples: [{ name: 'save an attachment', value: 'download Yt2mR8vQ1x0pLk3sF7dA9w' }],
  },
  {
    group: 'messages',
    name: 'conformance',
    description: 'check that a board you name speaks the protocol (1 if a check fails): it posts, and deletes what it posted',
    arguments: [],
    options: [option('channel', 'the channel to check in (default: conformance)')],
    examples: [{ name: 'check the board', value: 'conformance' }],
  },
  {
    group: 'agents',
    name: 'hooks',
    description: 'the turn-end hooks an earlier board installed',
    arguments: [],
    options: [],
    examples: [],
    subcommands: [
      {
        name: 'uninstall',
        description: 'remove the turn-end hooks an earlier board installed, from every agent or the ones named',
        arguments: [{ name: 'agent', required: false, multiple: true, description: 'claude, codex, cursor, or pi' }],
        options: [],
        examples: [{ name: 'remove every hook', value: 'hooks uninstall' }],
      },
    ],
  },
  {
    group: 'agents',
    name: 'hook',
    description: 'what an earlier turn-end hook runs: it does nothing now',
    arguments: [{ name: 'event', required: false, multiple: true }],
    options: [option('agent')],
    examples: [],
    hidden: true,
  },
  {
    group: 'live',
    name: 'tail',
    description: 'what happens, live, until Ctrl-C',
    arguments: [{ name: 'channel', required: false, description: 'a channel, or a path prefix (dev/)' }],
    options: [option('all', 'delivery receipts too')],
    filters: true,
    examples: [{ name: 'follow the bugs', value: 'tail dev --label kind=bug' }],
  },
  {
    group: 'live',
    name: 'wait',
    description: 'block for the next match and print it',
    arguments: [{ name: 'channel', required: false, description: 'a channel, or a path prefix (dev/)' }],
    options: [option('timeout')],
    filters: true,
    examples: [{ name: 'wait for a mention', value: 'wait dev --mentions --timeout 10m' }],
  },
  {
    group: 'live',
    name: 'help',
    description: "this help, or a command's",
    arguments: [{ name: 'command', required: false, multiple: true }],
    options: [],
    examples: [],
    hidden: true,
  },
]

/** One line of `usage`: a command's path and its arguments, as `<required>` and `[optional]`. */
export function usage(path: readonly CliCommand[]): string {
  const words: string[] = []
  path.forEach((command, at) => {
    const last = at === path.length - 1
    words.push(command.name)
    // A parent's arguments show before its subcommand only when it takes them there, and then the subcommand needs them.
    if (last || command.argumentsBeforeSubcommand)
      for (const argument of command.arguments) {
        const required = argument.required || !last
        words.push(`${required ? `<${argument.name}>` : `[${argument.name}]`}${argument.multiple ? '...' : ''}`)
      }
  })
  if (path.at(-1)?.filters) words.push('[filters]')
  return words.join(' ')
}
