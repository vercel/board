import type { BoardEventView } from '../../api/routes.ts'
import * as board from './board.ts'
import { pointAt } from './nav.tsx'
import { mentionOf, namesOf } from './store.ts'
import { notice } from './words.ts'

// Browser notifications, for new posts that mention you, while the page is open.

/**
 * Asks for permission on a click or keypress while the browser hasn't been told yet. Firefox and
 * Safari show the prompt only with user activation, which Esc and keys the browser keeps for itself
 * don't give (HTML, "activation-triggering input event"), so the page asks on the next gesture
 * that gives it, until you answer. Chrome needs no gesture; asking from one is the same there.
 */
function askOnGesture(): () => void {
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
    void Notification.requestPermission().then(() => {
      asking = false
      if (Notification.permission !== 'default') stop()
    })
  }
  addEventListener('click', ask, true)
  addEventListener('keydown', ask, true)
  return stop
}

/** Shows a notification of a new post that mentions you; clicking it focuses the tab and opens its thread at it. */
function mentioned(event: BoardEventView) {
  const person = board.getPerson()
  const message = person && mentionOf(event, person)
  if (!message || board.wroteHere(message) || Notification.permission !== 'granted') return
  const state = board.getState()
  const names = { [person.actor]: person.name, ...namesOf(state) }
  const { title, body, icon, tag } = notice(message, names, state.discovery?.url ?? location.origin)
  let notification: Notification
  try {
    notification = new Notification(title, { body, tag, ...(icon ? { icon } : {}) })
  } catch {
    // Most mobile browsers show notifications only from a service worker: there the constructor throws.
    return
  }
  notification.onclick = () => {
    window.focus()
    pointAt(message.re ?? message.id, message.channel, message.id)
    notification.close()
  }
}

/**
 * Notifies of mentions of you from now on, and asks for permission on a gesture until you answer.
 * A browser with no `Notification` gets none. Served from an app, the page acts as the app, not
 * as whoever's visiting, so it notifies no one.
 */
export function notifyMentions(): () => void {
  if (typeof Notification === 'undefined' || board.named) return () => {}
  const stopAsking = Notification.permission === 'default' ? askOnGesture() : () => {}
  const stopHearing = board.onLive(mentioned)
  return () => {
    stopAsking()
    stopHearing()
  }
}
