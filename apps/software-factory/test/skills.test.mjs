import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { piAvatar, piFiles, piName, piPreview, policy } from "../app/api/board/[[...path]]/agent.ts";
import { routes } from "../../../packages/vboard/src/api/routes.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "skills/ui-video/scripts/ui-video");
const tokens = { gateway: "g", board: "b", github: "h" };

test("piFiles: the ui-video, verify-vboard, sitrep and pr-description skills and the computer tool go in Pi's home, scripts executable", async () => {
  const files = await piFiles(root);
  const home = "/home/vercel-sandbox/.pi/agent";
  assert.deepEqual(
    files.map((f) => [f.path, f.mode]),
    [
      [`${home}/skills/ui-video/SKILL.md`, 0o644],
      [`${home}/skills/ui-video/scripts/ui-video`, 0o755],
      [`${home}/skills/verify-vboard/SKILL.md`, 0o644],
      [`${home}/skills/verify-vboard/scripts/verify-vboard`, 0o755],
      [`${home}/skills/sitrep/SKILL.md`, 0o644],
      [`${home}/skills/pr-description/SKILL.md`, 0o644],
      [`${home}/extensions/computer/index.ts`, 0o644],
      [`${home}/extensions/computer/xinput.py`, 0o755],
    ],
  );
  assert.match(String(files[0].content), /^---\nname: ui-video\ndescription: .+\n---\n/);
  assert.match(String(files[2].content), /^---\nname: verify-vboard\ndescription: .+\n---\n/);
  assert.match(String(files[4].content), /^---\nname: sitrep\ndescription: .+\n---\n/);
  assert.match(String(files[5].content), /^---\nname: pr-description\ndescription: .+\n---\n/);
  assert.match(String(files[6].content), /registerTool\(computer\)/);
});

test("policy: Pi's own branch preview gets past Vercel Authentication, and no other deployment sees the secret", () => {
  const allow = policy(3100, tokens, "s3cret").allow;
  assert.equal(piPreview(3100), "vboard-factory-git-pi-3100.playground-vercel.tools");
  assert.deepEqual(allow[piPreview(3100)], [{ transform: [{ headers: { "x-vercel-protection-bypass": "s3cret" } }] }]);
  const withSecret = Object.entries(allow).filter(([, rules]) => JSON.stringify(rules).includes("s3cret"));
  assert.deepEqual(withSecret.map(([host]) => host).sort(), ["vboard-factory.playground-vercel.tools", piPreview(3100)].sort());
  assert.deepEqual(allow["*"], []);
  assert.equal(policy(3100, tokens, undefined).allow[piPreview(3100)], undefined);
});

// The headers the sandbox's proxy adds to a request for `path` on `host`, as it reads a rule's path match.
function sent(allow, host, path) {
  const rules = (allow[host] ?? []).filter((rule) => !rule.match?.path || new RegExp(rule.match.path.regex).test(path));
  return Object.assign({}, ...rules.flatMap((rule) => rule.transform.map((t) => t.headers)));
}

test("policy: Pi's credentials and identity reach every board route vb calls, and nothing else on the board's host", () => {
  const allow = policy(3100, tokens, "s3cret").allow;
  const host = "vboard-factory.playground-vercel.tools";
  const pi = {
    authorization: "Bearer b",
    "x-board-profile": piName(3100),
    "x-board-avatar": piAvatar(3100),
    "x-board-session": "thread-3100",
    "x-vercel-protection-bypass": "s3cret",
  };
  const vb = new Set([
    "discovery",
    "me",
    "channels",
    "actors",
    "messages",
    "message",
    "threads",
    "events",
    "post",
    "edit",
    "delete",
    "react",
    "label",
    "sync",
    "typing",
    "schedule",
    "schedules",
    "cancelSchedule",
    "upload",
    "attachment",
  ]);
  const params = { id: "42", key: "slack", name: "pi" };
  for (const [name, route] of Object.entries(routes)) {
    const path = `/api/board${route.path.replace(/:(\w+)/g, (_, param) => params[param])}`;
    assert.deepEqual(sent(allow, host, path), vb.has(name) ? pi : {}, `${name} ${path}`);
  }
  for (const path of ["/api/board/", "/api/board/schedules/s42/cancel", "/api/board/attachments/att_x-1"]) {
    assert.deepEqual(sent(allow, host, path), pi, path);
  }
  for (const path of [
    "/api/board/attachments/x%2F..%2F..%2Fstuck",
    "/api/board/attachments/x%5C..%5C..%5Cstuck",
    "/api/board/messages/1\\..\\..\\stuck",
    "/api/board/webhooks/slack",
    "/api/board/webhooks/github",
    "/api/board/me/webhooks/slack",
    "/api/board/messages/1/../../webhooks/slack",
    "/api/a2/scheduler",
    "/",
    "/sync/slack",
  ]) {
    assert.deepEqual(sent(allow, host, path), {}, path);
  }
});

