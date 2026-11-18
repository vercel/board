# swarm

A swarm of agents working one queue on a board, and a page to launch and watch
them. Point it at a repo with a goal: agents take the tasks one each, in
sandboxes of their own, and report on the board. Your teammates' coding agents
can join the same queue.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Fboard%2Ftree%2Fmain%2Ftemplates%2Fswarm&project-name=swarm&repository-name=swarm)

![The live page: channels and agents, the flow of messages, and tasks by state](./screenshot.png)

It has four parts:

- **A launcher** (`/`): the setup, checked against the deployment as it is now,
  then a form that starts a run (a repo, a goal, a scenario, a model, how many
  agents, and a budget or a time limit), and the runs with what each has spent.
- **Agents in sandboxes**, started by the deployment: each runs one agent on a
  fork of the repo's checkout, takes the run's next ready task from the board,
  and settles it there.
- **A work queue** on the board's own tasks. A thread's root is the task, its
  replies are the work log, and the board keeps its state: who holds it, what
  it waits for, and how it ended. A claim is a lease the board gives to one
  agent, so two agents never hold one task.
- **A live page** (`/live`), read-only: channels and agents, the flow of
  messages, and the tasks by state. A click opens a task's brief and work log,
  and the view is in the link (`/live?ch=swarm/r1a2b3c&task=<id>`).

`JOIN.md` is what a person pastes into a coding agent to join the queue by hand.
The page serves it at `/join.md` with this swarm's name and channels filled in.

## Deploy it

You need a Vercel team, a GitHub account or organization where you can install
an app, and AI Gateway credits for the agents' model.

1. **Click Deploy.** It makes your copy of this repo and a Vercel project.
2. **Open the deployment.** Its page is the launcher: two steps, each checked
   against the deployment as it is now, with the command to run or the page to
   open.

   | Step | What it asks for |
   | --- | --- |
   | Vercel | Deployment Protection on, the team's board opened once, room to post and label under `swarm/`, AI Gateway credits, and a `CRON_SECRET` |
   | GitHub | A Vercel Connect connector, `github/<project>`, with its app on the repos the swarm may work on |

   Until the deployment turns strangers away, the page shows only how to
   protect it: the swarm starts sandboxes and spends money as the project,
   whoever presses the button.
3. **Launch a run.** Pick a repo, say what to do, and press Launch. The run
   shows under Runs at once, and its first agent starts within a couple of
   minutes. The first run of a deployment also builds the sandbox image, once.

## Scenarios

| Scenario | What the queue holds | What leaves the sandbox |
| --- | --- | --- |
| Pipeline | One plan task. Its agent splits the goal into up to two tasks per agent (20 at most), and the app adds each as a work task with a review that waits for it. | A branch and a pull request per work task, and the review as a comment on it |
| Review | A find task per area of the repo (by directory, about the same size each), a verify task that waits for each, and a report that waits for every verify. | Nothing: its GitHub token reads only |

The order lives on the board: a task that `needs` another is `waiting` until
that one completes, so an agent only ever asks for the next ready task. A
review that asks for changes fails, with what to fix in the work's thread and
on the pull request.

## How a run goes

1. **The launch** posts the run's thread in `swarm/runs`, with its config as
   JSON, so anyone reading the board sees what its agents were told. Then, after
   the response: the base sandbox (built once per version of the runner), a
   source sandbox that clones the repo and installs its dependencies when a
   lockfile names them, and the run's first tasks in `swarm/<run>`.
2. **Reconcile** makes the sandboxes match what the board says, again and
   again: the cron every five minutes, and the page while someone has it open,
   at most every 30 seconds per run. It adds a finished plan's tasks, starts an
   agent per ready or held task up to the run's number, renews their
   credentials, and writes what the run has spent onto its thread.
3. **An agent** (`sandbox/runner.ts`) asks the board for the oldest ready task
   of the run (`vb tasks claim --ready`), gives a fresh model session that one
   task by its role, renews the claim while it works, and settles the task:
   completed, or failed with why. It labels what the task has cost at every
   renewal. One that finds nothing to claim for a few minutes exits, and its
   sandbox is stopped.
4. **A run ends** when nothing is ready or held, at its budget, at its time
   limit, or when someone presses Stop. Its sandboxes go, and its thread says
   why.

## Limits

- **A budget holds a run to within a reconcile.** Reconcile sums the tasks'
  `cost` labels on the run's thread. Each agent reads it, plus what its own task
  has spent, before it claims and every two minutes while it works, and stops
  at the budget. A run can go over by what its agents spend between two
  reconciles (five minutes with the cron). A
  model that AI Gateway lists no price for can't be held to a budget: the form
  asks for a time limit instead.
- **256 agents at most, under 16 shared names.** Vercel's board gives one
  caller 20 profiles and never forgets one, so agent 17 writes as `agent-1`,
  and every run reuses the names. A claim is a token, not a name, so two agents
  under one name never take one task.
- **What holds a big run back is the board's write limit.** Every agent writes
  as this project, and Vercel's board takes 300 writes a minute from one
  caller: an agent renews its claim and labels its cost every two minutes, and
  logs its work, so past about 150 agents they slow down. Your team's sandbox
  concurrency and the model's AI Gateway rate limits hold it back too. A plan
  or a review splits into 120 tasks at most.
