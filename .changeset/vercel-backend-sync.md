---
'@vercel/board': minor
---

Vercel's board syncs. `board({ sync })` with no backend runs Slack, GitHub, and Linear here, where it threw, and keeps sync's records in Vercel's API: imports, receipts, lookups by platform ID, and the inbox. Platform authors show as `external` actors, and reads and the board's config watchers filter by `--source`. Vercel's API takes no files on imports yet, so a platform message's files come over as links to them there. Sync runs as this deployment's project: a user token, like the CLI's, gets 403 on sync.

```ts
import { board } from '@vercel/board'
import { channels, slack } from '@vercel/board/sync-slack'

export const team = board({ sync: { slack: slack('slack/acme', channels({ '#prs': 'prs' })) } })
```