test("policy: Pi's GitHub API calls always carry the factory GitHub App's token", () => {
  assert.deepEqual(policy(3100, tokens, undefined).allow["api.github.com"], [
    { transform: [{ headers: { authorization: "Bearer h" } }] },
  ]);
});

// ui-video is for Pi's Linux sandbox: an X11 desktop, bash 4, and GNU date and stat. Elsewhere (macOS) it can't run.
const onLinux = process.platform === "linux" ? {} : { skip: "ui-video runs only on Linux (Pi's sandbox)" };

// ui-video with fake Xvfb, ffmpeg and AI Gateway: what it records, which captions it burns in, and when.
function recorder() {
  const dir = mkdtempSync(join(tmpdir(), "ui-video-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const fake = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const display = 1000 + Math.floor(Math.random() * 8000);
  fake("Xvfb", `mkdir -p /tmp/.X11-unix; touch /tmp/.X11-unix/X${display}; echo "$@" >> "${dir}/xvfb.log"; sleep 30`);
  // Recording (x11grab) runs until interrupted, then leaves the take. ffmpeg -i <clip> reads a 0.2 s clip.
  // Encoding writes FAKE_SIZE bytes to the last argument.
  fake(
    "ffmpeg",
    `[[ " $* " == *" -hide_banner "* ]] && { echo "  Duration: 00:00:00.20, start: 0.000000" >&2; exit 1; }
echo "$@" >> "${dir}/ffmpeg.log"
if [[ " $* " == *" x11grab "* ]]; then
  trap 'echo take > "\${@: -1}"; exit 0' TERM; while :; do sleep 0.05; done
fi
head -c "\${FAKE_SIZE:-1000}" /dev/zero > "\${@: -1}"`,
  );
  // AI Gateway's speech model: logs each request, and answers with "mp3" bytes unless FAKE_TTS=fail.
  fake("curl", `echo "$@" >> "${dir}/curl.log"; [ "$FAKE_TTS" = fail ] && exit 22; echo '{"audio":"bXAz"}'`);
  const PATH = `${bin}:${execFileSync("bash", ["-c", "echo $PATH"], { encoding: "utf8" }).trim()}`;
  const run = (args, env = {}) =>
    spawnSync(script, args, {
      env: { PATH, UI_VIDEO_DIR: join(dir, "work"), COMPUTER_DISPLAY: `:${display}`, AI_GATEWAY_API_KEY: "g", ...env },
      encoding: "utf8",
    });
  const cleanup = () => spawnSync("bash", ["-c", `pkill -f "${bin}/Xvfb"; rm -f /tmp/.X11-unix/X${display}`]);
  return { dir, run, cleanup, display };
}

const secs = (t) => {
  const [h, m, s] = t.replace(",", ".").split(":");
  return +h * 3600 + +m * 60 + +s;
};
const cues = (dir) =>
  [...readFileSync(join(dir, "work/captions.srt"), "utf8").matchAll(/(\d+)\n(\S+) --> (\S+)\n(.+)\n/g)].map((m) => ({
    from: secs(m[2]),
    to: secs(m[3]),
    text: m[4],
  }));

test("ui-video: records the desktop, starting it if needed, and captions each step until the next", onLinux, (t) => {
  const { dir, run, cleanup, display } = recorder();
  t.after(cleanup);
  const started = run(["start", "--mute"]);
  assert.equal(started.status, 0, started.stderr);
  assert.match(readFileSync(join(dir, "xvfb.log"), "utf8"), new RegExp(`^:${display} -screen 0 1280x800x24`));
  assert.match(readFileSync(join(dir, "ffmpeg.log"), "utf8"), new RegExp(`-f x11grab .*-i :${display} .*raw\\.mkv`));
  assert.equal(run(["step", "Signing in"]).status, 0);
  execFileSync("sleep", ["1"]);
  assert.equal(run(["step", 'Posting "hello"']).status, 0);
  execFileSync("sleep", ["1"]);
  const done = run(["stop", join(dir, "out.mp4")], { UI_VIDEO_LAST: "0" });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /out\.mp4: 1 KB, 2 captions, 0 narrated, 2s \(of 2s recorded\)/);
  const [first, second] = cues(dir);
  assert.deepEqual([first.text, second.text], ["Signing in", 'Posting "hello"']);
  assert.equal(first.from, 0);
  assert.equal(first.to, second.from, "a caption ends when the next starts");
  assert.ok(Math.abs(second.from - 1) < 0.3, "the second caption starts a second in");
  assert.ok(second.to - second.from >= 0.9, "the last one lasts until stop");
  assert.equal(run(["step", "too late"]).status, 1, "stop ends the recording");
  assert.match(readFileSync(join(dir, "ffmpeg.log"), "utf8"), / -an /, "a muted take has no sound");
  assert.ok(!existsSync(join(dir, "curl.log")), "and asks for no voice");
});

test("ui-video: starting over ends the take that was recording", onLinux, (t) => {
  const { dir, run, cleanup } = recorder();
  t.after(cleanup);
  run(["start", "--mute"]);
  const first = readFileSync(join(dir, "work/pid"), "utf8").trim();
  run(["start", "--mute"]);
  execFileSync("sleep", ["0.3"]);
  assert.equal(spawnSync("kill", ["-0", first]).status, 1, "the first recording isn't running anymore");
  assert.equal(run(["stop", join(dir, "out.mp4")], { UI_VIDEO_LAST: "0" }).status, 0);
});

test("ui-video: each caption is read aloud from AI Gateway, where its step starts in the cut take", onLinux, (t) => {
  const { dir, run, cleanup } = recorder();
  t.after(cleanup);
  run(["start"]);
  const t0 = Date.now();
  assert.equal(run(["step", "Signing in"]).status, 0);
  assert.ok(Date.now() - t0 >= 200, "a step waits until its line has been said");
  execFileSync("sleep", ["1.5"]);
  run(["step", 'Posting "hello"']);
  const done = run(["stop", join(dir, "out.mp4")], { UI_VIDEO_HOLD: "0.5", UI_VIDEO_LAST: "0" });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /2 captions, 2 narrated/);

  const asks = readFileSync(join(dir, "curl.log"), "utf8").trim().split("\n");
  assert.equal(asks.length, 2);
  assert.match(asks[0], /ai-gateway\.vercel\.sh\/v3\/ai\/speech-model .*ai-model-id: openai\/tts-1/);
  assert.match(asks[0], /Authorization: Bearer g/);
  assert.match(asks[1], /"text":"Posting \\"hello\\"","voice":"nova","outputFormat":"mp3"/);
  assert.equal(readFileSync(join(dir, "work/voice-1.mp3"), "utf8"), "mp3");

  // Each step keeps its 0.2 s line plus HOLD: the second line starts 0.7 s into the cut take.
  const [first, second] = cues(dir);
  assert.deepEqual([first.from, first.to, second.from], [0, 0.7, 0.7]);
  const encode = readFileSync(join(dir, "ffmpeg.log"), "utf8").trim().split("\n").pop();
  assert.match(encode, /-i \S+voice-1\.mp3 -i \S+voice-2\.mp3/);
  assert.match(encode, /\[1:a\]adelay=0:all=1\[v1\];\[2:a\]adelay=700:all=1\[v2\];\[v1\]\[v2\]amix=inputs=2/);
  assert.match(encode, /-map 0:v -map \[a\] -c:a aac/);
});

