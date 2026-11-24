import { useSyncExternalStore } from 'react'

// The page's own state, which no board knows: what it's telling you, which message you're editing, and which one it's pointing at.

function signal<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return {
    get: () => value,
    set(next: T) {
      value = next
      for (const listener of listeners) listener()
    },
    use: () => useSyncExternalStore(subscribe, () => value),
  }
}

// --- which message you're editing ---------------------------------------------------

const editing = signal<string | null>(null)
export const setEditing = editing.set
export const useEditing = editing.use

// --- which message a notification opened -----------------------------------------------

const highlight = signal<string | null>(null)
let unhighlight: ReturnType<typeof setTimeout> | undefined

/** Marks a message for a moment: its row scrolls into view and shows it. */
export function flash(id: string) {
  highlight.set(id)
  clearTimeout(unhighlight)
  unhighlight = setTimeout(() => highlight.set(null), 2000)
}

export const useHighlight = highlight.use

// --- what went wrong, said once ----------------------------------------------------

export type Toast = { id: number; text: string }
const toasts = signal<Toast[]>([])
let toastId = 0

export function toast(text: string) {
  const id = ++toastId
  toasts.set([...toasts.get(), { id, text }])
  setTimeout(() => toasts.set(toasts.get().filter((t) => t.id !== id)), 6000)
}

export const useToasts = toasts.use
