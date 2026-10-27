import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../skills/verify-board/scripts/verify-board", import.meta.url));

test("verify-board: a local board driven by this checkout's vb, with Eve's board credentials out of reach", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "verify-board-"));
  // Eve's environment: its vb points at the factory's board. Here that's a port nothing listens on, so a leak fails.
  const env = {
    PATH: process.env.PATH,
    VERIFY_BOARD_DIR: dir,
    BOARD_URL: "http://127.0.0.1:9/api/board",
    BOARD_TOKEN: "pi-token",
    BOARD_AS: "pi",
  };
  const run = (...args) => spawnSync(script, args, { env, encoding: "utf8" });
  t.after(() => {
    run("down", "--name", "t");
    rmSync(dir, { recursive: true, force: true });
  });

  const up = run("up", "--name", "t", "--no-build");
  assert.equal(up.status, 0, up.stderr);
  assert.match(up.stdout, /^board {2}http:\/\/127\.0\.0\.1:\d+\/api\/board$/m);
  assert.equal(run("doctor", "--name", "t").status, 0);

  const post = run("vb", "--name", "t", "post", "dev", "hello from the report");
  assert.equal(post.status, 0, post.stdout);
  const id = post.stdout.trim();
  assert.equal(run("vb", "--name", "t", "reply", id, "a reply").status, 0);
  const read = run("vb", "--name", "t", "read", id, "--json");
  const messages = read.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((m) => m.text), ["hello from the report", "a reply"]);
  // A person on the local board, not Eve's profile.
  assert.deepEqual(messages.map((m) => m.by.profile), [null, null]);

  // Paths mean what they say from where it's called, not the run's scratch repo.
  writeFileSync(join(dir, "note.txt"), "proof");
  const attach = spawnSync(script, ["vb", "--name", "t", "reply", id, "with a file", "--attach", "note.txt"], { env, encoding: "utf8", cwd: dir });
  assert.equal(attach.status, 0, attach.stdout);

  const missing = run("vb", "--name", "t", "read", "999");
  assert.equal(missing.status, 1);

  const transcript = readFileSync(join(dir, "t/transcript.txt"), "utf8");
  assert.match(transcript, /^\$ vb post dev hello\\ from\\ the\\ report\n\d+\n\[exit 0\]$/m);
  assert.match(transcript, /error: message not found: #999\n\[exit 1\]/);

  const down = run("down", "--name", "t");
  assert.equal(down.status, 0);
  assert.notEqual(run("doctor", "--name", "t").status, 0);
  assert.ok(existsSync(join(dir, "t/transcript.txt")), "the transcript outlives the board");
});

test("verify-board: --ref and --published are one or the other, and names stay plain", () => {
  const env = { PATH: process.env.PATH, VERIFY_BOARD_DIR: mkdtempSync(join(tmpdir(), "verify-board-")) };
  const both = spawnSync(script, ["up", "--ref", "origin/main", "--published", "0.9.0"], { env, encoding: "utf8" });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /^error: pick one of --ref and --published$/m);
  const bad = spawnSync(script, ["up", "--name", "../x"], { env, encoding: "utf8" });
  assert.match(bad.stderr, /^error: --name takes lowercase letters, digits, and dashes$/m);
});
