import { Bot, Hammer, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Vector3 } from 'three'
import { here as hereWith, navigate, useNow } from './nav.tsx'
import { type State } from './store.ts'
import { World, type Label, type Picked } from './scene.ts'
import { fitted, PLATE, townOf, type House, type Resident } from './town.ts'
import { Header } from './ui.tsx'

/**
 * Boardville: the board as a village in three dimensions. Each channel is a house on its street, and
 * everyone waits on the porch of the house they were last active in. Walk into a house and the camera
 * comes down to it, its roof lifts off, its busiest threads are tables, and everyone sits at the one
 * they were last in. Only the house you're in opens, so the page reads one channel in full, and the
 * rest from the feed.
 */
export function Town(props: { state: State; lead: ReactNode; house: string | null; thread: string | null; children?: ReactNode }) {
  const { state, house, thread } = props
  const now = useNow(5_000)
  const host = useRef<HTMLDivElement>(null)
  const world = useRef<World | null>(null)
  const labels = useRef(new Map<string, Label>())
  const enter = (channel: string | null) => navigate(hereWith({ thread: null, params: { house: channel === house ? null : channel } }))
  const pick = useRef<(picked: Picked) => void>(() => {})
  pick.current = (picked) => {
    if (!picked) return
    if ('thread' in picked) navigate(hereWith({ thread: picked.thread }))
    else if (picked.house !== house) enter(picked.house)
  }

  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    const made = new World(element, (picked) => pick.current(picked), labels.current)
    world.current = made
    const dark = matchMedia('(prefers-color-scheme: dark)')
    const repaint = () => made.repaint()
    dark.addEventListener('change', repaint)
    return () => {
      dark.removeEventListener('change', repaint)
      made.dispose()
      world.current = null
    }
  }, [])

  const town = useMemo(() => townOf(state, now, { here: house, looking: thread }), [state.messages, state.channels, state.actors, state.ops, state.me, now, house, thread])
  const lit = useMemo(() => new Set(town.residents.filter((r) => !r.idle).map((r) => r.channel)), [town])
  useEffect(() => world.current?.show(town, house, lit), [town, house, lit])

  /** A label kept over a point of the scene, by its key. */
  const over = (key: string, anchor: () => Vector3 | null, rank?: number) => (element: HTMLElement | null) => {
    if (element) labels.current.set(key, { element, anchor, ...(rank === undefined ? {} : { rank }) })
    else labels.current.delete(key)
  }
  /** Of two labels that would overlap, the one that shows: who's in a house first, then the busiest houses' signs. */
  const rankOf = (h: House) => (h.channel === house ? 5 : h.who.length > 0 ? 3 : h.tasks > 0 ? 1 : 0)
  // What the newest speaker in a house said, for a house whose roof is on: it shows over the roof.
  const said = new Map(town.residents.filter((r) => r.bubble).map((r) => [r.channel, r]))
  const around = town.residents.filter((r) => !r.idle).length
  const open = town.houses.find((h) => h.channel === house)
  return (
    <>
      <Header title="boardville" meta={`${town.houses.length} house${town.houses.length === 1 ? '' : 's'} · ${around} around`} live={state.live} lead={props.lead}>
        {house && (
          <button className="tool" title={`leave #${house}`} onClick={() => enter(null)}>
            <X size={15} strokeWidth={1.75} />
          </button>
        )}
      </Header>
      <div className={`town${house ? ' inside' : ''}`} ref={host}>
        {town.houses.length === 0 && <p className="empty">{state.cursor === null ? 'loading…' : 'no houses yet: a channel is a house, so post in one'}</p>}
        <div className="town-labels">
          {/* Each district's name, at the corner of its first block. */}
          {town.streets.map((street) => (
            // On the road above the block, clear of its houses.
            <div key={`street:${street.name}`} className="over" ref={over(`street:${street.name}`, () => new Vector3(street.x + 90, 0, street.y - 12), 4)}>
              <span className="street-sign">{street.name}</span>
            </div>
          ))}
          {town.houses.map((h) => (
            <div key={`house:${h.channel}`} className="over" ref={over(`house:${h.channel}`, () => new Vector3(h.x + h.width / 2, 0, h.y + h.depth + PLATE - 8), rankOf(h))}>
              <button className={`plate${h.channel === house ? ' open' : ''}`} onClick={() => enter(h.channel)} title={h.channel === house ? `#${h.channel}` : `walk into #${h.channel}`}>
                <span className="name">#{h.name}</span>
                {h.tasks > 0 && <span className="count" title={`${h.tasks} open task${h.tasks === 1 ? '' : 's'}`}>{h.tasks}</span>}
              </button>
            </div>
          ))}
          {/* Who's in a house with its roof on, over its roof, as a room's names show over it. */}
          {town.houses
            .filter((h) => h.channel !== house && h.who.length > 0)
            .map((h) => (
              <div key={`roof:${h.channel}`} className="over" ref={over(`roof:${h.channel}`, () => new Vector3(h.x + h.width / 2, 150, h.y + h.depth / 2), 4)}>
                <div className="stack">
                  {said.get(h.channel) && (
                    <button className="bubble" onClick={() => navigate(hereWith({ thread: said.get(h.channel)!.bubble!.thread }))} title="open the thread">
                      <span className="who">{said.get(h.channel)!.name}</span>
                      <span className="text">{said.get(h.channel)!.bubble!.text}</span>
                    </button>
                  )}
                  <button className="roof-pill" onClick={() => enter(h.channel)} title={`${h.who.map((w) => w.name).join(', ')} in #${h.channel}`}>
                    <i className={h.who.some((w) => !w.idle) ? 'on' : ''} />
                    <Faces urls={h.who.map((w) => w.avatar)} />
                    {fitted(h.who.map((w) => w.name), 26)}
                  </button>
                </div>
              </div>
            ))}
          {open?.tables.map((table) => (
            // What the thread is, on its tabletop: under the faces of who sits behind it, and on no other table.
            <div key={`table:${table.thread}`} className="over centered table-label" data-span="140" ref={over(`table:${table.thread}`, () => new Vector3(table.x + 70, 26, table.y + 17), table.seated > 0 ? 2 : 0)}>
              <button onClick={() => navigate(hereWith({ thread: table.thread }))} title="open the thread">
                <span className="label">{table.label || 'a thread'}</span>
                {table.task && <span className={`state ${table.task}`}>{table.task}</span>}
              </button>
            </div>
          ))}
          {open?.tables.map((table) => {
            const seated = town.residents.filter((r) => r.channel === house && r.seated && r.thread === table.thread)
            if (seated.length === 0) return null
            const speaker = seated.find((r) => r.bubble)
            return (
              // Who sits at a table, in one pill over their heads, as a room's names show over it.
              <div key={`seats:${table.thread}`} className="over" data-span="160" ref={over(`seats:${table.thread}`, () => new Vector3(table.x + 70, 86, table.y - 24), 3)}>
                <div className="stack">
                  {speaker && (
                    <button className="bubble" onClick={() => navigate(hereWith({ thread: speaker.bubble!.thread }))} title="open the thread">
                      {seated.length > 1 && <span className="who">{speaker.you ? 'you' : speaker.name}</span>}
                      <span className="text">{speaker.bubble!.text}</span>
                    </button>
                  )}
                  <span className="roof-pill" title={seated.map((r) => r.name).join(', ')}>
                    <i className={seated.some((r) => !r.idle) ? 'on' : ''} />
                    <Faces urls={seated.map((r) => r.avatar)} />
                    {!seated.some((r) => r.avatar) && seated.some((r) => r.agent) && <Bot size={11} strokeWidth={2} />}
                    {fitted(seated.map((r) => (r.you ? 'you' : r.name)))}
                    {seated.some((r) => r.working) && <Hammer size={11} strokeWidth={2} />}
                  </span>
                </div>
              </div>
            )
          })}
          {town.residents.map((r) => (
            // Everyone on their feet, standing or walking, has a pill of their own; who's seated is in their table's.
            <PersonLabel key={`person:${r.actor}`} resident={r} attach={over(`person:${r.actor}`, () => (world.current?.settled(r.actor) && r.channel === house ? null : (world.current?.personAt(r.actor) ?? null)), r.you ? 6 : 3)} />
          ))}
        </div>
      </div>
      {house && <section className="town-inside">{props.children}</section>}
    </>
  )
}

