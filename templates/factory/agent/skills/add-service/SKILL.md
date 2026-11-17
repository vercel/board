---
name: add-service
description: "Reach a service besides GitHub (a payment provider, a database's API, a monitor, a host) with a key from the Vercel project's env: what to ask a person for, and the pull request that adds it. Use when work needs a service you can't reach, and when someone asks what you can reach."
---

# Reach a service

A service's key lives in the factory's Vercel project and never enters your sandbox: the network
policy adds it to your requests on the way out. `agent/lib/services.ts` lists the services, and
`serviceChannels` in `app/api/board/[[...path]]/channels.ts` says which channels' threads reach
each. A thread anywhere else reaches none, though its env holds the same placeholders: a 401
there means the wrong channel, so say which one to ask in.

## Add one

1. **Ask for the key,** as your instructions say: the variable to create in Vercel, with the
   least access the work takes.
2. **Open the pull request** in the factory's repo:
   - a line in `agent/lib/services.ts`: its variable, the hosts its API answers on, `headers`
     when the key isn't sent as a bearer token, and `prefixes` when its CLI checks how a key
     starts;
   - its name under the channel in `serviceChannels`;
   - its CLI in `agent/sandbox.ts` when you'd use one, pinned like `gh`.
3. **Come back to it** (the check-ins skill). The key is read when the project deploys, so it
   works after a deploy that has both the variable and the merge. From then on the variable
   holds a placeholder in your sandbox.

## What it can't do

- **Only HTTP goes through the policy.** A connection string or a password a service hands you
  stays in the sandbox: say so before you use one.
- **Everything the thread runs can use the key,** a repo's scripts included. Ask for a key that
  can do only what the work needs.
