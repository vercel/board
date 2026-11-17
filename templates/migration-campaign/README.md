# migration campaign

A swarm of agents that makes one change across a codebase. You say what the change is and which
files it's for. Each file becomes a task on your team's board, each agent works in a Vercel Sandbox
of its own, and every change is checked by a command and read by a second model before it's
delivered. What an agent can't do, it holds for you, with why.

![A campaign: 11 of 12 tasks completed, one held for a person, and what it has spent](./screenshot.png)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fboard%2Ftree%2Fmain%2Ftemplates%2Fmigration-campaign&project-name=migration-campaign&repository-name=migration-campaign)

## What a campaign is

The form on the page is the whole configuration:

| Field | What it's for |
| --- | --- |
| Repository, branch | What to migrate: `owner/name` on GitHub, or an https git URL |
| Instructions | The change, in words. Every agent reads it, and so does the reviewer |
| Files to migrate | A shell command, run in the checkout, that prints one path per line |
| Setup | Run once after the clone, before every agent gets a copy: installing dependencies |
| Verify | A command that must exit 0 after each change. `{files}` becomes the task's files |
| Files per task, most tasks | How the files are split, and where the campaign stops making tasks |
| Agents | How many work the queue, 1 to 16. You can change it while the campaign runs |
| Model, thinking | The model that makes the change, from AI Gateway's list, with its price |
| Reviewer | A second model that reads each diff with nothing but the instructions, or none |
| Tries | How many times an agent may try again after a failed verify or review |
| Deliver as | A patch on each task's thread, a pull request per task, or commits on one branch |
| Budget, time limit | What the models may cost, and how long it runs. Past either, the agents stop |

"Fill in a sample" loads a campaign you can run as it is: `var` to `const` and `let` in a public
repository's examples, 12 tasks, 3 agents, checked with `node --check`. It costs about a cent.

## How it runs

1. **The checkout.** One sandbox clones the repository, runs your setup command, and lists the
   files. It's stopped and kept, so every agent starts from a copy of the same checkout.
2. **The tasks.** Each group of files is a task in a channel of the campaign's own
   (`migrate/<campaign>`): a thread whose state the board keeps, `ready`, `claimed`, `blocked`, or
   `completed`. `vb tasks migrate/<campaign>` lists them.
3. **The agents.** Each sandbox runs one loop (`sandbox/runner.ts`): claim the oldest ready task,
   give a fresh agent that one task, run the verify command, have the reviewer read the diff, and
   deliver it. A failed verify or a review that asks for changes goes back to the agent. After the
   tries you set, the task is held for you instead.
4. **You.** A held task shows on the page with the agent's reason. Your answer goes in the task's
   thread, the task is ready again, and the next agent reads what you wrote.
5. **The end.** A campaign is done when every task has ended. It stops at its budget or its time
   limit, and its sandboxes are stopped either way.

The loop is code. A model decides only what to change in a file: it doesn't pick tasks, decide when
it's done, or deliver its own work.

Two agents never hold one task. A claim is a lease the board gives to one agent and fences: of
claims that race, one lands, and an agent that stalls past its lease can't settle a task another
has taken. Each agent renews its lease while it works (`sandbox/runner.ts`).

## Nothing secret in a sandbox

An agent runs the repository's own code, so its sandbox holds no credential. Each sandbox's network
policy adds them to its requests on the way out (`lib/sandboxes.ts`):

- **The board**, as that agent's profile (`worker-3`), held to its own campaign's tasks. It can
  read the campaigns' threads and change none of them.
- **AI Gateway**, for the models.
- **GitHub**, when the campaign opens pull requests or pushes a branch, and then the deployment's
  `GITHUB_TOKEN` goes only on requests for the campaign's own repository.

Every other host is blocked. The token in a policy lives under two hours, so a running campaign's
policies are made again every few minutes.

## Deploy it

