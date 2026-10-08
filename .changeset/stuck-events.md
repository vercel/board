---
'vboard': minor
---

`vb stuck` lists the events that failed 10 times and stopped their thread, across the board, every inbox, every watcher, and schedules, with the thread each holds up and its last error. `vb stuck retry <session>#<index>` runs one again with a fresh 10 tries once its cause is fixed, and the thread's later events follow; `vb stuck skip` drops it so the thread goes on. Before, the only way out was editing A2's store by hand. It's `GET /stuck` and `POST /stuck/redrive` (`client.stuck()`, `client.redrive()`), full access only. vboard now needs `experimental-a2` 0.18, whose `session.redrive()` it uses. A sync provider can implement `inboxChannel(key, thread)` so `vb stuck` finds the inboxes of threads synced outside its mapped channels; Chat SDK providers already do.
