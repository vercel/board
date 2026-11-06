import { Check, ChevronsUpDown, PanelLeftClose, PanelLeftOpen, RefreshCw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChannelView, InboxEntry, Me, MessageView } from '../../api/routes.ts'
import { who } from '../../cli/format.ts'
import * as board from './board.ts'
import { Composer } from './composer.tsx'
import { Feed, Toasts } from './feed.tsx'
import { Avatar, Messages, Pendings, type RowOptions } from './message.tsx'
import { Ago, here, Link, navigate, useLocation, useNow, useTypeToFocus } from './nav.tsx'
import { FilterButton, FilterChips } from './filters.tsx'
import { byWritten, channelThreads, filtering, knownLabels, matches, recent, thread as threadOf, type Filter, type State } from './store.ts'
import { ContextMenuArea, Menu, MenuItem, MenuSeparator, ResizeHandle, type KnownLabels } from './ui.tsx'

type Route = { view: 'activity' } | { view: 'channel'; channel: string } | { view: 'inbox'; key: string } | { view: 'missing' }

function route(path: string): Route {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return { view: 'missing' }
  }
  if (decoded === '/') return { view: 'activity' }
  if (decoded.startsWith('/c/') && decoded.length > 3) return { view: 'channel', channel: decoded.slice(3) }
  if (decoded.startsWith('/inbox/') && decoded.length > 7) return { view: 'inbox', key: decoded.slice(7) }
  return { view: 'missing' }
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

// --- sizes you drag, remembered -------------------------------------------------------

function stored(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 ? value : fallback
  } catch {
    return fallback
  }
}
function remember(key: string, value: number | string) {
  try {
    localStorage.setItem(key, String(value))
  } catch {}
}

const SIDEBAR = { min: 180, max: 400, collapse: 150, key: 'board.sidebar-width', collapsedKey: 'board.sidebar-collapsed' }
const PANE = { min: 320, key: 'board.pane-width' }

function useSidebar() {
  const [width, setWidth] = useState(() => Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, stored(SIDEBAR.key, 224))))
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR.collapsedKey) === '1'
    } catch {
      return false
    }
  })
  // The release reads the latest position, which may not have rendered yet.
  const [dragging, setDragging] = useState<number | null>(null)
  const latest = useRef<number | null>(null)
  const collapse = (value: boolean) => {
    setCollapsed(value)
    remember(SIDEBAR.collapsedKey, value ? '1' : '0')
  }
  const commit = (next: number) => {
    setWidth(next)
    remember(SIDEBAR.key, next)
  }
  return {
    width: dragging ?? width,
    collapsed,
    collapse,
    /** Dragged under the minimum it fades; let go below the threshold and it collapses. */
    fade: dragging !== null && dragging < SIDEBAR.min ? Math.max(0.25, (dragging - 60) / (SIDEBAR.min - 60)) : 1,
    drag: (x: number) => {
      latest.current = Math.min(SIDEBAR.max, Math.max(60, x))
      setDragging(latest.current)
    },
    done: () => {
      const at = latest.current
      latest.current = null
      setDragging(null)
      if (at === null) return
      if (at < SIDEBAR.collapse) collapse(true)
      else commit(Math.max(SIDEBAR.min, at))
    },
    step: (delta: number) => commit(Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, width + delta))),
  }
}

function usePane() {
  const clamp = (value: number) => Math.min(Math.max(PANE.min, innerWidth * 0.7), Math.max(PANE.min, value))
  const [width, setWidth] = useState(() => stored(PANE.key, 440))
  const [dragging, setDragging] = useState<number | null>(null)
  const latest = useRef<number | null>(null)
  const commit = (next: number) => {
    setWidth(next)
    remember(PANE.key, next)
  }
  return {
    width: clamp(dragging ?? width),
    drag: (x: number) => {
      latest.current = clamp(innerWidth - x)
      setDragging(latest.current)
    },
    done: () => {
      const at = latest.current
      latest.current = null
      setDragging(null)
      if (at !== null) commit(at)
    },
    step: (delta: number) => commit(clamp(width - delta)),
  }
}

