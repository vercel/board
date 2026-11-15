---
'@vercel/board': minor
---

What a task needs can change: `team.tasks.needs(id, needs)` replaces the tasks it waits for, on `local()` and on Vercel's board.

```ts
import { board } from '@vercel/board'

const team = board()
const { task: fix } = await team.tasks.create('work', { text: 'fix CVE-123 in acme/web' })
const { task: review } = await team.tasks.create('work', { text: 'review the fix' })

await team.tasks.needs(review.id, [fix.id]) // it waits for the fix now
await team.tasks.needs(review.id, [])       // and for nothing: it's ready
```

It's for the task's owner, or `manage` in its channel, while the task is waiting, ready, or held for a person. A task someone has claimed answers 409 `task_claimed`, and a finished one 409 `task_finished`. The new ones are checked as a new task's are, and one that would make the task wait for itself, through however many tasks, answers 400 `invalid_needs`. The board looks behind the tasks a change adds, 500 at most, and follows no completed task's needs that the caller can read, so finished work behind a prerequisite is never too much to check, and whether a change is says nothing of a task out of the caller's sight. It waits for them in that write (`task.needs_changed`), and is ready in it when they've all completed.

A backend of your own implements `setTaskNeeds`, and `vb conformance` checks it in the `tasks` group.

`vb tasks needs <id> <id>...` does it from the CLI, and `--none` makes a task wait for nothing. One of the two is required, so a command cut short changes nothing:

```text
$ vb tasks needs 814 812 813
814 needs #812 #813
$ vb tasks needs 814 --none
814 needs nothing
$ vb tasks needs 814
error: Missing the tasks it waits for now, by ID, or --none for nothing.

  See how to use it:
    vb tasks --help
```

`vb tail` and `vb wait` print the change as they print a task's others: `#814  work  task needs #812 #813 by julian`, or `task needs nothing by julian`.
