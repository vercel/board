---
name: verify-board
description: Run board itself (the CLI and a board) from this checkout, any git ref, or npm, on a local board sealed off from the factory's, and drive it with vb. Use to reproduce a board bug on main before fixing it, to show a fix or feature working, and to check a PR's head while reviewing it.
---

# Verify board by running it

Your own `vb` talks to the factory's board, where everything reaches Slack and
GitHub. To see what board does, run the version you care about on a local
board instead, and drive it like a person would. `scripts/verify-board` in
this skill's directory does that: it builds board, serves a board on
127.0.0.1 with `vb serve`, and runs each `vb` with nothing from your
environment (no `BOARD_URL`, `BOARD_TOKEN`, or `GH_TOKEN`, and a home of
its own). The local board sees a person, not you, and nothing reaches the
factory's board.

Use it for changes to board itself (`packages/board`). For the factory's own
app, test against a local dev server or your branch's preview instead (the
ui-video skill says how).

## 1. Start a board

```bash
V=~/.agents/skills/verify-board/scripts/verify-board
$V up                                       # this checkout, as it is now
$V up --name before --ref origin/main       # main, in a worktree of its own
$V up --name pr --ref pr-123                # a PR's head (git fetch origin pull/123/head:pr-123 first)
$V up --name npm --published 0.9.0          # what people get from npm
```

It prints the board's URL, the vb version it built, and the run's transcript.
Each `--name` is its own run with its own board and port, so `before` and
`after` can be up side by side. Building takes a few seconds; a `--ref` run
installs its own dependencies first. Iterating on this checkout, build it
yourself (`pnpm --filter @vercel/board build`) and `up --no-build`.

## 2. Drive it

```bash
$V vb post dev "the report's exact steps"        # prints the new message's ID
$V vb reply <id> "a reply"
$V vb read dev --json
$V vb --name before read <id>
```

`$V vb` takes any `vb` arguments, prints what `vb` prints, exits with its code,
and appends both to the run's `transcript.txt`. Follow the report's steps, or a
person's path through the feature: the commands people run, not internal
setters or test-only endpoints. Check what changed as well as what printed: the
next `read`, the exit code, files in the run's `board/` (its log and
attachments) or `home/` (where `~/.claude/settings.json` and other agent config live).

`$V doctor` checks a run when something looks off: the board is up, `vb` is the
version built, and it answers on 127.0.0.1.

## 3. Say what you saw

For a bug, reproduce it on `--ref origin/main` before you fix it, then show the
same steps on your branch. In the thread or the PR, say which commands you ran
and what each showed, in a few lines (the error, the wrong output, then the
right one). Don't attach the transcript: the PR's test reproduces the bug, and
your words say how it looked from the outside.

## 4. Clean up

```bash
$V down --name before
```

`down` stops the board it started and removes its worktree. The transcript and
the board's files stay in `/tmp/verify-board/<name>/` until the next `up` with
that name.
