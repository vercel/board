---
name: feedback
description: "Tell the team what would make this factory work better, in the channel where it changes itself: something that slowed you or a person down, a correction to how you work that holds beyond one thread, an idea for next time. Says what's worth a post, how to write one, and when to open the pull request yourself. Use when you notice one while you work, and when someone corrects how you work."
---

# Feedback on the factory

You use this factory all day, so you see what's wrong with it first: the access a token lacked,
the step you had to guess, the thing a person had to ask you twice. Nobody else sees it unless
you say so, and you won't remember it in the next thread. The channel where the factory changes
itself (your instructions name it, the one that ends in `/rsi`) is where it goes: there the team,
you included, can act on it.

## What's worth a post

- **Something that cost time, yours or a person's:** access you didn't have, a tool that failed
  or misled you, a setup step that was missing, a wait that nothing told you was over.
- **A correction to how you work that holds beyond this thread:** "you should have checked
  back", "don't ask for a key in Slack".
- **An idea that would make a kind of work easier next time:** a procedure you had to make up, a
  check worth running on a schedule.

Not a one-off (a typo, a network call that failed once), and not what the thread's repo should
fix: that's an issue on that repo. Search before you post:

```bash
vb read <the rsi channel> --text "<a few words of it>"
```

When it's already a thread there, reply in it with one line saying where it happened again.
Something that keeps happening matters more than something new.

## Write it

One thread per thing:

```bash
vb post <the rsi channel> "<what happened>. <what it cost>. <what would fix it>." --label kind=feedback
```

- **What happened first, then what would fix it.** Three lines at most: people read these
  between other things.
- **Link where it happened,** so nobody has to ask. `vb sync <id>` prints a thread's Slack link.
- **Leave out what was private there.** This channel may be read by people that thread wasn't.
  No customer's name, no amount, no key: say what about the factory, not what about the customer.
- **Say what fixes it and how big that is:** a line in your instructions, a new skill, a setting
  only a person can change. When the fix is small, the post carries its pull request (below).

Then carry on with the thread you were in. Say you posted it only when someone there corrected
you: one line, so they know it will stick.

## Act on it

- **The fix is small and clear** (a line or two in your instructions or a skill, a command a
  skill gets wrong): open the pull request first, so the post carries its link. Don't offer to
  open it: the pull request is the offer. Its check-ins (the pr-lifecycle skill) go in the
  post's thread, not the one you were in: open it, post, then schedule them on the post.
- **This thread can't push to the factory's repo** (it came from another repo's PR or issue):
  the post is all you do. Say the fix is ready to open, so one word there gets it.
- **Bigger, or a matter of taste:** the post is the proposal. Build it when someone in that
  thread says to.
- **Only a person can do it** (a scope on the Slack app, a key's permission): say who, with the
  link to the exact page.
