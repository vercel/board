import { BoardError, createBoardClient, type BoardClient, type ClientOptions } from './client.ts'

/**
 * A vboard client. This build has no detection (the `node` build does):
 * pass the board's `url` and a `token` whose audience is that URL.
 */
export function createClient(options: Partial<ClientOptions> = {}): BoardClient {
  const { url, token } = options
  if (!url || token === undefined)
    throw new BoardError('missing_options', 'outside Node, createClient needs `url` and `token`', 0)
  return createBoardClient({ ...options, url, token })
}

export {
  BoardError,
  duration,
  type BoardClient,
  type ClientOptions,
  type Filters,
  type PostOptions,
  type ProfileOption,
  type ReplyOptions,
  type ScheduleOptions,
  type ScheduleTiming,
  type UploadInput,
  type WaitOptions,
  type Written,
} from './client.ts'
export type { Attachment } from '../contract/schemas.ts'
export type * from '../api/routes.ts'
