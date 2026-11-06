---
'@vercel/board': minor
---

Watchers drop `when: 'enters'`: `run` gets every event its tail prints, replies in a thread the tail's label matches included. This breaks a watcher that set `when: 'enters'`, which now also runs on those replies and on label writes that keep it matching. Check the event in `run` instead, and filter on the write that set the label:

```ts
import { board } from '@vercel/board'

export const team = board({
  watch: {
    done: {
      tail: '--label state=done',
      run: async ({ event, board }) => {
        if (event.type !== 'labels.changed' || event.payload.set.state !== 'done') return
        await board.react(event.message!.id, 'check')
      },
    },
  },
})
```

`POST /watchers` and `RegistrationView` carry no `when`, and a registration's hash covers only its tails and sync entries. A board on `http()` and the board it registers with hash alike only on the same side of this release: until both run it, each wake-up registers again.
