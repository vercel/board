---
name: ui-demo
description: "Show a visible change working, in a narrated, captioned video of the browser (or a screenshot when one frame shows it), attached to the reply that links its PR. Use whenever a change touches what people see."
---

# Show a change working

When a change touches what people see, show it instead of describing it: a video for a flow
people click through, a screenshot when one still frame shows it, or nothing when there's
nothing to see (say so in the PR instead).

The video records the browser you drive with the `browser__*` tools. Before each action you
call `narrate` with one line, which is said out loud and captioned from that moment, and the
action follows once it's been said. `scripts/ui-demo` in this skill records the tab, cuts the
time you spend thinking, burns the captions in and mixes the voice, as an mp4 under 4 MB.

## 1. Pick where to try it

- **A dev server in the sandbox**, almost always: start it in the background
  (`pnpm dev > /tmp/dev.log 2>&1 &`, after `pnpm install`) and poll it with curl until it
  answers. Read the repo's AGENTS.md or README for how it runs and what it needs.
- **A deployment**, when the change needs real data or the deployed setup and the deployment is
  open to the public. A protected preview asks for Vercel login, which the browser can't do.

## 2. Rehearse, then record

Do the flow once without recording, so the take has no dead ends: `browser__open` the page,
`browser__snapshot`, act on its refs. Then go back to where the flow starts, and:

1. `scripts/ui-demo start`, with the page already open in the browser.
2. For each step: `narrate` its line, then do it with the browser tools. Lines are short,
   first-person sentences people can hear in about 2 seconds, written to be said (words, not
   symbols or paths): "Opening the settings page", "Turning on dark mode", "The page switches to
   dark: it works".
3. `scripts/ui-demo stop /tmp/<thread>-<flow>.mp4`

- Only narrate a result ("it works", "the message is posted") once a snapshot or screenshot shows
  it. If the flow fails, record the failure and say so. Don't attach a video that claims something
  the screen doesn't show.
- The take keeps each line and a few seconds after it, and cuts the rest, so take your time.
- `scripts/ui-demo start --mute` records captions only, when sound adds nothing.
- If `stop` says the video is over 4 MB, record a shorter take.

## 3. Attach it

Attach it to the reply that links the PR: `vb reply <id> "<the PR link, and a line on what the
video shows>" --attach /tmp/<thread>-<flow>.mp4`. A screenshot works the same way
(`browser__screenshot`, then `--attach`). Never attach test logs: the tests are in the PR.
