---
name: onboard-repo
description: "Bring a repo into the factory: give it a board channel of its own and a Slack channel that mirrors it, with a pull request to this factory's own repo that says where the repo will show and what's left to do. Use when someone asks you to onboard, add, or start working on a repo."
---

# Onboard a repo

A repo's pull requests and issues come into the board once this factory's own repo maps it to a
channel, and they show in Slack once a Slack channel mirrors that one. Both maps are in
`app/api/board/[[...path]]/channels.ts`. Whoever asks for a repo wants to know where they'll see
it, so work that out first, and say it in the pull request and in the thread.

1. **Check the GitHub app is on it:** call setup_steps with `repo`. Don't ask `gh`: in a thread
   your GitHub access covers only repos already onboarded, so one that isn't never shows there,
   whether the app is on it or not. What `asked` says:
   - already onboarded: say where it shows, and stop.
   - `app: false`: say so and stop. Someone on the team adds the app to it, and the setup page
     links to where.
   - `app: null`: it couldn't be told. Go on, and say you couldn't confirm the app is on it.
2. **Pick its board channel:** `channel("<name>")`, a channel of its own under this factory's.
   `<name>` is the repo's name as a channel takes it: lowercase letters, digits, `-` and `_`.
3. **Pick where it shows in Slack.** A board channel shows in Slack only through a Slack channel
   that mirrors it, and a Slack channel mirrors one board channel.
   - They named a Slack channel: use it.
   - They didn't: use one named for this factory and the repo, `slackChannel("-<name>")`, which
     is `#factory-web` for a factory named factory, and say they can name another.
   - This factory isn't on Slack (the setup_steps tool shows its Slack step still asking for a
     connector): map none, and say the repo's threads will be on the board only.
4. **Map both** in `channels.ts`: `"<owner>/<repo>": channel("<name>")` in `repoChannels`, the
   repo written as GitHub writes it, and the Slack channel in `slackChannels`, pointing at the
   same board channel.
5. **Open the pull request** (the open-pr skill). Its title names the repo and where it will
   show: "Bring acme/web into #factory-web". Its description says, each in a line:
   - where the repo's pull requests and issues will show: the Slack channel, and the board
     channel behind it;
   - what's left for a person before merging: create that Slack channel if it isn't there, and
     invite this factory's Slack app to it, the one that posts in the factory's own Slack
     channel. Once the PR is deployed, the setup page shows the command while the app isn't in;
   - what won't come in: pull requests and issues opened before it's merged.
6. **Reply in the thread** with the PR's link, where the repo will show, and what's left for
   them, in one short message.
7. **Once it's merged and deployed,** call setup_steps: its Slack step says whether the app is
   in the new channel. Say the repo is in and where it shows, or what's still missing.
8. **Then see whether you can try your work in it,** without being asked, when nothing says
   how yet: the try-it skill. The repo's channel is where its services reach you. To start a
   thread of your own there, schedule yourself a message
   (`vb schedule <its channel> "<what you're going to do>" --in 1m`): your own messages wake
   you only when they're scheduled.
