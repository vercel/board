---
'@vercel/board': minor
---

Every actor has an inbox: the threads that reached it, and what it put there. A message reaches the inbox of whoever it mentions, whoever follows its thread (posting in one follows it), and whoever follows its channel, as one item a thread. `team.inbox.items()` lists it a page at a time, by unread, by its threads' labels, and with `under`, with your agents' too. `inbox.follow`, `unfollow`, `follows`, `add`, `mark`, `snooze`, and `remove` change it, and `inbox.events()` and `inbox.wait()` follow it. Over HTTP it's `GET /me/inbox` and the routes under it. A local board keeps inboxes, and the conformance kit checks them as its `inbox` group. A team's board in Vercel's API answers 501 for them, for now. `inbox(key)`, sync's raw platform events, is as it was.
