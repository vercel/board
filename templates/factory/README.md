# factory

A board, an agent, and a sandbox that take your team's bugs, features, and questions to pull
requests. Issues and PRs from your GitHub repos, and threads from a Slack channel, come into the
board, and the agent hears every message. It answers questions, reproduces bugs, opens PRs with
fixes and features, reviews every PR, and stays quiet when nothing's for it.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fboard%2Ftree%2Fmain%2Ftemplates%2Ffactory&project-name=factory&repository-name=factory)

## Deploy it

1. **Click Deploy.** It makes your copy of this repo and a Vercel project, and nothing else: no
   database and no storage. The board is your team's, in Vercel's API, which keeps its messages,
   files, and schedules.
2. **Open the deployment.** Its page is the launcher. Each step checks the deployment as it is now
   and says what to do, with the command to run or the page to open:
   - **Vercel.** Vercel Authentication, the team's board (which someone on the team opens once,
     so it exists), and AI Gateway (the agent's model).
   - **GitHub.** A Vercel Connect connector whose app is on the repos the factory works on, this
     one included, so the agent can change the factory itself.
   - **Slack**, optionally. The channel where the factory updates itself: its own pull requests
     land there, and it's where to talk about how it works.
   - **Try it.** Start its first task, making this README yours, or open an issue, or post on
     the board, and the agent replies.

   The connectors and the Slack channel are named for your Vercel project: `github/factory`,
   `slack/factory`, and `#factory-rsi` for a project named `factory`. A team's second factory gets
   its own. Renaming the project renames them on its next deployment: create them again, or write
   the names you have in `connectors` (`factory.ts`) and `slackChannels` (`channels.ts`).

   Or hand it to your agent: **Copy prompt** copies what to paste. The launcher answers its steps
   as markdown to anything that isn't a browser, such as `vercel curl https://<your-deployment>`.
3. **Watch it work.** The launcher ends with the command that opens the board in your browser, as
   you:

   ```bash
   npx @vercel/board inspect --scope <your-team>
   ```

Until the deployment turns strangers away, the launcher shows only how to protect it.

## What it does with what it hears

- **Its channels on your team's board are under one named for the project:** `project-factory` for
  a project named `factory`, so a team's second factory never hears the first.
- **This repo's own PRs and issues come into `project-<name>/rsi`,** where people talk with the
  agent about the factory itself, and Slack's `#<project>-rsi` mirrors it.
- **Each repo you onboard gets a channel of its own,** `project-<name>/<repo>`, and a Slack
  channel that mirrors it: the one you name, or `#<project>-<repo>`. Ask the agent, "onboard
  acme/web", and it opens the pull request that adds both lines to
  `app/api/board/[[...path]]/channels.ts`, and says where the repo will show and what's left to
  do. What's about no one repo goes in `project-<name>`.
- **The agent hears every message in those channels,** and decides what each needs: an answer, a
  reproduction, a PR, a review, or nothing.
- **Each thread gets its own session and its own sandbox.** Its GitHub token covers only the
  thread's repo, and a fork's PRs stay off the board.
- **A PR the agent opens is its own until it's merged or closed:** it schedules its own check-ins
  on the board and comes back to it.
- **It comes back to what it leaves open:** a deploy, or an approval it asked you for somewhere
  else. It checks on its own, and says when it's done.
- **It says what would make the factory better:** what slowed it or you down, or a correction
  that should stick, posted in `project-<name>/rsi`, where you can tell it to fix it.
- **Its commits are signed by GitHub,** with no key to manage.
- **It reaches the services you give it:** ask it to work with one (a payment provider, a
  monitor), and it says which key to create in Vercel and opens the pull request that adds it,
  for one channel's threads. The key never enters its sandbox.

## Make it yours

| To change | Edit |
| --- | --- |
| How it works on every turn: what it answers, how it triages, how it writes | `agent/lib/instructions.ts` |
| What it does sometimes: reviewing, reproducing a bug, opening a PR and seeing it through, coming back to what it left open, feedback on the factory, reaching a service, demos, onboarding a repo | `agent/skills/` |
| Which repos and Slack channels come into the board, and where | `app/api/board/[[...path]]/channels.ts` |
| Its model, and its sandbox | `agent/agent.ts`, `agent/sandbox.ts` |

Ask the agent in `project-<name>/rsi`: it changes this repo with a pull request, like any other.

## How it's built

| Path | What it is |
| --- | --- |
| `app/page.tsx`, `lib/setup.ts` | The launcher, and its tasks. `app/index.md` is the same steps as markdown, which `/` answers to an agent |
| `app/api/board/[[...path]]/factory.ts` | The board: its sync and its watcher, over the channels `channels.ts` names. `route.ts` beside it answers Vercel's wake-ups and the platforms' webhooks |
| `agent/` | The agent, an [eve](https://www.npmjs.com/package/eve) agent mounted at `/eve/v1` |
| `agent/lib/wake.ts` | All the board sees of the agent: `wakeAgent`, which the board's watcher runs on every message |
| `agent/channels/eve.ts` | Where wake-ups reach the agent, from this deployment only: one eve session per board thread |
| `agent/tools/vb.ts` | The agent's hands on the board: `vb`'s commands, as the factory itself |
| `agent/lib/credentials.ts` | A GitHub token per thread, in the sandbox's network policy and never in the sandbox |
| `agent/lib/services.ts` | The services besides GitHub the agent reaches, each with a key from the project's env, in the channels `channels.ts` gives it |
| `agent/lib/git/` | The sandbox's `git`: pushes go through GitHub's API, which signs the agent's commits |
| `agent/extensions/browser.ts`, `agent/tools/narrate.ts` | A browser in the sandbox, and the voice for the narrated videos of the `ui-demo` skill |
| `agent/instrumentation/otel.ts` | Traces each session with its content, for the project's Agent Runs. Needs a 100% sampling rule: `vercel traces config set 100 --environment any` |

The board reaches the agent only through its watcher, so another agent swaps in by giving the
board a watcher of its own.

## Locally

```bash
pnpm install
vercel link && vercel env pull   # the project's OIDC token, for the board, AI Gateway, and Connect
pnpm dev
```

Locally, and on previews, the board is one named `factory-dev`, which the first run makes on your
team, so nothing you try answers production's threads. Open it with
`npx @vercel/board inspect --name factory-dev`.

```bash
pnpm typecheck
pnpm test
```

## Updates

This repo is a copy, not a fork: it doesn't follow the template on its own. `package.json`'s
`version` is the release it started from.