test("ui-video: a line the voice model can't say is captioned only, and the take still works", onLinux, (t) => {
  const { dir, run, cleanup } = recorder();
  t.after(cleanup);
  run(["start"]);
  const step = run(["step", "Signing in"], { FAKE_TTS: "fail" });
  assert.equal(step.status, 0);
  assert.match(step.stderr, /couldn't narrate "Signing in": it's captioned only/);
  const done = run(["stop", join(dir, "out.mp4")], { UI_VIDEO_LAST: "0" });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /1 captions, 0 narrated/);
  assert.match(readFileSync(join(dir, "ffmpeg.log"), "utf8"), / -an /);
});

test("ui-video: UI_VIDEO_VOICE=off mutes it, and the model and voice can be picked", onLinux, (t) => {
  const off = recorder();
  t.after(off.cleanup);
  off.run(["start"], { UI_VIDEO_VOICE: "off" });
  off.run(["step", "Signing in"]);
  assert.ok(!existsSync(join(off.dir, "curl.log")));

  const { dir, run, cleanup } = recorder();
  t.after(cleanup);
  const env = { UI_VIDEO_VOICE_MODEL: "spacexai/grok-tts", UI_VIDEO_VOICE: "eve" };
  run(["start"], env);
  run(["step", "Signing in"], env);
  const ask = readFileSync(join(dir, "curl.log"), "utf8");
  assert.match(ask, /ai-model-id: spacexai\/grok-tts/);
  assert.match(ask, /"voice":"eve"/);
  run(["stop", join(dir, "out.mp4")], { UI_VIDEO_LAST: "0" });
  off.run(["stop", join(off.dir, "out.mp4")], { UI_VIDEO_LAST: "0" });
});

