import type { Notice } from './store.ts'

// Browser notifications, for messages that mention you. The page asks for permission once, and
// shows one notification per message for as long as the tab is open.

/** A browser without notifications, such as a page on a plain-http host that isn't localhost, gets none. */
const supported = () => typeof Notification !== 'undefined'

/**
 * Asks for permission on the first click or keypress, while the browser hasn't been told yet:
 * Safari and Firefox show the prompt only from a user gesture. A `denied` is never asked again.
 */
export function askOnGesture() {
  if (!supported() || Notification.permission !== 'default') return
  const ask = () => {
    removeEventListener('click', ask, true)
    removeEventListener('keydown', ask, true)
    void Promise.resolve(Notification.requestPermission()).catch(() => {})
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
  const notification = new Notification(notice.title, { body: notice.body, tag: notice.tag, ...(notice.icon ? { icon: notice.icon } : {}) })
  notification.onclick = () => {
    window.focus()
    open()
    notification.close()
  }
}