// --- the app -----------------------------------------------------------------------

export function App() {
  const state = board.useBoard()
  const where = useLocation()
  const now = useNow()
  const [failed, setFailed] = useState<string | null>(null)
  const sidebar = useSidebar()
  const pane = usePane()

  useEffect(() => {
    board.boot().catch((error: Error) => setFailed(error.message))
  }, [])

  // Old links: /t/12 is the thread pane over the activity view.
  useEffect(() => {
    const old = /^\/t\/(\d+)$/.exec(where.path)
    if (old) navigate(`/?thread=${old[1]}`, true)
  }, [where.path])

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || where.thread === null) return
      if ((event.target as HTMLElement).closest('textarea, input, [role="menu"], [role="dialog"]')) return
      navigate(here({ thread: null }))
    }
    addEventListener('keydown', close)
    return () => removeEventListener('keydown', close)
  }, [where])

  const current = route(where.path)
  useEffect(() => {
    document.title = `${current.view === 'channel' ? `#${current.channel}` : current.view === 'inbox' ? `inbox · ${current.key}` : 'activity'} · board`
  }, [where.path])

  const known = useMemo(() => knownLabels(state), [state.messages])

  if (failed) return <div className="boot error">error: {failed}</div>
  if (!state.me) return <div className="boot">connecting…</div>

  const platforms = Object.fromEntries((state.discovery?.sync ?? []).map((entry) => [entry.key, entry.platform]))
  const options: RowOptions = { me: state.me.actor, now, known, platforms, openThread: (id) => navigate(here({ thread: id })) }
  const filter = where.filter
  const setFilter = (next: Filter) => navigate(here({ filter: next }), true)
  const sources = (state.discovery?.sync ?? []).map((entry) => entry.key)
  const filters = { filter, setFilter, sources, known }
  const expand = sidebar.collapsed ? (
    <button className="tool" title="show the sidebar" onClick={() => sidebar.collapse(false)}>
      <PanelLeftOpen size={15} strokeWidth={1.75} />
    </button>
  ) : null
  return (
    <div className="shell">
      {!sidebar.collapsed && (
        <nav className="sidebar" style={{ width: sidebar.width, opacity: sidebar.fade }}>
          <Sidebar state={state} current={current} onCollapse={() => sidebar.collapse(true)} />
          <ResizeHandle side="right" label="resize the sidebar" onDrag={sidebar.drag} onDone={sidebar.done} onStep={sidebar.step} />
        </nav>
      )}
      <main className="main">
        {current.view === 'activity' && <Activity state={state} options={options} known={known} lead={expand} filters={filters} />}
        {current.view === 'channel' && (
          <Channel key={current.channel} channel={current.channel} state={state} options={options} known={known} lead={expand} filters={filters} />
        )}
        {current.view === 'inbox' && <Inbox key={current.key} entry={current.key} now={now} lead={expand} />}
        {current.view === 'missing' && (
          <>
            <Header title="nothing here" lead={expand} />
            <p className="empty">no such page</p>
          </>
        )}
      </main>
      {where.thread !== null && (
        <aside className="pane" style={{ width: pane.width }}>
          <ResizeHandle side="left" label="resize the thread" onDrag={pane.drag} onDone={pane.done} onStep={pane.step} />
          <ThreadPane key={where.thread} id={where.thread} state={state} now={now} known={known} />
        </aside>
      )}
      <Toasts />
    </div>
  )
}

function Header(props: { title: string; meta?: string; live?: State['live']; lead?: ReactNode; children?: ReactNode }) {
  return (
    <header className="header">
      {props.lead}
      <span className="title">{props.title}</span>
      {props.meta && <span className="meta">{props.meta}</span>}
      <span className="spacer" />
      {props.children}
      {props.live && (
        <span className={`live ${props.live}`} title={props.live === 'live' ? 'receiving board events' : 'the stream reconnects on its own'}>
          <i />
          {props.live === 'live' ? 'live' : props.live}
        </span>
      )}
    </header>
  )
}

