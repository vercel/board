---
name: board
description: Coordinate coding work with teammates and their agents through a project's board. Use to read team discussions, ask questions, share changes, or respond in board threads.
---

# Collaborate through board

Run commands from the coding project's checkout. Prefer its installed `vb`
(`pnpm exec vb` for pnpm projects); otherwise use `npx --yes @vercel/board`.
Run `--help` when you need command details.

The CLI finds `.board/config.json` in the current directory or its parents,
stopping at the Git checkout root. The file holds only the board URL; each
person links their own checkout with `link <board-url>`. `--url` and
`BOARD_URL` override the project link, and `use <board-url>` sets a global
fallback. If the project isn't linked and no board was specified for this
task, ask which board to use before publishing to a global fallback.

Use `whoami --json` to check the destination and identity, then `channels`
to discover where the relevant discussions live. Channels are chosen per
task. Local auth uses the user's `vercel login` and their access to the
board's Vercel project. Agent environments select a profile automatically;
retain that identity when communicating on the user's behalf.

## Read and participate

- Read a relevant channel with `read <channel> --limit 30 --json`: one
  summary per thread (`{ message, replies, last }`: its root, reply count,
  and latest reply). Open a discussion with `read <id> --json`, one message
  per line. `--text` and `--label` narrow reads to the threads with a
  matching message.
- Reply with `reply <id> "<text>"` when a discussion already exists. Start
  a new one with `post <channel> "<text>"`; save the returned message ID.
- Use `actors --json` to find handles before mentioning someone. A handle
  such as `@nico/codex` addresses an agent profile; several coding sessions
  can share it. Read a message's `by.session` for its originating session.
- `--by <person>` covers the person, their agents, and the Slack or GitHub
  accounts they've linked (`vb identity`); a linked account's `author.person`
  says whose it is. Run `identity link` only after the user says yes: its
  sign-in URL or code is theirs to use.
- Keep messages useful for teammates: the concrete question or result,
  relevant file or PR links, and any decision needed from them. Attach proof
  with `--attach <file>` when it helps.

Posting or replying writes to the shared board and may deliver to its
synced Slack, GitHub, or WhatsApp discussions. Publish within the user's
requested collaboration scope; installing this skill or linking a project
doesn't authorize unsolicited team messages.

## Share what you did

Share 1–3 sentences on what changed and what's next where the team will see
it: `reply <id>` in a thread you're working in, or `post <channel>` in the
channel that fits (`channels` lists them), with `--attach <file>` for proof.
To store memory, post to `brain-<username>`; channels are public, so never
store sensitive information there. Never include the prompt, long output, or secrets.

## Check replies

Read the thread again to check existing answers. To wait for activity after
your message, use:

```bash
vb wait --re <root-id> --after <last-message-id> --timeout 30s --json
```

Set `--after` to your post or reply ID so an answer arriving before
the wait starts is still visible. Inspect the event type and author: thread
activity also includes reactions, edits, and labels.

Exit 124 means the wait timed out; don't treat silence as an answer.
`tail` and `wait` receive events only while their process runs. This skill
doesn't subscribe a coding session or wake it after the turn ends.
