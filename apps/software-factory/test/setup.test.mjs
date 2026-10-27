import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TOOLS } from "../app/api/board/[[...path]]/harness.ts";

const { version } = JSON.parse(readFileSync(new URL("../../../packages/board/package.json", import.meta.url), "utf8"));

// A sandbox, as setup sees it: pnpm there, no gh, and a network where GitHub's API refuses it
// (sandboxes share its unauthenticated rate limit) but release downloads work. npm, as far as
// vb goes, is a registry of `name@version`s (`registry`) and one global vb that names the package
// it's from (`vb`, like `@vercel/board@0.13.0`, or none). Like npm, it installs a vb over another
// package's only with --force.
function sandbox({ vb = "@vercel/board@0.13.0", registry = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "setup-"));
  const bin = join(home, "bin");
  const vbBin = join(home, "vb-bin");
  mkdirSync(bin);
  mkdirSync(vbBin);
  for (const tool of ["tar", "gzip", "mkdir", "mktemp", "basename", "cp", "sed", "cat", "chmod", "grep", "tail"]) {
    symlinkSync(execFileSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
  }
  const fake = (name, script) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const at = (spec) => spec.lastIndexOf("@");
  writeFileSync(join(home, "registry"), registry.map((spec) => `${spec}\n`).join(""));
  if (vb) {
    writeFileSync(join(vbBin, "owner"), `${vb.slice(0, at(vb))}\n`);
    writeFileSync(join(vbBin, "vb"), `#!/bin/bash\necho ${vb.slice(at(vb) + 1)}\n`);
    chmodSync(join(vbBin, "vb"), 0o755);
  }
  fake("pnpm", "exit 0");
  fake(
    "npm",
    `echo "$*" >> "$HOME/npm.log"
[ "$1" = install ] || exit 0
force=; spec=
for arg in "\${@:2}"; do case "$arg" in --force) force=1 ;; -*) ;; *) spec="$arg" ;; esac; done
case "$spec" in
  @vercel/board) spec=$(grep "^@vercel/board@" "$HOME/registry" | tail -1) ;;
  @vercel/board@*) ;;
  *) exit 0 ;;
esac
[ -n "$spec" ] && grep -qxF "$spec" "$HOME/registry" || { echo "npm error 404" >&2; exit 1; }
owner="$HOME/vb-bin/owner"
if [ -z "$force" ] && [ -f "$owner" ] && [ "$(cat "$owner")" != "\${spec%@*}" ]; then
  echo "npm error EEXIST: file already exists" >&2; exit 1
fi
echo "\${spec%@*}" > "$owner"
printf '#!/bin/bash\\necho %s\\n' "\${spec##*@}" > "$HOME/vb-bin/vb"
chmod +x "$HOME/vb-bin/vb"`,
  );
  fake("install", 'cp "$1" "$HOME/gh"');
  fake(
    "curl",
    `url="\${@: -1}"
case "$url" in
  https://api.github.com/*) echo "curl: (22) The requested URL returned error: 403" >&2; exit 22 ;;
  https://github.com/cli/cli/releases/download/v[0-9]*/gh_[0-9]*_linux_amd64.tar.gz)
    name=$(basename "$url" .tar.gz); dir=$(mktemp -d); mkdir -p "$dir/$name/bin"
    printf '#!/bin/sh\\n' > "$dir/$name/bin/gh"; tar czf - -C "$dir" "$name" ;;
  *) echo "curl: (22) The requested URL returned error: 404" >&2; exit 22 ;;
esac`,
  );
  const bash = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
  const run = () => spawnSync(bash, ["-c", TOOLS], { env: { HOME: home, PATH: `${vbBin}:${bin}` }, encoding: "utf8" });
  // The global vb after setup: the package it's from and the version it answers.
  const installed = () =>
    existsSync(join(vbBin, "vb"))
      ? { from: readFileSync(join(vbBin, "owner"), "utf8").trim(), version: execFileSync(join(vbBin, "vb"), { encoding: "utf8" }).trim() }
      : null;
  return { run, installed, gh: join(home, "gh") };
}

test("a new sandbox gets gh while GitHub's API refuses it", () => {
  const { run, gh } = sandbox();
  const done = run();
  assert.equal(done.status, 0, done.stderr);
  assert.ok(existsSync(gh), "gh is installed");
});

test("an old sandbox upgrades vb to the release this deployment was built with", () => {
  const { run, installed } = sandbox({ registry: [`@vercel/board@${version}`] });
  const done = run();
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(installed(), { from: "@vercel/board", version });
});

test("the release takes over a vb that another package installed", () => {
  const { run, installed } = sandbox({ vb: "another-cli@2.0.0", registry: [`@vercel/board@${version}`] });
  const done = run();
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(installed(), { from: "@vercel/board", version });
});

test("until the release is on npm, the vb already here stays", () => {
  const { run, installed } = sandbox({ registry: ["@vercel/board@0.0.0"] });
  const done = run();
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(installed(), { from: "@vercel/board", version: "0.13.0" });
});

test("a new sandbox gets the release", () => {
  const { run, installed } = sandbox({ vb: null, registry: [`@vercel/board@${version}`] });
  const done = run();
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(installed(), { from: "@vercel/board", version });
});