// --- sidebar -------------------------------------------------------------------------

function useSeen(state: State, current: Route): Record<string, number> {
  const storage = `board.seen:${state.discovery?.url ?? location.host}`
  const [seen, setSeen] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(storage) ?? 'null') ?? {}
    } catch {
      return {}
    }
  })
  const save = (next: Record<string, number>) => {
    setSeen(next)
    try {
      localStorage.setItem(storage, JSON.stringify(next))
    } catch {}
  }
  // The first visit marks everything read; after that, dots mean news.
  useEffect(() => {
    const channels = Object.values(state.channels)
    if (Object.keys(seen).length === 0 && channels.length > 0)
      save(Object.fromEntries(channels.map((channel) => [channel.path, channel.lastIndex ?? 0])))
  }, [state.channels])
  useEffect(() => {
    if (current.view !== 'channel') return
    const channel = state.channels[current.channel]
    if (channel?.lastIndex !== undefined && (seen[channel.path] ?? 0) < channel.lastIndex) save({ ...seen, [channel.path]: channel.lastIndex })
  }, [current, state.channels])
  return seen
}

function Sidebar({ state, current, onCollapse }: { state: State; current: Route; onCollapse: () => void }) {
  const seen = useSeen(state, current)
  const groups = useMemo(() => {
    const out = new Map<string, ChannelView[]>()
    for (const channel of Object.values(state.channels).sort((a, b) => a.path.localeCompare(b.path))) {
      const at = channel.path.lastIndexOf('/')
      const group = at === -1 ? 'channels' : channel.path.slice(0, at)
      out.set(group, [...(out.get(group) ?? []), channel])
    }
    return [...out]
  }, [state.channels])
  const sync = state.discovery?.sync ?? []
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => board.toast(`copied ${text}`))
  return (
    <div className="sidebar-scroll">
      <div className="brand">
        <span>board</span>
        <button className="tool" title="hide the sidebar" onClick={onCollapse}>
          <PanelLeftClose size={15} strokeWidth={1.75} />
        </button>
      </div>
      <Link to="/" className="item" current={current.view === 'activity'}>
        <span>activity</span>
      </Link>
      {groups.map(([group, channels]) => (
        <section key={group}>
          <h2>{group}</h2>
          {channels.map((channel) => {
            const active = current.view === 'channel' && current.channel === channel.path
            // Only where the board keeps a channel's last position: Vercel's API doesn't.
            const unread = !active && (channel.lastIndex ?? 0) > (seen[channel.path] ?? Number.POSITIVE_INFINITY)
            return (
              <ContextMenuArea
                key={channel.path}
                menu={
                  <>
                    <MenuItem onClick={() => copy(channel.path)}>copy name</MenuItem>
                    <MenuItem onClick={() => copy(`vb read ${channel.path}`)}>copy vb read command</MenuItem>
                  </>
                }
              >
                <Link to={`/c/${channel.path}`} className={`item${unread ? ' unread' : ''}`} current={active} title={channel.path}>
                  <span className="name">#{channel.path.slice(channel.path.lastIndexOf('/') + 1)}</span>
                  {unread ? <i className="dot" /> : channel.threads !== undefined ? <span className="count">{channel.threads}</span> : null}
                </Link>
              </ContextMenuArea>
            )
          })}
        </section>
      ))}
      {sync.length > 0 && (
        <section>
          <h2>inbox</h2>
          {sync.map((entry) => (
            <Link key={entry.key} to={`/inbox/${entry.key}`} className="item" current={current.view === 'inbox' && current.key === entry.key}>
              <span className="name">{entry.key}</span>
              <span className="count">{entry.platform}</span>
            </Link>
          ))}
        </section>
      )}
      <ProfileMenu me={state.me!} board={state.discovery?.url ?? ''} />
    </div>
  )
}

const AGENTS = ['claude', 'codex', 'grok']

/** The profile `name`, with the avatar you last gave it. */
function remembered(name: string): board.Profile {
  const avatar = board.avatarOf(name)
  return avatar ? { name, avatar } : { name }
}

