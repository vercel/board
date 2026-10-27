import assert from "node:assert/strict";
import { test } from "node:test";
import { REFRESH_LEAD_MS, expiresAt, stale } from "../app/api/board/[[...path]]/tokens.ts";

const MIN = 60_000;

test("expiresAt: a JWT's exp, in milliseconds", () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1_791_394_851 })).toString("base64url");
  assert.equal(expiresAt(`e30.${payload}.sig`), 1_791_394_851_000);
});

test("stale: a sandbox's tokens are replaced in their last minutes, or when it has none, and not before", () => {
  const now = Date.now();
  // A function's token reused for 90 of its 120 minutes: 30 left, so a long turn replaces it 15 in.
  assert.equal(stale(now + 30 * MIN, now), false);
  assert.equal(stale(now + 30 * MIN, now + 30 * MIN - REFRESH_LEAD_MS), true);
  assert.equal(stale(0, now), true);
});
