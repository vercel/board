import assert from "node:assert/strict";
import { test } from "node:test";
import { INSTRUCTIONS } from "../app/api/board/[[...path]]/agent.ts";

for (const task of ["thread", "review"]) {
  test(`${task}: replies are tight, with no list of what Pi ran`, () => {
    const prompt = INSTRUCTIONS[task];
    assert.doesNotMatch(prompt, /what you ran/i);
    assert.match(prompt, /lead with the answer/i);
  });
}

test("review: the detail goes on the PR as review comments, the board gets a summary", () => {
  assert.match(INSTRUCTIONS.review, /gh api .*pulls\/<N>\/reviews/);
});