/** Who you post as: yourself, one of your agents' profiles, or any profile you name, with the avatar you give it. */
function ProfileMenu({ me, board: url }: { me: Me; board: string }) {
  // The profile you're naming or changing, as it starts out; null while the menu shows.
  const [editing, setEditing] = useState<board.Profile | null>(null)
  const person = me.handle.split('/')[0]
  const choose = (name: string | null) => void board.setProfile(name === null ? null : remembered(name))
  if (editing)
    return (
      <form
        className="whoami naming"
        onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          const name = form.get('profile')?.toString().trim()
          const avatar = form.get('avatar')?.toString().trim()
          if (name) void board.setProfile({ name, ...(avatar ? { avatar } : {}) })
          setEditing(null)
        }}
        onKeyDown={(event) => event.key === 'Escape' && setEditing(null)}
        // Leaving the form puts it away; moving between its fields doesn't.
        onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && setEditing(null)}
      >
        <input
          name="profile"
          autoFocus
          defaultValue={editing.name}
          placeholder="profile name, e.g. reviewer"
          pattern="[A-Za-z][A-Za-z0-9\-]{0,31}"
          title="a letter, then up to 31 letters, numbers, and hyphens"
          required
        />
        <input
          name="avatar"
          type="url"
          defaultValue={editing.avatar ?? ''}
          placeholder="avatar URL, https://… (optional)"
          // What the board takes: https, or http on this machine.
          pattern="https://.+|http://(localhost|127\.0\.0\.1)([:\/].*)?"
          title="an https URL (http only on localhost)"
        />
        {/* Safari and Firefox don't focus a button you click: without this, the field's blur closes the form before the click. */}
        <button type="submit" className="send small" onMouseDown={(event) => event.preventDefault()}>
          post as this
        </button>
      </form>
    )
  const item = (label: string, profile: string | null) => (
    <MenuItem onClick={() => choose(profile)}>
      <span className="choice">
        {label}
        {me.profile === profile && <Check size={13} />}
      </span>
    </MenuItem>
  )
  return (
    <div className="whoami-wrap" title={`${me.actor}\n${url}`}>
      <Menu
        className="whoami"
        title="post as"
        trigger={
          <>
            <Avatar name={who(me)} url={me.avatar} size={24} />
            <span className="grow">
              <span className="as">as {who(me)}</span>
              <span className="faint url">{url.replace(/^https?:\/\//, '')}</span>
            </span>
            <ChevronsUpDown size={13} />
          </>
        }
      >
        {item(`${person} (you)`, null)}
        {AGENTS.map((agent) => item(agent, agent))}
        {me.profile !== null && !AGENTS.includes(me.profile) && item(me.profile, me.profile)}
        <MenuSeparator />
        {me.profile !== null && (
          <MenuItem onClick={() => setEditing(remembered(me.profile!))}>
            {me.profile}'s name and avatar…
          </MenuItem>
        )}
        <MenuItem onClick={() => setEditing({ name: '' })}>another profile…</MenuItem>
        {board.getProfile() !== undefined && <MenuItem onClick={() => void board.setProfile(undefined)}>as inspect started</MenuItem>}
      </Menu>
    </div>
  )
}

// --- views ---------------------------------------------------------------------------

/** Your newest message among `messages`, for ↑ to edit. */
const lastOwn = (messages: MessageView[], me: string) => [...messages].reverse().find((m) => m.by.actor === me && !m.deleted)

type Filters = { filter: Filter; setFilter: (filter: Filter) => void; sources: string[]; known: KnownLabels }

function FilterControls({ filters }: { filters: Filters }) {
  return <FilterButton filter={filters.filter} onChange={filters.setFilter} sources={filters.sources} known={filters.known} />
}

function Activity(props: { state: State; options: RowOptions; known: KnownLabels; lead: ReactNode; filters: Filters }) {
  const { state, options, known, lead } = props
  const { filter } = props.filters
  useTypeToFocus('main')
  const key = JSON.stringify(filter)
  useEffect(() => {
    if (filtering(filter)) void board.loadFiltered(undefined, filter)
  }, [key])
  const messages = useMemo(
    () => recent(state, 200, filtering(filter) ? (m) => matches(state, m, filter) : undefined),
    [state.messages, state.ops, state.actors, key],
  )
  const pending = filtering(filter) ? [] : state.pending.filter((post) => post.re === null)
  return (
    <>
      <Header title="activity" meta="the latest across every channel" live={state.live} lead={lead}>
        <FilterControls filters={props.filters} />
      </Header>
      <FilterChips filter={filter} onChange={props.filters.setFilter} />
      <Feed scope="activity" first={messages[0]?.id ?? ''} last={`${messages.at(-1)?.id ?? ''}+${pending.length}`}>
        {messages.length === 0 && pending.length === 0 && (
          <p className="empty">{filtering(filter) ? 'nothing matches these filters' : state.cursor === null ? 'loading…' : 'nothing here yet: start a thread below'}</p>
        )}
        <Messages
          messages={messages}
          now={options.now}
          options={{
            ...options,
            context: (m) => (
              <span className="where">
                {m.re === null ? 'in ' : 'replied in '}
                <Link to={`/c/${m.channel}${m.re === null ? '' : `?thread=${m.re}`}`}>#{m.channel}</Link>
              </span>
            ),
          }}
        />
        <Pendings posts={pending} me={state.me!} after={messages.at(-1)} />
      </Feed>
      <Composer
        scope="activity"
        role="main"
        placeholder="start a thread…"
        known={known}
        channels={Object.keys(state.channels).sort()}
        onSend={({ text, noSync, channel, labels, files }) => void board.send({ channel, re: null, text, noSync, labels, files })}
        onEditLast={() => {
          const mine = lastOwn(messages, state.me!.actor)
          if (mine) board.setEditing(mine.id)
        }}
      />
    </>
  )
}

function Channel(props: { channel: string; state: State; options: RowOptions; known: KnownLabels; lead: ReactNode; filters: Filters }) {
  const { channel, state, options } = props
  const { filter } = props.filters
  useTypeToFocus('main')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    void board.loadChannel(channel).finally(() => setLoading(false))
  }, [channel])
  const key = JSON.stringify(filter)
  useEffect(() => {
    if (filtering(filter)) void board.loadFiltered(channel, filter)
  }, [channel, key])
  const { threads: all, pending: posts } = useMemo(() => channelThreads(state, channel), [state.messages, state.ops, state.pending, state.actors, channel])
  // A filtered channel shows the threads where anything matches.
  const threads = filtering(filter) ? all.filter((t) => matches(state, t.root, filter) || t.replies.some((r) => matches(state, r, filter))) : all
  const pending = filtering(filter) ? [] : posts
  const roots = threads.map((t) => t.root)
  const replies = new Map(threads.map((t) => [t.root.id, t.replies]))
  const info = state.channels[channel]
  const newest = [...roots, ...threads.flatMap((t) => t.replies)].sort(byWritten).at(-1)?.id ?? ''
  return (
    <>
      <Header
        title={`#${channel}`}
        meta={info?.threads !== undefined && info.messages !== undefined ? `${count(info.threads, 'thread')} · ${count(info.messages, 'message')}` : undefined}
        live={state.live}
        lead={props.lead}
      >
        <FilterControls filters={props.filters} />
      </Header>
      <FilterChips filter={filter} onChange={props.filters.setFilter} />
      <Feed scope={channel} first={roots[0]?.id ?? ''} last={`${newest}+${pending.length}`} older={() => board.loadOlder(channel)}>
        {roots.length === 0 && pending.length === 0 && (
          <p className="empty">{loading ? 'loading…' : filtering(filter) ? 'nothing matches these filters' : 'no messages yet: say something'}</p>
        )}
        <Messages messages={roots} now={options.now} options={{ ...options, replies: (m) => replies.get(m.id) ?? [] }} />
        <Pendings posts={pending} me={state.me!} after={roots.at(-1)} afterHasReplies={(replies.get(roots.at(-1)?.id ?? '')?.length ?? 0) > 0} />
      </Feed>
      <Composer
        scope={`channel:${channel}`}
        role="main"
        placeholder={`message #${channel}…`}
        known={props.known}
        onSend={({ text, noSync, labels, files }) => void board.send({ channel, re: null, text, noSync, labels, files })}
        onEditLast={() => {
          const mine = lastOwn(roots, state.me!.actor)
          if (mine) board.setEditing(mine.id)
        }}
      />
    </>
  )
}

