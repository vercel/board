import type { MessageView } from '../../api/routes.ts'
import { replaceMentions } from '../../contract/mentions.ts'
import { authorName, firstLine } from './words.ts'

// Browser notifications, for new messages that mention you: one per message for as long as the tab
// is open.

/** What a notification of a message says: who wrote it and where, its first line, and the author's avatar. */
export type Notice = { title: string; body: string; icon?: string; tag: string }

/**
 * A notification of `message`, on the board at `board`. `names` reads each `@[id]` as `@name`. The
 * tag is the same in every tab: a notification with a tag replaces the one shown with it before, so
 * two tabs on one board leave one notification of a message on screen.
 */
export function notice(message: MessageView, names: Record<string, string>, board: string): Notice {
  const text = replaceMentions(message.text, (token) => (token.kind === 'actor' ? `@${names[token.actor] ?? token.actor}` : null))
  const avatar = message.author?.avatar
  return {
    title: `${authorName(message)} in #${message.channel}`,
    body: firstLine(text),
    ...(avatar?.startsWith('https://') ? { icon: avatar } : {}),
    tag: `board:${board}:${message.id}`,
  }
}

/** Some browsers have no `Notification`. Where there is one, `permission` says whether the page may show any. */
const supported = () => typeof Notification !== 'undefined'

/**
 * Asks for permission on a click or keypress while the browser hasn't been told yet. Firefox and
 * Safari show the prompt only with user activation, which Esc and keys the browser keeps for itself
 * don't give, so the page asks on the next gesture that gives it, until you answer. Chrome needs no
 * gesture; asking from one is the same there.
 */
export function askOnGesture() {
  if (!supported() || Notification.permission !== 'default') return
  let asking = false
  const stop = () => {
    removeEventListener('click', ask, true)
    removeEventListener('keydown', ask, true)
  }
  const ask = () => {
    if (Notification.permission !== 'default') return stop()
    const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation
    if (asking || activation?.isActive === false) return
    asking = true
    void Promise.resolve(Notification.requestPermission())
      .catch(() => {})
      .finally(() => {
        asking = false
        if (Notification.permission !== 'default') stop()
      })
  }
  addEventListener('click', ask, true)
  addEventListener('keydown', ask, true)
}

/** The messages this tab has shown a notification for. */
const notified = new Set<string>()

/** Shows a notification for message `id`, once; clicking it focuses the tab and runs `open`. */
export function notify(id: string, notice: Notice, open: () => void) {
  if (!supported() || Notification.permission !== 'granted' || notified.has(id)) return
  notified.add(id)
  let notification: Notification
  try {
    notification = new Notification(notice.title, { body: notice.body, tag: notice.tag, ...(notice.icon ? { icon: notice.icon } : {}) })
  } catch {
    // Most mobile browsers show notifications only from a service worker: there the constructor throws.
    return
  }
  notification.onclick = () => {
    window.focus()
    open()
    notification.close()
  }
}
