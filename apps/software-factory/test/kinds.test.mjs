import assert from "node:assert/strict";
import { test } from "node:test";
import { isEveKind } from "../app/api/board/[[...path]]/kinds.ts";

test("every kind but noise goes to Eve, a request for Eve to do something included", () => {
  // Board #1550: "i'll need a recap" fit none of bug/feature/question, so triage called it noise.
  const kinds = ["bug", "feature", "question", "task", "noise", "toString"];
  assert.deepEqual(kinds.filter(isEveKind), ["bug", "feature", "question", "task"]);
});
