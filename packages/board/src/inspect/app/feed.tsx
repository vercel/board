import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useToasts } from './chrome.ts'

// --- the scrolling list --------------------------------------------------------------

/**
 * Keeps to the bottom while you're there, holds still while you read history,
 * and keeps your place when older messages load above. A `target` message is
 * scrolled to and marked, and kept where it is until you scroll.
 */
export function Feed(props: {
  scope: string
  /** The first message shown: when it changes, older ones loaded above. */
  first: string
  /** The last thing shown, as a key: when it changes, something new came in below. */
  last: string
  older?: () => Promise<boolean>
  /** The message to show: its ID, and which time it was asked for, since asking again marks it again. */
  target?: { id: string; time: number } | null
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const restore = useRef<{ height: number; top: number } | null>(null)
  const loading = useRef(false)
  const done = useRef(false)
  const first = useRef(props.first)
  first.current = props.first
  const lastSeen = useRef(props.last)
  const [behind, setBehind] = useState(false)
  /** The target, while you haven't scrolled: how far from the top it sits, once it's there. */
  const held = useRef<{ id: string; top: number | null } | null>(null)

  /** Keeps the target where it sits; the first time it's there, in the middle, marked. Whether there's a target. */
  const hold = (): boolean => {
    const el = ref.current!
    const target = held.current
    if (!target) return false
    const row = el.querySelector<HTMLElement>(`#m${CSS.escape(target.id)}`)
    // Not loaded yet: the list holds still until it is.
    if (!row) return true
    if (target.top === null) {
      target.top = Math.max(0, (el.clientHeight - row.offsetHeight) / 2)
      // Marked again from the start: the animation runs when the attribute is set.
      delete row.dataset.target
      void row.offsetWidth
      row.dataset.target = ''
      row.addEventListener('animationend', () => delete row.dataset.target, { once: true })
    }
    el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - target.top
    return true
  }
  const release = () => {
    held.current = null
  }

  const toBottom = () => {
    const el = ref.current!
    release()
    el.scrollTop = el.scrollHeight
    pinned.current = true
    setBehind(false)
  }

  useLayoutEffect(() => {
    toBottom()
    lastSeen.current = props.last
    done.current = false
  }, [props.scope])

  useLayoutEffect(() => {
    if (!props.target) return
    held.current = { id: props.target.id, top: null }
    pinned.current = false
    hold()
  }, [props.target?.id, props.target?.time])

  useLayoutEffect(() => {
    const el = ref.current!
    if (hold()) {
      lastSeen.current = props.last
      return
    }
    if (restore.current) {
      el.scrollTop = el.scrollHeight - restore.current.height + restore.current.top
      restore.current = null
    } else if (pinned.current) el.scrollTop = el.scrollHeight
    else if (props.last !== lastSeen.current) setBehind(true)
    lastSeen.current = props.last
  }, [props.first, props.last])

  // Reactions, edits, and images change heights without changing the list.
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (hold()) return
      if (pinned.current && !restore.current) ref.current!.scrollTop = ref.current!.scrollHeight
    })
    observer.observe(content.current!)
    // And the list itself: what sits above a thread comes and goes.
    observer.observe(ref.current!)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="feed-wrap">
      <div
        className="feed"
        ref={ref}
        // Scrolling yourself lets the target go; the page's own scrolls don't.
        onWheel={release}
        onTouchStart={release}
        onPointerDown={release}
        onScroll={() => {
          const el = ref.current!
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          if (pinned.current) setBehind(false)
          if (el.scrollTop < 240 && props.older && !loading.current && !done.current) {
            loading.current = true
            const before = first.current
            restore.current = { height: el.scrollHeight, top: el.scrollTop }
            void props.older().then((more) =>
              // After the render that shows them: if nothing came in above, there's no place to keep.
              requestAnimationFrame(() => {
                if (first.current === before) restore.current = null
                loading.current = false
                done.current = !more
              }),
            )
          }
        }}
      >
        <div ref={content}>{props.children}</div>
      </div>
      {behind && (
        <button className="jump" onClick={toBottom}>
          new messages ↓
        </button>
      )}
    </div>
  )
}

export function Toasts() {
  const toasts = useToasts()
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  )
}
