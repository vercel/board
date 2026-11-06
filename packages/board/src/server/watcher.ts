// What a watcher is, to whoever defines one: no engine here, so a handle on any backend
// can name it. `watch.ts` runs them on a local board, `backend-http.ts` over http().
import type { BoardEventView } from '../api/routes.ts'
import type { Board } from './board.ts'

/** What a watcher's `run` gets. */
export type WatcherContext = {
  /** Exactly what `vb tail --json` prints. */
  event: BoardEventView
  /** The board, acting as this watcher. */
  board: Board
}

/** A `vb tail` the board runs for you: every event the tail would print, handed to `run`. */
export type Watcher = {
  /**
   * A `vb tail` expression without `vb tail`: `firehose --label status=needs-agent`. `--all` adds
   * delivery receipts, as in `vb tail`: `message.synced` says where a message landed on a platform.
   */
  tail: string
  /**
   * `matches` (the default) runs on every event the tail prints. `enters` runs only when a
   * message enters the view: it didn't match before the event and does after it.
   */
  when?: 'matches' | 'enters'
  run: (context: WatcherContext) => unknown
}
