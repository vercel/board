------------------------------- MODULE Access -------------------------------
(***************************************************************************)
(* Per-channel access for a vboard board: each principal gets permissions  *)
(* per channel from `access`, and every check runs against the channel     *)
(* the board looked up itself.                                             *)
(*                                                                         *)
(* The board holds messages and schedules in three channels. Three         *)
(* principals call it: the owner (a person or the board's own production   *)
(* deployment), pi (the factory's identity behind a proxy that sets        *)
(* x-board-scope), and intake (another project, configured in `access`).   *)
(* Intake's config can change under it, losing permissions.                *)
(*                                                                         *)
(* Two things are kept apart:                                              *)
(*   Grants(p, ch)   what the board's evaluator says, the code under test  *)
(*   Entitled(p, ch) what the spec says p may do                           *)
(* Decide(r) is the board's answer to request r, built only from Grants    *)
(* and the board's own lookups, the way the handlers are. The safety       *)
(* properties compare it with Entitled. Each CONSTANT switch plants one    *)
(* bug in the board; the counterfactual configs turn one on and expect     *)
(* TLC to find it.                                                         *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
  MaxMsgs,     \* messages the board can hold (scheduled sends reserve one)
  MaxScheds,   \* schedules that can be created
  MaxChanges,  \* config changes (a source losing a permission)
  \* Planted bugs. All FALSE in Access.cfg.
  ReplyChecksBody,         \* a reply is authorized against the body's channel, not its root's
  ReactWithoutRead,        \* the IMPLIES table drops react => read
  FireWithCreationAccess,  \* a schedule fires with the access its creator had when it was made
  ScopeUnion,              \* x-board-scope is unioned with the grant instead of intersected
  EditByAnyone,            \* edit and delete skip the author check
  PostNeedsRead,           \* starting a thread also needs read, so write-only can't post
  FireWaitsWhenRevoked     \* a schedule whose creator lost access waits instead of being revoked

ASSUME MaxMsgs \in Nat /\ MaxScheds \in Nat /\ MaxChanges \in Nat

-----------------------------------------------------------------------------
(* Permissions, and one table of what each implies (ACTION_IMPLICATIONS).  *)

Perms == {"read", "post", "react", "label", "sync", "manage"}

TrueImplies == [x \in Perms |->
  CASE x = "manage" -> Perms \ {"manage"}
    [] x \in {"react", "label", "sync"} -> {"read"}
    [] OTHER -> {}]

BoardImplies == [x \in Perms |->
  IF x = "react" /\ ReactWithoutRead THEN {} ELSE TrueImplies[x]]

\* One hop is enough because the table is closed; the model checks that.
Close(table, S) == S \cup UNION {table[x] : x \in S}
ASSUME \A S \in SUBSET Perms : Close(TrueImplies, Close(TrueImplies, S)) = Close(TrueImplies, S)

-----------------------------------------------------------------------------
(* Channels and patterns: '*', a channel, or a channel and its subtree.    *)
(* The most specific matching pattern decides (`vb tail a/` semantics).    *)

Channels == {"a", "a/b", "c"}

IsSubtree(pat) == pat # "*" /\ SubSeq(pat, Len(pat), Len(pat)) = "/"
Matches(pat, ch) ==
  \/ pat = "*"
  \/ pat = ch
  \/ /\ IsSubtree(pat)
     /\ \/ SubSeq(pat, 1, Len(pat) - 1) = ch
        \/ Len(ch) > Len(pat) /\ SubSeq(ch, 1, Len(pat)) = pat
\* '*' < 'a/' < 'a' < 'a/b/' < 'a/b': an exact channel beats its own subtree.
Rank(pat) == IF pat = "*" THEN 0 ELSE IF IsSubtree(pat) THEN 2 * Len(pat) - 3 ELSE 2 * Len(pat)

\* The permissions a channel map gives in ch, before implications.
At(map, ch) ==
  LET ms == {q \in DOMAIN map : Matches(q, ch)}
  IN IF ms = {} THEN {} ELSE map[CHOOSE q \in ms : \A o \in ms : Rank(o) <= Rank(q)]

-----------------------------------------------------------------------------
(* The board's config: `access` in code, and pi's proxy header.            *)

Principals == {"owner", "pi", "intake"}
Sources == {"intake"}   \* principals whose config can change

InitCan == [p \in Principals |->
  CASE p = "intake" -> ("a/" :> {"post"}) @@ ("a/b" :> {}) @@ ("c" :> {"react"})
    [] OTHER -> ("*" :> {"manage"})]

\* x-board-scope: dev/=read,post,react,label, set by pi's network policy.
Scope == ("pi" :> (("a/" :> {"read", "post", "react", "label"}) @@ ("a/b" :> {"read", "sync"})))

-----------------------------------------------------------------------------
VARIABLES
  msgs,     \* Seq of [ch, root (0 for a root), by, live, edited, labels, reactions, synced]
  scheds,   \* Seq of [by, ch, re (0 for a root), status, snap]
  can,      \* the live config: principal -> pattern -> permissions
  changes   \* config changes so far

vars == <<msgs, scheds, can, changes>>

\* The spec: the grant closed by the true table, intersected with any scope.
Entitled(p, ch) ==
  LET g == Close(TrueImplies, At(can[p], ch))
  IN IF p \in DOMAIN Scope THEN g \cap Close(TrueImplies, At(Scope[p], ch)) ELSE g

\* The board's evaluator (authorize): the same, with the planted bugs.
GrantsWith(c, p, ch) ==
  LET g == Close(BoardImplies, At(c[p], ch))
  IN IF p \notin DOMAIN Scope THEN g
     ELSE LET s == Close(BoardImplies, At(Scope[p], ch))
          IN IF ScopeUnion THEN g \cup s ELSE g \cap s
Grants(p, ch) == GrantsWith(can, p, ch)

-----------------------------------------------------------------------------
(* Lookups the board does itself.                                          *)

Ids == 1..MaxMsgs
SIds == 1..MaxScheds

Exists(m) == m \in DOMAIN msgs /\ msgs[m].live
Ch(m) == msgs[m].ch
Root(m) == IF msgs[m].root = 0 THEN m ELSE msgs[m].root
Readable(p, m) == "read" \in Grants(p, Ch(m))
Pending == {i \in DOMAIN scheds : scheds[i].status = "pending"}
Room == Len(msgs) + Cardinality(Pending) < MaxMsgs

-----------------------------------------------------------------------------
(* Reads change nothing, so they're not steps. Every read any principal    *)
(* could make is checked in every reachable state instead. Each goes       *)
(* through Readable, the model's FeedProjection.step and compileFilter.   *)

ById(p, m) == IF Exists(m) /\ Readable(p, m) THEN {m} ELSE {}
\* A thread checks its root; its replies are in the root's channel.
Thread(p, m) ==
  IF Exists(m) /\ msgs[m].root = 0 /\ Readable(p, m)
  THEN {m} \cup {n \in DOMAIN msgs : msgs[n].root = m /\ msgs[n].live}
  ELSE {}
Feed(p) == {m \in DOMAIN msgs : msgs[m].live /\ Readable(p, m)}
Observed(p) == Feed(p) \cup UNION {ById(p, m) \cup Thread(p, m) : m \in DOMAIN msgs}
Schedules(p) == {i \in Pending : "read" \in Grants(p, scheds[i].ch)}

-----------------------------------------------------------------------------
(* Writes. A request names what the caller sent; the board looks up the    *)
(* target and checks the channel it found.                                 *)

Requests ==
       [kind : {"post"}, by : Principals, ch : Channels, labeled : BOOLEAN]
  \cup [kind : {"reply"}, by : Principals, re : Ids, ch : Channels]
  \cup [kind : {"react", "label", "sync", "edit", "delete"}, by : Principals, msg : Ids]
  \cup [kind : {"schedule"}, by : Principals, re : {0} \cup Ids, ch : Channels]
  \cup [kind : {"cancel"}, by : Principals, sched : SIds]
  \cup [kind : {"admin"}, by : Principals]

PostNeeds(labeled) ==
  {"post"} \cup (IF labeled THEN {"label"} ELSE {}) \cup (IF PostNeedsRead THEN {"read"} ELSE {})

\* writes.ts liveMessage: 404 unless the caller can read it, then the permission.
OnMessage(p, m, need) ==
  IF ~(Exists(m) /\ Readable(p, m)) THEN "404"
  ELSE IF need \subseteq Grants(p, Ch(m)) THEN "ok" ELSE "403"

\* A reply resolves its root and checks post and read there.
Reply(p, m, bodyCh) ==
  IF ReplyChecksBody
  THEN IF ~(Exists(m) /\ Exists(Root(m))) THEN "404"
       ELSE IF {"post", "read"} \subseteq Grants(p, bodyCh) THEN "ok" ELSE "403"
  ELSE IF ~Exists(m) THEN "404" ELSE OnMessage(p, Root(m), {"post"})

Decide(r) ==
  CASE r.kind = "post" ->
         IF ~Room THEN "full"
         ELSE IF PostNeeds(r.labeled) \subseteq Grants(r.by, r.ch) THEN "ok" ELSE "403"
    [] r.kind = "reply" -> IF ~Room THEN "full" ELSE Reply(r.by, r.re, r.ch)
    [] r.kind \in {"react", "label", "sync"} -> OnMessage(r.by, r.msg, {r.kind})
    [] r.kind \in {"edit", "delete"} ->
         IF ~Exists(r.msg) THEN "404"
         ELSE IF ~EditByAnyone /\ msgs[r.msg].by # r.by
              THEN IF Readable(r.by, r.msg) THEN "403" ELSE "404"
         ELSE IF "post" \in Grants(r.by, Ch(r.msg)) THEN "ok" ELSE "403"
    [] r.kind = "schedule" ->
         IF ~Room \/ Len(scheds) >= MaxScheds THEN "full"
         ELSE IF r.re # 0 THEN Reply(r.by, r.re, r.ch)
         ELSE IF PostNeeds(FALSE) \subseteq Grants(r.by, r.ch) THEN "ok" ELSE "403"
    [] r.kind = "cancel" ->
         IF r.sched \notin Pending THEN "404"
         ELSE IF scheds[r.sched].by = r.by THEN "ok"
         ELSE IF "read" \notin Grants(r.by, scheds[r.sched].ch) THEN "404"
         ELSE IF "manage" \in Grants(r.by, scheds[r.sched].ch) THEN "ok" ELSE "403"
    [] r.kind = "admin" ->
         IF \A ch \in Channels : "manage" \in Grants(r.by, ch) THEN "ok" ELSE "403"

\* Where a write lands: always the channel the board looked up.
Lands(r) ==
  CASE r.kind = "post" -> {r.ch}
    [] r.kind = "reply" -> {Ch(Root(r.re))}
    [] r.kind = "schedule" -> IF r.re = 0 THEN {r.ch} ELSE {Ch(Root(r.re))}
    [] r.kind = "cancel" -> {scheds[r.sched].ch}
    [] r.kind = "admin" -> Channels
    [] OTHER -> {Ch(r.msg)}

\* What the spec says each write needs where it lands.
Needs(r) ==
  CASE r.kind = "post" -> {"post"} \cup (IF r.labeled THEN {"label"} ELSE {})
    [] r.kind = "reply" -> {"post", "read"}
    [] r.kind \in {"react", "label", "sync"} -> {r.kind, "read"}
    [] r.kind \in {"edit", "delete"} -> {"post"}
    [] r.kind = "schedule" -> IF r.re = 0 THEN {"post"} ELSE {"post", "read"}
    [] r.kind = "cancel" -> IF scheds[r.sched].by = r.by THEN {} ELSE {"manage"}
    [] r.kind = "admin" -> {"manage"}

\* The permissions an accepted request exercises, for the witness check.
Uses(r) ==
  CASE r.kind \in {"react", "label", "sync"} -> {r.kind}
    [] OTHER -> Needs(r)

-----------------------------------------------------------------------------
(* Schedules fire with their creator's current access (schedules.ts).      *)

SchedNeeds(i) == PostNeeds(FALSE) \cup (IF scheds[i].re = 0 THEN {} ELSE {"read"})
FireAccess(i) ==
  IF FireWithCreationAccess THEN scheds[i].snap ELSE Grants(scheds[i].by, scheds[i].ch)
CanSend(i) ==
  /\ SchedNeeds(i) \subseteq FireAccess(i)
  /\ scheds[i].re = 0 \/ Exists(scheds[i].re)

NewMsg(ch, root, by, labels) ==
  [ch |-> ch, root |-> root, by |-> by, live |-> TRUE, edited |-> FALSE,
   labels |-> labels, reactions |-> {}, synced |-> FALSE]

Toggle(S, x) == IF x \in S THEN S \ {x} ELSE S \cup {x}

-----------------------------------------------------------------------------
(* Steps.                                                                  *)

Init ==
  /\ msgs = <<>>
  /\ scheds = <<>>
  /\ can = InitCan
  /\ changes = 0

\* Apply an accepted write.
Apply(r) ==
  /\ UNCHANGED <<can, changes>>
  /\ CASE r.kind = "post" ->
            /\ msgs' = Append(msgs, NewMsg(r.ch, 0, r.by, IF r.labeled THEN {"kind"} ELSE {}))
            /\ UNCHANGED scheds
       [] r.kind = "reply" ->
            /\ msgs' = Append(msgs, NewMsg(Ch(Root(r.re)), Root(r.re), r.by, {}))
            /\ UNCHANGED scheds
       [] r.kind = "react" ->
            /\ msgs' = [msgs EXCEPT ![r.msg].reactions = Toggle(@, r.by)]
            /\ UNCHANGED scheds
       [] r.kind = "label" ->
            /\ msgs' = [msgs EXCEPT ![r.msg].labels = Toggle(@, "kind")]
            /\ UNCHANGED scheds
       [] r.kind = "sync" ->
            /\ msgs' = [msgs EXCEPT ![Root(r.msg)].synced = TRUE]
            /\ UNCHANGED scheds
       [] r.kind = "edit" ->
            /\ msgs' = [msgs EXCEPT ![r.msg].edited = TRUE]
            /\ UNCHANGED scheds
       [] r.kind = "delete" ->
            /\ msgs' = [msgs EXCEPT ![r.msg].live = FALSE]
            /\ UNCHANGED scheds
       [] r.kind = "schedule" ->
            /\ LET ch == IF r.re = 0 THEN r.ch ELSE Ch(Root(r.re))
                   re == IF r.re = 0 THEN 0 ELSE Root(r.re)
               IN scheds' = Append(scheds,
                    [by |-> r.by, ch |-> ch, re |-> re, status |-> "pending",
                     snap |-> Grants(r.by, ch)])
            /\ UNCHANGED msgs
       [] r.kind = "cancel" ->
            /\ scheds' = [scheds EXCEPT ![r.sched].status = "canceled"]
            /\ UNCHANGED msgs
       [] r.kind = "admin" -> UNCHANGED <<msgs, scheds>>

Write(r) == Decide(r) = "ok" /\ Apply(r)

\* A due schedule sends as its creator, or is canceled with `revoked`.
Fire(i) ==
  /\ i \in Pending
  /\ CanSend(i) \/ ~FireWaitsWhenRevoked
  /\ IF CanSend(i)
     THEN /\ msgs' = Append(msgs, NewMsg(scheds[i].ch, scheds[i].re, scheds[i].by, {}))
          /\ scheds' = [scheds EXCEPT ![i].status = "sent"]
     ELSE /\ scheds' = [scheds EXCEPT ![i].status = "revoked"]
          /\ UNCHANGED msgs
  /\ UNCHANGED <<can, changes>>

\* A redeploy takes a permission away from a source.
Revoke(p, pat, x) ==
  /\ changes < MaxChanges
  /\ x \in can[p][pat]
  /\ can' = [can EXCEPT ![p][pat] = @ \ {x}]
  /\ changes' = changes + 1
  /\ UNCHANGED <<msgs, scheds>>

\* The bounded board is full and nothing is pending: the behavior can end.
Done == ~Room /\ Pending = {} /\ UNCHANGED vars

Next ==
  \/ \E r \in Requests : Write(r)
  \/ \E i \in SIds : Fire(i)
  \/ \E p \in Sources : \E pat \in DOMAIN can[p] : \E x \in Perms : Revoke(p, pat, x)
  \/ Done

Spec == Init /\ [][Next]_vars /\ \A i \in SIds : WF_vars(Fire(i))

\* What TLC fingerprints. Labels, reactions, edits, and sync marks are in the
\* state, but no decision, lookup, or property reads them, so states that
\* differ only there behave the same. Leaving them out of the view keeps the
\* state space small without changing what's reachable or what's checked.
View ==
  <<[m \in DOMAIN msgs |-> <<msgs[m].ch, msgs[m].root, msgs[m].by, msgs[m].live>>],
    scheds, can, changes>>

-----------------------------------------------------------------------------
(* Safety.                                                                 *)

TypeOK ==
  /\ Len(msgs) <= MaxMsgs /\ Len(scheds) <= MaxScheds
  /\ \A m \in DOMAIN msgs :
       /\ msgs[m].ch \in Channels /\ msgs[m].by \in Principals
       /\ msgs[m].root \in 0..(m - 1)
  /\ \A i \in DOMAIN scheds : scheds[i].status \in {"pending", "sent", "canceled", "revoked"}
  /\ changes <= MaxChanges

\* A reply is in its root's channel, so checking a thread's root covers it.
ThreadsStayInChannel ==
  \A m \in DOMAIN msgs : msgs[m].root # 0 => msgs[m].ch = msgs[msgs[m].root].ch

\* Nobody observes a message, or a schedule, in a channel they can't read.
NoLeak ==
  \A p \in Principals :
    /\ \A m \in Observed(p) : "read" \in Entitled(p, Ch(m))
    /\ \A i \in Schedules(p) : "read" \in Entitled(p, scheds[i].ch)

\* Every accepted write lands where its author has what it needs.
WritesAllowed ==
  \A r \in Requests :
    Decide(r) = "ok" => \A ch \in Lands(r) : Needs(r) \subseteq Entitled(r.by, ch)

\* Only authors edit or delete.
OnlyAuthorsEdit ==
  \A r \in Requests :
    r.kind \in {"edit", "delete"} /\ Decide(r) = "ok" => msgs[r.msg].by = r.by

\* Anything the caller can't read answers 404, so no answer confirms it
\* exists. Authors know their own messages, and creators their schedules.
NotFoundUnlessReadable ==
  \A r \in Requests :
    Decide(r) \in {"ok", "403"} =>
      CASE r.kind \in {"react", "label", "sync"} -> Readable(r.by, r.msg)
        [] r.kind \in {"edit", "delete"} -> Readable(r.by, r.msg) \/ msgs[r.msg].by = r.by
        [] r.kind \in {"reply", "schedule"} /\ r.re # 0 -> Readable(r.by, Root(r.re))
        [] r.kind = "cancel" ->
             "read" \in Grants(r.by, scheds[r.sched].ch) \/ scheds[r.sched].by = r.by
        [] OTHER -> TRUE

\* A schedule never sends with more than its creator has at fire time.
FireAllowed ==
  \A i \in Pending :
    CanSend(i) => SchedNeeds(i) \subseteq Entitled(scheds[i].by, scheds[i].ch)

\* x-board-scope only narrows.
ScopeOnlyNarrows ==
  \A p \in Principals, ch \in Channels :
    /\ Grants(p, ch) \subseteq Close(TrueImplies, At(can[p], ch))
    /\ p \in DOMAIN Scope => Grants(p, ch) \subseteq Close(TrueImplies, At(Scope[p], ch))

-----------------------------------------------------------------------------
(* Liveness: no schedule stays pending after its creator loses access.     *)

Revoked(i) ==
  /\ i \in Pending
  /\ ~(SchedNeeds(i) \subseteq Entitled(scheds[i].by, scheds[i].ch))
Ended(i) == i \in DOMAIN scheds /\ scheds[i].status # "pending"
RevokedSchedulesEnd == \A i \in SIds : Revoked(i) ~> Ended(i)

-----------------------------------------------------------------------------
(* No dead grants: every permission the config gives someone is exercised  *)
(* in some reachable state.                                                *)
(*                                                                         *)
(* "Some reachable state has X" is the negation of an invariant, so TLC    *)
(* proves it by violating one. Unused folds the triples exercised in each  *)
(* state into TLC register 1 and is violated once the register holds every *)
(* triple the config grants. Witness.cfg must see it violated; if TLC      *)
(* finishes without that, some grant can never be used. TLC registers are  *)
(* per worker, so these runs use one worker.                               *)

Held ==
  {<<p, x, ch>> \in Principals \X Perms \X Channels : x \in GrantsWith(InitCan, p, ch)}

UsedNow ==
  UNION {{<<p, "read", Ch(m)>> : m \in Observed(p)} : p \in Principals}
  \cup UNION {{<<r.by, x, ch>> : x \in Uses(r), ch \in Lands(r)} :
              r \in {q \in Requests : Decide(q) = "ok"}}

ASSUME TLCSet(1, {})
Unused ==
  LET used == TLCGet(1) \cup UsedNow
  IN TLCSet(1, used) /\ ~(Held \subseteq used)

=============================================================================
