---
name: test-behavior
description: "Check that a test tests something: it fails when the behavior it claims breaks, and keeps passing when only the internals change. Use whenever you write, change, or keep a test, and on every test in a PR you review."
---

# Test behavior, not implementation

From pstack's [principle-test-behavior-not-implementation](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-test-behavior-not-implementation/SKILL.md).

A test is a claim about what the code does for its users: a caller, an end user, or another service. Behavior is what those users can observe through the interface they use. That includes return values, errors, state they can read back, and effects on systems outside the code, such as a request sent, a row written, or a message emitted. Implementation is what they cannot observe: private helpers, internal call order, intermediate data, and which internal collaborator did the work.

Judge each test against two imagined edits:

- **Break the behavior.** Make the code return a wrong value, skip an effect, or do the effect twice. If the test still passes, it proves nothing. The usual causes are an assertion looser than the contract, an expected value computed by the code under test, a restated constant or prompt string that never runs the code that reads it, and an assertion on data that the test built itself.
- **Change the internals.** Keep every observable result the same and restructure the code underneath. If the test now fails, it is pinned to the implementation. It will need a rewrite on every refactor and still catches no bug.

Keep a test that catches the first edit and survives the second. Rewrite or delete the rest. To write a test that does both, drive the code through its users' interface with a concrete input. Derive the expected value from the requirement, not from a run of the code. Assert what the contract promises, no less and no more.

The contract decides, not the shape of the assertion. When "an empty cart never charges" is the promise, an assertion that the payment client got no call is behavior. Pair it with a case where the charge happens, so that the test shows it can see a call. The payload that a mocked external service receives is behavior, because that service observes it. A call to an internal helper is implementation, because no user can see it. An empty list is the exact answer when no record matches, and a hollow check when the test only needs some result. An exact error message pins wording that no caller reads. The error type that callers branch on is the contract.

A test can pin an invariant instead of a call, such as a key that must exist in two tables or a compile-time type check. The invariant is the behavior.

## In board

- Don't make the first edit in your head when you can make it for real: break the line the test is about, run the test, and see it fail. A test you never saw fail is a guess. That's for your own code: in someone else's PR, don't run its tests (they'd run with your credentials); make the edit in your head and point at the line it would break.
- Asserting that a prompt or instructions string contains a phrase (`assert.match(INSTRUCTIONS.review, /…/)`) restates the string: it breaks on a reword and catches no behavior. Test what reads the string, or don't test it.
- A watcher's behavior is what it writes to the board and what reaches Slack or GitHub. Assert those (the reply's text, the label set, the post Slack gets), not the order of the calls that made them.
