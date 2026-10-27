import assert from "node:assert/strict";
import { test } from "node:test";

// Board thread #1010: "when you post a PR you should add what triggered you…" was triaged
// noise, because triage only knew about the library, so Eve never heard about it.
const EVE_REQUEST =
  "when you post a PR you should add what triggered you to creating it (ie if a slack thread, github issue, etc) in a concise and pretty fashion";

// Against the real model; needs AI Gateway credentials: CLASSIFY_LIVE=1 pnpm test
test("live: a request about how Eve opens PRs is a feature, chatter is noise", { skip: !process.env.CLASSIFY_LIVE }, async () => {
  const { classifyThread } = await import("../app/api/board/[[...path]]/classify.ts");
  const kind = (text) => classifyThread([{ from: "Martin Sione", text }]);
  assert.equal(await kind(EVE_REQUEST), "feature");
  assert.equal(await kind("thanks! looks great"), "noise");
  assert.equal(await kind("vb read crashes when a thread has an attachment"), "bug");
});