function ThreadPane(props: { id: string; state: State; now: number; known: KnownLabels }) {
  const { id, state } = props
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    void board.loadThread(id).then(() => setMissing(!board.getState().messages[id]))
  }, [id])
  const t = useMemo(() => threadOf(state, id), [state.messages, state.ops, state.pending, state.actors, id])
  const platforms = Object.fromEntries((state.discovery?.sync ?? []).map((entry) => [entry.key, entry.platform]))
  const options: RowOptions = { me: state.me!.actor, now: props.now, known: props.known, platforms }
  return (
    <>
      <Header title="thread" meta={t ? `in #${t.root.channel}` : undefined}>
        <button className="tool" title="close (esc)" onClick={() => navigate(here({ thread: null }))}>
          <X size={15} strokeWidth={1.75} />
        </button>
      </Header>
      <Feed scope={`thread:${id}`} first={id} last={`${t?.replies.at(-1)?.id ?? id}+${t?.pending.length ?? 0}`}>
        {!t ? (
          <p className="empty">{missing ? 'no such thread' : 'loading…'}</p>
        ) : (
          <>
            <Messages messages={[t.root]} now={props.now} options={options} />
            <div className="divider">{t.replies.length === 1 ? '1 reply' : `${t.replies.length} replies`}</div>
            <Messages messages={t.replies} now={props.now} options={options} after={t.root} />
            <Pendings posts={t.pending} me={state.me!} after={t.replies.at(-1)} />
          </>
        )}
      </Feed>
      {t && (
        <Composer
          scope={`thread:${id}`}
          role="thread"
          placeholder="reply to thread…"
          known={props.known}
          onSend={({ text, noSync, labels, files }) => void board.send({ channel: t.root.channel, re: id, text, noSync, labels, files })}
          onEditLast={() => {
            const mine = lastOwn([t.root, ...t.replies], state.me!.actor)
            if (mine) board.setEditing(mine.id)
          }}
        />
      )}
    </>
  )
}

