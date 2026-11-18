---
name: try-it
description: "Find a way to try your changes to a repo for real, by using what it builds, and keep what you learn for the next thread. Says what can and can't reach your sandbox, so you ask a person only for what can arrive. Use when you start on a repo you haven't run, and when a change needs more than its tests."
---

# Try your work for real

Tests tell you some of it. Using the thing tells you the rest: open the page, run the command,
call the endpoint. For each repo you work on, look for a way to do that yourself.

How is yours to work out from what's there. Every repo is different, and some have no way you
can reach. That's fine: say what you couldn't try, and carry on.

What the repo won't tell you:

- **What's in your sandbox** is the repo, what it installs, and what you make there: a local
  database, seed data, an account you sign up for on a server you started.
- **A service's key reaches your requests, never your sandbox** (the add-service skill). Nothing
  else comes in. A variable in this factory's Vercel project isn't in your environment, so don't
  ask for a password, a client secret, or a connection string to be put there: it would never
  arrive.
- **A person can do what happens outside your sandbox:** add a service's key, make an account
  or a test project, change a setting, try one step and say what they saw. Get as far as you
  can first, then ask once, for all of it.
- **A protected preview is closed to you.** It asks for a Vercel login, which your browser
  can't do.
- **In a thread you start yourself, your GitHub access covers every repo the board brings in
  from one org,** this factory's own. A repo in another org can't be cloned there: work on it
  from the thread of one of its pull requests or issues.

When you find a way, show it once in the thread (a screenshot, what the command printed), and
write it down in the repo's `AGENTS.md`: what to run, what it needs, and what can't be tried.
The next thread starts from there.