1. **Click Deploy.** It makes your copy of this repo and a Vercel project. There's no database: the
   board is your team's, in Vercel's API, and it's the only place a campaign is kept.
2. **Turn on Vercel Authentication** for all deployments, in the project's Deployment Protection
   settings. The page starts sandboxes and spends money as the deployment, so it starts nothing
   while anyone can open it, and says so.
3. **Set `CRON_SECRET`** to any long random string. The cron in `vercel.json` checks every running
   campaign every five minutes, whether or not its page is open.
4. **Optionally, set `GITHUB_TOKEN`**, a token that can push to the repositories you migrate.
   Without it, campaigns clone public repositories and deliver patches.

## Locally

```bash
pnpm install
vercel link && vercel env pull   # the project's OIDC token: for the board, AI Gateway, and Sandbox
pnpm dev
```

Locally, and on previews, the board is one named `campaign-dev`, which the first run makes on your
team, so nothing you try shows up where your team works. Open it with
`npx @vercel/board inspect --name campaign-dev`.

```bash
pnpm campaign                    # the sample, from the terminal, with no page
pnpm campaign my-campaign.json   # a config of your own: the form's fields, as JSON
pnpm show <campaign> [task-id]   # a campaign as the board has it, and one task's thread and patch
pnpm answer <campaign> <task-id> "<note>"   # answer a held task: it's ready again

pnpm typecheck
pnpm test                        # the campaign's rules, on a board in memory
pnpm check:tasks                 # what a campaign relies on from the board's tasks, on your real board
```

## Make it yours

| To change | Edit |
| --- | --- |
| What an agent and a reviewer are told | `WORKER` and `REVIEWER` in `sandbox/runner.ts` |
| What happens to a task between claim and delivery | `work()` in `sandbox/runner.ts` |
| How a change leaves the sandbox | `deliver()` in `sandbox/runner.ts` |
| The form's fields, their defaults and limits, and the sample | `lib/config.ts`, `app/new.tsx` |
| When a campaign ends, and how many agents it runs | `ending()` and `reconcile()` in `lib/run.ts` |
| What a sandbox may reach | `workerPolicy()` in `lib/sandboxes.ts` |
| The channel campaigns live in, and which board | `CAMPAIGN_CHANNEL`, `CAMPAIGN_BOARD` |

## How it's built

| Path | What it is |
| --- | --- |
| `app/page.tsx`, `app/new.tsx` | The campaigns, and the form |
| `app/c/[slug]/` | A campaign, live: its tasks, its agents, what's held, and its log |
| `app/api/live` | The page's feed: a snapshot after every change on the board |
| `app/api/tick` | What the cron calls: every running campaign is reconciled |
| `lib/campaign.ts` | A campaign as the board has it: its thread, its tasks, what they've spent |
| `lib/queue.ts` | The queue, on the board's tasks: making them, listing them, and what a person does to one |
| `lib/run.ts` | The launch, and `reconcile`, which makes the sandboxes match what the board says |
| `lib/sandboxes.ts` | The base image, a campaign's checkout, its workers, and their network policies |
| `sandbox/runner.ts` | What runs in each sandbox: the loop, the agents, verify, review, delivery |
| `sandbox/shared.ts` | What the app and the runner agree on |

The app keeps nothing between requests. Any request can pick a campaign up from the board: the
cron, a page someone has open, or `pnpm campaign`.

## Limits

- **16 agents.** Vercel's board gives one project 20 agent profiles, and each agent is one.
- **A claim holds five minutes.** That's the most Vercel's board gives, so an agent renews its
  claim every 80 seconds. One that dies loses its task within five minutes, and another takes it.
- **A launch runs in one function.** Cloning, setup, and listing files happen after the form's
  response, in the same invocation. A setup command that takes longer than the function may run
  doesn't fit: do less in it, or start the campaign with `pnpm campaign`.
- **One pull request per task can be many.** With `prs`, a campaign of 200 tasks opens 200 pull
  requests. `branch` puts them on one, for one review.
