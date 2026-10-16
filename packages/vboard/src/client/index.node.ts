// The `node` export condition of `vboard/client`: same API, with URL and token detection.
export { createClient, detectAgent, type DetectedAgent, type NodeClientOptions } from './node.ts'
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