test("ui-video: the take cuts the time Pi spends thinking, keeping HOLD seconds after each step", onLinux, (t) => {
  const { dir, run, cleanup } = recorder();
  t.after(cleanup);
  run(["start", "--mute"]);
  run(["step", "Opening the page"]);
  execFileSync("sleep", ["1.5"]);
  run(["step", "Clicking Send"]);
  execFileSync("sleep", ["1.5"]);
  const done = run(["stop", join(dir, "out.mp4")], { UI_VIDEO_HOLD: "0.5", UI_VIDEO_LAST: "0" });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /2 captions, 0 narrated, 1s \(of 3s recorded\)/);
  assert.deepEqual(
    cues(dir).map((c) => [c.text, c.from, c.to]),
    [["Opening the page", 0, 0.5], ["Clicking Send", 0.5, 1]],
  );
  const encode = readFileSync(join(dir, "ffmpeg.log"), "utf8").trim().split("\n").pop();
  assert.match(encode, /select=between\(t\\,[\d.]+\\,[\d.]+\)\+between\(t\\,[\d.]+\\,[\d.]+\),setpts=N\/FRAME_RATE\/TB,/);
});

test("ui-video: a last step right before stop still stays on screen", onLinux, (t) => {
  const { dir, run, cleanup } = recorder();
  t.after(cleanup);
  run(["start", "--mute"]);
  run(["step", "Opening the page"]);
  execFileSync("sleep", ["0.5"]);
  run(["step", "It works"]);
  const done = run(["stop", join(dir, "out.mp4")], { UI_VIDEO_LAST: "1" });
  assert.equal(done.status, 0, done.stderr);
  const last = cues(dir).pop();
  assert.equal(last.text, "It works");
  assert.ok(last.to - last.from >= 0.95, `on screen for ${last.to - last.from}s`);
});

test("ui-video: a take too big for the board is shrunk, then refused", onLinux, (t) => {
  const { dir, run, cleanup } = recorder();
  t.after(cleanup);
  run(["start", "--mute"]);
  run(["step", "Opening the page"]);
  const tooBig = run(["stop", join(dir, "out.mp4")], { FAKE_SIZE: String(5_000_000) });
  assert.equal(tooBig.status, 1);
  assert.match(tooBig.stderr, /still over 4 MB .* record a shorter take/);
  const encodes = readFileSync(join(dir, "ffmpeg.log"), "utf8").trim().split("\n").filter((l) => !l.includes("x11grab"));
  assert.equal(encodes.length, 4, "it tries smaller encodes first");
});

test("ui-video: steps need a recording", () => {
  const { run } = recorder();
  const done = run(["step", "Opening the page"]);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /not recording/);
});
