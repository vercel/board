import { useMemo, useSyncExternalStore } from 'react'

// Stars are yours alone: this browser keeps them, per board, and the board never sees them.

const keyOf = (board: string) => `board.stars:${board}`

const read = (board: string): string | null => {
  try {
    return localStorage.getItem(keyOf(board))
  } catch {
    return null
  }
}
const parse = (raw: string | null): Set<string> => {
  try {
    return new Set<string>(JSON.parse(raw ?? '[]'))
  } catch {
    return new Set()
  }
}

const listeners = new Set<() => void>()
// Another tab's stars show here too: a `storage` event is the same news as a toggle in this one.
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    removeEventListener('storage', listener)
  }
}

/** The channels you starred on `board`. */
export function useStars(board: string): Set<string> {
  const raw = useSyncExternalStore(subscribe, () => read(board), () => read(board))
  return useMemo(() => parse(raw), [raw])
}

export function toggleStar(board: string, path: string) {
  const stars = parse(read(board))
  if (!stars.delete(path)) stars.add(path)
  try {
    localStorage.setItem(keyOf(board), JSON.stringify([...stars]))
  } catch {}
  for (const listener of listeners) listener()
}