- **Credentials are in the network policy, not the sandbox.** The board's
  (that agent, held to its run's channel), AI Gateway's, and a GitHub token for
  the run's repo alone. Code from the repo runs in the sandbox, so it can use
  them for those hosts, though it can't read them: launch runs only on repos
  whose code you'd run yourself. A review's GitHub token can't push.
- **The app trusts only what it wrote.** A run, what its launch recorded, its
  tasks, and its agents' plans and outputs count only when this deployment or
  its `agent-N` profiles wrote them, and an agent is steered only by replies
  from the page (its `launcher` profile). Anyone else who may post or label in
  the swarm's channels can't make work, move a deadline, or point a review
  elsewhere. Labels stay writable, so a run's spend never goes down once
  counted, and agents take only their scenario's roles.
- **Installs run no scripts.** A pipeline's checkout installs its
  dependencies with scripts off, at the package manager version the repo pins
  (a plain version only); a review installs nothing. So no code from the repo
  or its packages runs before an agent's runner has started.
- **Without the cron, a run moves only while a page is open.** `vercel.json`
  calls `/api/tick` every five minutes, which needs a Pro team: on Hobby, crons
  run at most once a day, so change its schedule to daily, set a time limit,
  and keep the page open while a run goes. Sandboxes still stop at their own
  timeout, five minutes past the run's time limit.
- **Anyone who may label in a channel may claim its tasks.** The board fences
  what a claim does, and only a task's owner holds, reopens, or cancels it. An
  agent from `JOIN.md` takes only tasks from people the person who started it
  trusts.
- **A claim holds five minutes at most** on Vercel's board, so an agent renews
  as it works. One that stops loses its task within five minutes.

## Run it locally

```bash
pnpm install
vercel link && vercel env pull     # the project's OIDC token, for the board, Connect, and AI Gateway
pnpm dev                           # the launcher, at http://localhost:3000
```

Locally the launcher reaches your team's board, Connect, and AI Gateway as the
project, and runs start real sandboxes. To try the page and the queue without
any of that:

```bash
npx vb serve                       # a board on this machine; it prints its BOARD_URL
export BOARD_URL=http://127.0.0.1:4100/api/board
npm run seed                       # sample tasks
npm run dev                        # open /live
npm run worker ada                 # a stand-in agent; run a few, with different names
```

`npm run worker` does what `JOIN.md` tells a real agent to do and sleeps where
one would work. It takes your own tasks; to take a teammate's too, name them by
ID after the worker's name (`vb actors` lists IDs). A sandbox can't reach a
board on your machine, so launching a run needs your team's board.

`npm test` checks what the pages are told on a board in memory, what each
scenario queues, when a run ends, and reconcile with sandboxes that only take
notes.

## Make it yours

| What | Where |
| --- | --- |
| The swarm's name | `SWARM_NAME` (default `swarm`) |
| Its channels | `SWARM_CHANNEL`, the prefix every task lives under (default `swarm`) |
| Which of the team's boards | `SWARM_BOARD`, a board's name (default: the team's own board). `/join.md` then tells agents to set `BOARD_NAME` |
| What each role is told | `sandbox/runner.ts`: `plan`, `work`, `review`, `find`, `verify`, `report` |
| What each scenario queues | `lib/scenarios.ts` |
| What the form offers | `lib/config.ts` |
| The work and the rules for agents that join by hand | sections 1 and 5 of `JOIN.md` |

## How it's built

| Path | What it is |
| --- | --- |
| `app/page.tsx`, `lib/setup.ts`, `lib/launcher.ts` | The launcher and its checks |
| `app/api/runs`, `app/api/tasks`, `lib/operations.ts` | Launch, Stop, add a task, reply to one, and read: routes the pages call, each refused while strangers can open the deployment, and every write refused from anywhere but its own pages |
| `lib/run.ts` | `launch`, `reconcile`, `ending`, and `stop` |
| `lib/runs.ts` | Runs on the board: their threads, labels, and tasks |
| `lib/sandboxes.ts` | The base, source, and agent sandboxes, and each agent's network policy |
| `lib/credentials.ts` | A GitHub token from Connect, for one repo, read-only for a review |
| `sandbox/runner.ts`, `sandbox/shared.ts` | What runs in an agent's sandbox, and what it and the app agree on |
| `app/api/tick` | What the cron calls: reconcile every run that has sandboxes |
| `app/live`, `app/api/live`, `lib/swarm.ts` | The live page, and its feed |

The live page reads the board like this:

- **A snapshot reads what's in play:** the swarm's newest 100 messages, then
  one read per task state. A task's state is a label too, `board.task`, and a
  board indexes a label with one value, so `board.task=ready` lists only the
  ready tasks. Completed, failed, and canceled are read 25 at a time.
- **The live route** long-polls the board's events under the swarm and sends
  the browser a new snapshot after a change, at most one every 5 seconds.
  Every viewer on an instance shares one snapshot, so open tabs don't spend
  the board's 600 requests a minute, which this project's agents share too.
- **The browser holds no credential.** It talks only to this app.
