# model

A TLA+ model of per-channel access, checked by TLC. It covers the design
where each principal gets `read`, `post`, `react`, `label`, `sync`, or
`manage` per channel, and every check runs against the channel the board
looked up itself. The board doesn't enforce this yet: the model checks the
design before it's built.

```bash
pnpm model    # or model/check.sh
```

It uses `java` when it's on your `PATH`, and otherwise a pinned Temurin JRE in
Docker. `tla2tools.jar` is pinned to 1.7.4 and its sha256, and cached in
`~/.cache/vboard-model`. CI runs it as the `model` job.

## What's modeled

`Access.tla` is a board with three channels (`a`, `a/b`, `c`), three
principals, and every write.

| Principal | `can` | Stands for |
|---|---|---|
| `owner` | `{ '*': ['manage'] }` | a person, or the board's own production deployment |
| `pi` | `{ '*': ['manage'] }`, scoped to `a/=read,post,react,label` and `a/b=read,sync` | the factory behind Pi's proxy, which sets `x-board-scope` |
| `intake` | `{ 'a/': ['post'], 'a/b': [], 'c': ['react'] }` | another project in `access`: write-only in `a/`, nothing in `a/b`, react in `c` |

Intake's config can change while the board runs, losing one permission, the
way a redeploy would.

The state is the messages (channel, thread root, author, labels, reactions,
whether it's live), the schedules (creator, channel, root, pending, sent,
canceled, or revoked), and the config. The steps are post, reply, react,
label, sync, edit, delete, schedule, a schedule firing, cancel, and a config
change. Reads change nothing, so they aren't steps: every read any principal
could make (by ID, a thread, the feed, schedules) is checked in every
reachable state instead.

The model keeps two things apart. `Grants` is the board's evaluator, the code
under test; `Entitled` is what the design says. `Decide` is the board's answer
to a request, built only from `Grants` and the board's own lookups, the way
the handlers are, and the properties compare it with `Entitled`.

## How it maps to the code

| In the model | In the board |
|---|---|
| `TrueImplies`, `Close` | the implications table (`ACTION_IMPLICATIONS` in Vercel's git credential broker) |
| `At`, `Rank` | matching `access` patterns: `*`, a channel, or a subtree; the most specific wins |
| `Grants` | `authorize(principal, permission, channel)`, with `x-board-scope` intersected |
| `Readable`, `Observed` | `FeedProjection.step` and `compileFilter` in `server/feed.ts` |
| `OnMessage` | `liveMessage` in `server/writes.ts`: look up, 404 unless readable, then check |
| `Reply` | a reply's channel comes from its root, never the body |
| `Fire` | a scheduled send in `server/schedules.ts`, re-checked with the creator's current access |

## What TLC checks

`Access.cfg` must hold:

- `NoLeak`: nobody observes a message or schedule in a channel they can't read.
- `WritesAllowed`: every accepted write lands where its author has what it
  needs. A reply needs `post` and `read`; `react`, `label`, and `sync` need
  their permission and `read`.
- `OnlyAuthorsEdit`: only authors edit or delete.
- `NotFoundUnlessReadable`: anything the caller can't read answers 404.
- `FireAllowed`: a schedule never sends with more than its creator has when
  it fires.
- `ScopeOnlyNarrows`: `x-board-scope` never adds to a grant.
- `ThreadsStayInChannel`: a reply is in its root's channel.
- `RevokedSchedulesEnd`: no schedule stays pending forever once its creator
  loses access (with weak fairness on firing).
- No deadlock. A bounded board that is full, with nothing pending, ends by
  stuttering.

`Witness.cfg` checks there are no dead grants: every permission the config
gives someone is exercised in some reachable state. Reachability is the
negation of an invariant, so TLC proves it by violating one. `Unused` adds
the permissions exercised in each state to a TLC register and is violated
once the register holds every one the config grants. If TLC finishes without
violating it, some grant can never be used. Registers are per worker, so this
run uses one.

`View` leaves labels, reactions, edits, and sync marks out of TLC's
fingerprint. No decision, lookup, or property reads them, so states that
differ only there behave the same, and the state space stays near 90,000.

## Counterfactuals

Each config in `counterfactuals/` turns on one planted bug, and must fail.
Its `expect:` line says how.

| Config | The bug | Fails |
|---|---|---|
| `ReplyChecksBody` | a reply is authorized against the channel its body names | `WritesAllowed`: pi, scoped to `a/`, replies in `c` |
| `ReactWithoutRead` | `react` doesn't imply `read` | no dead grants: the lookup keeps it safe, so intake's `react` in `c` can never be used |
| `FireWithCreationAccess` | a schedule fires with its creator's access when it was made | `FireAllowed`: intake loses `post` and its schedule still sends |
| `ScopeUnion` | `x-board-scope` is unioned instead of intersected | `NoLeak`: pi reads `c` |
| `EditByAnyone` | edit and delete skip the author check | `OnlyAuthorsEdit` |
| `PostNeedsRead` | starting a thread also needs `read` | no dead grants: write-only `post` can never be used |
| `FireWaitsWhenRevoked` | a revoked schedule waits instead of being canceled | `RevokedSchedulesEnd` |

`Witness.cfg` and the two dead-grant counterfactuals check each other: an
`Unused` that is never violated fails `Witness.cfg`, and one that always is
fails the counterfactuals.