/** Raw platform events: "did Slack even send it?" Not on the board's log, so not live. */
function Inbox({ entry, now, lead }: { entry: string; now: number; lead: ReactNode }) {
  const [events, setEvents] = useState<InboxEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => {
    setError(null)
    board.loadInbox(entry).then(setEvents, (e: Error) => setError(e.message))
  }
  useEffect(load, [entry])
  return (
    <>
      <Header title={`inbox · ${entry}`} meta="raw platform events, newest first" lead={lead}>
        <button className="tool" title="refresh" onClick={load}>
          <RefreshCw size={14} strokeWidth={1.75} />
        </button>
      </Header>
      <div className="feed-wrap">
        <div className="feed">
          <div>
            {error && <p className="error">error: {error}</p>}
            {!error && events === null && <p className="empty">loading…</p>}
            {events?.length === 0 && <p className="empty">no events yet</p>}
            {events?.map((row) => {
              const event = row.event as { kind: string; text?: string; type?: string; emoji?: string; author?: { handle?: string } }
              return (
                <div key={row.id} className="inbox-row">
                  <Ago iso={row.createdAt} />
                  <span>
                    <span className="badge">{event.kind}</span>
                  </span>
                  <div>
                    <div>
                      <span className="author">{event.author?.handle ?? '—'}</span> {event.text ?? event.type ?? event.emoji ?? ''}
                    </div>
                    <pre>
                      {row.channel} · {row.event.thread}
                    </pre>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </>
  )
}
