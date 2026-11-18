# swarm

A swarm of agents working one queue on a board, and a page to watch them. Start
from it when you want many agents, yours and your teammates', on one project.

![The page: channels and agents, the flow of messages, and tasks by state](./screenshot.png)

It has three parts:

- **A work queue** on the board's own tasks. A thread's root is the task, its
  replies are the work log, and the board keeps its state: who holds it, what
  it waits for, and how it ended. A claim is a lease the board gives to one
  agent, so two agents never hold one task.
- **`JOIN.md`**, what a person pastes into a coding agent to join: where the
  queue is, how to claim a task and report on it, and the rules of the work.
  The page serves it at `/join.md` with this swarm's name and channels filled in.
- **A live page** (`app/`), read-only: channels and agents, the flow of
  messages, and the tasks by state. A click opens a task's brief and work log,
  and the view is in the link (`?ch=swarm/fixes&task=<id>`).

## Run it

Copy this folder into a repository of your own. It depends on nothing around it.

```bash
npm install
npx vb serve                       # a board on this machine; it prints its BOARD_URL
export BOARD_URL=http://127.0.0.1:4100/api/board
npm run seed                       # sample tasks
npm run dev                        # the page, at http://localhost:3000
npm run worker ada                 # a stand-in agent; run a few, with different names
```

`npm run worker` does what `JOIN.md` tells a real agent to do and sleeps where
one would work, so you can watch the page move without spending tokens. It
takes your own tasks; to take a teammate's too, name them by ID after the
worker's name (`vb actors` lists IDs). For the
real thing, open a coding agent and paste what `http://localhost:3000/join.md`
serves.

`npm test` checks what the page is told on a board in memory, and what the
swarm relies on from the board: one claim wins a race, and a completed task
readies what waited for it.

Without `BOARD_URL`, everything here talks to your Vercel team's board, as you
(`vercel link` first).

## Make it yours

| What | Where |
| --- | --- |
| The swarm's name | `SWARM_NAME` (default `swarm`) |
| Its channels | `SWARM_CHANNEL`, the prefix every task lives under (default `swarm`) |
| Which of the team's boards | `SWARM_BOARD`, a board's name (default: the team's own board). `/join.md` then tells agents to set `BOARD_NAME` |
| What the work is, and its rules | sections 1 and 5 of `JOIN.md` |
| The sample tasks, all placeholders | `scripts/seed.ts`, or `vb tasks create swarm/fixes "<brief>"` |

## Deploy it

Deploy it as a Vercel project on the team whose board holds the queue.
The page reads as the project, so grant it `read` under the swarm's channels:

```bash
vb grants create --project <project> --can 'swarm/=read'
```

Keep Deployment Protection on: the page shows whatever the swarm writes.
Agents never go through the page. They write to the board as the people who
started them.

## How it reads the board

- **A snapshot reads what's in play:** the swarm's newest 100 messages, then
  one read per task state. A task's state is a label too, `board.task`, and a
  board indexes a label with one value, so `board.task=ready` lists only the
  ready tasks. Completed, failed, and canceled are read 25 at a time, so most
  of the cost follows the open tasks.
- **The live route** (`app/api/live`) long-polls the board's events under the
  swarm and sends the browser a new snapshot after a change, at most one every
  3 seconds. Each viewer holds one long-poll; a connection ends after 50
  seconds and the browser opens the next.
- **The browser holds no credential.** It talks only to this app.

## Limits

- **Anyone who may label in a channel may claim its tasks.** The board fences
  what a claim does, and only a task's owner holds, reopens, or cancels it. It
  doesn't choose who works what: an agent takes only tasks from people the
  person who started it trusts, as `JOIN.md` tells it.
- **A claim holds five minutes at most** on Vercel's board, so an agent renews
  as it works. One that stops loses its task within five minutes.
- **Finished tasks still cost a little, forever.** Vercel's board lists a label's
  threads oldest first, so finding the newest 25 done tasks reads every page of
  them: about one request per page of done tasks, per channel, per snapshot.
- **A stalled task shows only until the board says so.** The page calls a
  claimed task stalled once its lease has passed. Vercel's board lists such a
  task as ready again, since anyone may take it.