/** Up to three people's pictures, overlapping a little, as a pill's faces; none for who has no picture. */
function Faces({ urls }: { urls: (string | null)[] }) {
  const [broken, setBroken] = useState<Set<string>>(() => new Set())
  const shown = urls.filter((url): url is string => !!url && !broken.has(url)).slice(0, 3)
  if (shown.length === 0) return null
  return (
    <span className="faces">
      {shown.map((url) => (
        <img key={url} src={url} alt="" referrerPolicy="no-referrer" onError={() => setBroken((known) => new Set(known).add(url))} />
      ))}
    </span>
  )
}

/** Someone in sight: their name in a pill over their head, with what they just said over it. */
function PersonLabel({ resident: r, attach }: { resident: Resident; attach: (element: HTMLElement | null) => void }) {
  return (
    <div className={`over person-label${r.idle ? ' idle' : ''}${r.you ? ' you' : ''}`} ref={attach}>
      <div className="stack">
        {r.bubble && (
          <button className="bubble" onClick={() => navigate(hereWith({ thread: r.bubble!.thread }))} title="open the thread">
            <span className="text">{r.bubble.text}</span>
          </button>
        )}
        <span className="tag" title={r.working ? 'working on a task here' : r.idle ? 'away' : undefined}>
          <i className={r.idle ? '' : 'on'} />
          <Faces urls={[r.avatar]} />
          {!r.avatar && r.agent && <Bot size={11} strokeWidth={2} />}
          {r.you ? 'you' : r.name}
          {r.working && <Hammer size={11} strokeWidth={2} />}
        </span>
      </div>
    </div>
  )
}
