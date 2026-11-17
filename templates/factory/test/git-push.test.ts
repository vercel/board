import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// The sandbox's git, run for real: git itself, and a fake GitHub whose Git data API is a bare repo.
// The bare repo refuses every native push, so a branch can change there only through the API.
const GIT = join(import.meta.dirname, "../agent/lib/git/git");
const REMOTE = "https://github.com/acme/web.git";
const APP = { GIT_COMMITTER_NAME: "factory[bot]", GIT_COMMITTER_EMAIL: "bot@example.com", GIT_AUTHOR_NAME: "factory[bot]", GIT_AUTHOR_EMAIL: "bot@example.com" };
const ENV = {
  NODE_ENV: "test" as const,
  PATH: process.env.PATH ?? "",
  HOME: tmpdir(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.com",
  GIT_REAL: execFileSync("sh", ["-c", "command -v git"]).toString().trim(),
};
const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function sh(cwd: string, args: string[], input?: string | Buffer, env: Record<string, string> = {}): string {
  return execFileSync(ENV.GIT_REAL, args, { cwd, input, env: { ...ENV, ...env } }).toString().trim();
}

type Call = { method: string; path: string; body: any };

/** A repo on a fake GitHub, with `main` at one commit, and a clone of it whose origin is GitHub. */
async function setup({ misbuild = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "git-push-"));
  dirs.push(root);
  const bare = join(root, "web.git");
  const work = join(root, "work");
  sh(root, ["init", "-q", "--bare", "-b", "main", bare]);
  sh(root, ["init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "README.md"), "# web\n");
  writeFileSync(join(work, "old.txt"), "old\n");
  sh(work, ["add", "."]);
  sh(work, ["commit", "-q", "-m", "first"]);
  sh(work, ["push", "-q", bare, "main"]);
  writeFileSync(join(bare, "hooks/pre-receive"), "#!/bin/sh\necho 'pushes go through the API' >&2\nexit 1\n");
  chmodSync(join(bare, "hooks/pre-receive"), 0o755);
  sh(work, ["remote", "add", "origin", REMOTE]);
  sh(work, ["config", `url.${bare}.insteadOf`, REMOTE]);
  sh(work, ["fetch", "-q", "origin"]);
  sh(work, ["branch", "-q", "--set-upstream-to=origin/main", "main"]);

  const calls: Call[] = [];
  let indexes = 0;
  const bareGit = (args: string[], input?: string | Buffer, env: Record<string, string> = {}) => sh(bare, args, input, env);
  const tip = (branch: string) => {
    try {
      return bareGit(["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
    } catch {
      return null;
    }
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const path = decodeURIComponent(new URL(req.url ?? "", "http://x").pathname).replace("/repos/acme/web/git/", "");
    calls.push({ method: req.method ?? "", path, body });
    const send = (status: number, data?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(data === undefined ? "" : JSON.stringify(data));
    };
    try {
      if (req.method === "GET" && path.startsWith("ref/heads/")) {
        const sha = tip(path.slice("ref/heads/".length));
        return sha ? send(200, { object: { sha, type: "commit" } }) : send(404, { message: "Not Found" });
      }
      if (req.method === "POST" && path === "blobs") return send(201, { sha: bareGit(["hash-object", "-w", "--stdin"], Buffer.from(body.content, "base64")) });
      if (req.method === "POST" && path === "trees") {
        const env = { GIT_INDEX_FILE: join(root, `index-${indexes++}`) };
        bareGit(body.base_tree ? ["read-tree", body.base_tree] : ["read-tree", "--empty"], undefined, env);
        const info = body.tree.map((e: any) => (e.sha === null ? `0 ${"0".repeat(40)}\t${e.path}` : `${e.mode} ${e.sha}\t${e.path}`));
        bareGit(["update-index", "--index-info"], `${(misbuild ? info.slice(1) : info).join("\n")}\n`, env);
        return send(201, { sha: bareGit(["write-tree"], undefined, env) });
      }
      if (req.method === "POST" && path === "commits") {
        // GitHub signs a commit an app makes only when it names no author, committer or signature.
        const verified = !body.author && !body.committer && !body.signature;
        const sha = bareGit(["commit-tree", body.tree, ...body.parents.flatMap((p: string) => ["-p", p])], body.message, APP);
        return send(201, { sha, verification: { verified, reason: verified ? "valid" : "unsigned" } });
      }
      if (req.method === "PATCH" && path.startsWith("refs/heads/")) {
        const branch = path.slice("refs/heads/".length);
        const old = tip(branch);
        if (!old) return send(422, { message: "Reference does not exist" });
        const ff = (() => {
          try {
            bareGit(["merge-base", "--is-ancestor", old, body.sha]);
            return true;
          } catch {
            return false;
          }
        })();
        if (!body.force && !ff) return send(422, { message: "Update is not a fast forward" });
        bareGit(["update-ref", `refs/heads/${branch}`, body.sha]);
        return send(200, { object: { sha: body.sha } });
      }
      if (req.method === "POST" && path === "refs") {
        if (tip(body.ref.slice("refs/heads/".length))) return send(422, { message: "Reference already exists" });
        bareGit(["update-ref", body.ref, body.sha]);
        return send(201, { object: { sha: body.sha } });
      }
      if (req.method === "DELETE" && path.startsWith("refs/heads/")) {
        const branch = path.slice("refs/heads/".length);
        if (!tip(branch)) return send(422, { message: "Reference does not exist" });
        bareGit(["update-ref", "-d", `refs/heads/${branch}`]);
        return send(204);
      }
      send(404, { message: "Not Found" });
    } catch (error) {
      send(422, { message: String(error) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** The sandbox's `git`, as the agent runs it. */
  const git = (...args: string[]) =>
    new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = spawn("sh", [GIT, ...args], { cwd: work, env: { ...ENV, GITHUB_API_URL: api } });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.stdout.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, err }));
    });
  const commit = (message: string, files: Record<string, string | null>) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) unlinkSync(join(work, path));
      else {
        execFileSync("mkdir", ["-p", join(work, path, "..")]);
        writeFileSync(join(work, path), content);
      }
    }
    sh(work, ["add", "-A"]);
    sh(work, ["commit", "-q", "-m", message]);
    return sh(work, ["rev-parse", "HEAD"]);
  };
  return { work, bare, calls, git, commit, tip, local: (...args: string[]) => sh(work, args), remote: (...args: string[]) => bareGit(args) };
}

const treeOf = (run: (...a: string[]) => string, rev: string) => run("rev-parse", `${rev}^{tree}`);

test("a push makes each commit again on GitHub, signed, and the branch moves onto them", async () => {
  const r = await setup();
  r.local("switch", "-q", "-c", "factory/7");
  writeFileSync(join(r.work, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(r.work, "run.sh"), 0o755);
  symlinkSync("README.md", join(r.work, "link"));
  const first = r.commit("add the script\n\nWith a body.", { "src/app/page.ts": "export {};\n" });
  const second = r.commit("change the page, drop old.txt", { "src/app/page.ts": "export const x = 1;\n", "old.txt": null });
  const trees = [treeOf(r.local, first), treeOf(r.local, second)];
  const messages = [first, second].map((c) => r.local("log", "-1", "--format=%B", c));

  const push = await r.git("push", "-u", "origin", "factory/7");
  assert.equal(push.code, 0, push.err);

  const made = r.remote("rev-list", "--reverse", "main..factory/7").split("\n");
  assert.equal(made.length, 2);
  assert.deepEqual(made.map((c) => treeOf(r.remote, c)), trees);
  assert.deepEqual(made.map((c) => r.remote("log", "-1", "--format=%B", c)), messages);
  assert.deepEqual(made.map((c) => r.remote("log", "-1", "--format=%cn", c)), ["factory[bot]", "factory[bot]"]);
  assert.equal(r.remote("rev-parse", `${made[0]}^`), r.remote("rev-parse", "main"));
  for (const call of r.calls.filter((c) => c.path === "commits")) assert.equal(call.body.author ?? call.body.committer, undefined);
  assert.equal(r.remote("ls-tree", "factory/7", "run.sh").split(" ")[0], "100755");
  assert.equal(r.remote("ls-tree", "factory/7", "link").split(" ")[0], "120000");

  assert.equal(r.local("rev-parse", "HEAD"), made[1]);
  assert.equal(r.local("status", "--porcelain"), "");
  assert.equal(r.local("rev-parse", "--abbrev-ref", "factory/7@{upstream}"), "origin/factory/7");
  assert.match(push.err, /GitHub signed 2 commits/);
});

test("a tree GitHub builds differently stops the push before the branch moves", async () => {
  const r = await setup({ misbuild: true });
  r.local("switch", "-q", "-c", "factory/7");
  const mine = r.commit("two files", { "a.txt": "a\n", "b.txt": "b\n" });

  const push = await r.git("push", "-u", "origin", "factory/7");
  assert.equal(push.code, 1);
  assert.match(push.err, /nothing was published/);
  assert.equal(r.tip("factory/7"), null);
  assert.equal(r.local("rev-parse", "HEAD"), mine);
});

test("the next push sends only what GitHub lacks", async () => {
  const r = await setup();
  r.local("switch", "-q", "-c", "factory/7");
  r.commit("one", { "a.txt": "a\n", "b.txt": "b\n" });
  assert.equal((await r.git("push", "-u", "origin", "factory/7")).code, 0);
  const signed = r.local("rev-parse", "HEAD");
  r.calls.length = 0;

  r.commit("two", { "b.txt": "b, again\n" });
  const push = await r.git("push");
  assert.equal(push.code, 0, push.err);

  assert.equal(r.calls.filter((c) => c.path === "commits").length, 1);
  assert.deepEqual(r.calls.filter((c) => c.path === "blobs").map((c) => Buffer.from(c.body.content, "base64").toString()), ["b, again\n"]);
  assert.equal(r.remote("rev-parse", "factory/7^"), signed);
  assert.equal(r.local("rev-parse", "HEAD"), r.tip("factory/7"));
});

test("a push behind GitHub's branch is rejected before anything is sent", async () => {
  const r = await setup();
  const theirs = r.remote("commit-tree", treeOf(r.remote, "main"), "-p", "main", "-m", "theirs");
  r.remote("update-ref", "refs/heads/main", theirs);
  r.commit("mine", { "mine.txt": "mine\n" });

  const push = await r.git("push", "origin", "main");
  assert.equal(push.code, 1);
  assert.match(push.err, /\[rejected\].*non-fast-forward/);
  assert.equal(r.tip("main"), theirs);
  assert.deepEqual(r.calls.filter((c) => c.method !== "GET"), []);
});

test("--force replaces the branch with the amended commit", async () => {
  const r = await setup();
  r.local("switch", "-q", "-c", "factory/7");
  r.commit("draft", { "a.txt": "draft\n" });
  assert.equal((await r.git("push", "-u", "origin", "factory/7")).code, 0);
  writeFileSync(join(r.work, "a.txt"), "final\n");
  r.local("commit", "-q", "-a", "--amend", "-m", "final");
  const tree = treeOf(r.local, "HEAD");

  const push = await r.git("push", "--force");
  assert.equal(push.code, 0, push.err);
  assert.equal(treeOf(r.remote, "factory/7"), tree);
  assert.equal(r.remote("rev-parse", "factory/7^"), r.remote("rev-parse", "main"));
  assert.equal(r.remote("log", "-1", "--format=%s", "factory/7"), "final");
});

test("a merge keeps both parents: the signed branch and GitHub's main", async () => {
  const r = await setup();
  r.local("switch", "-q", "-c", "factory/7");
  r.commit("mine", { "mine.txt": "mine\n" });
  assert.equal((await r.git("push", "-u", "origin", "factory/7")).code, 0);
  const theirs = r.remote("commit-tree", treeOf(r.remote, "main"), "-p", "main", "-m", "theirs");
  r.remote("update-ref", "refs/heads/main", theirs);
  r.local("fetch", "-q", "origin");
  r.local("merge", "-q", "--no-edit", "origin/main");
  const signedMine = r.tip("factory/7");

  const push = await r.git("push");
  assert.equal(push.code, 0, push.err);
  assert.deepEqual(r.remote("rev-list", "--parents", "-n1", "factory/7").split(" ").slice(1), [signedMine, theirs]);
});

test("gh pr create's push, HEAD to a new branch, signs it and sets the upstream", async () => {
  const r = await setup();
  r.local("switch", "-q", "-c", "factory/7");
  r.commit("mine", { "mine.txt": "mine\n" });

  const push = await r.git("push", "--set-upstream", "origin", "HEAD:refs/heads/factory/7");
  assert.equal(push.code, 0, push.err);
  assert.equal(r.remote("log", "-1", "--format=%cn", "factory/7"), "factory[bot]");
  assert.equal(r.local("rev-parse", "HEAD"), r.tip("factory/7"));
  assert.equal(r.local("rev-parse", "--abbrev-ref", "factory/7@{upstream}"), "origin/factory/7");
});

test("--force-with-lease refuses when GitHub's branch moved since the last fetch", async () => {
  const r = await setup();
  r.local("switch", "-q", "-c", "factory/7");
  r.commit("draft", { "a.txt": "draft\n" });
  assert.equal((await r.git("push", "-u", "origin", "factory/7")).code, 0);
  const theirs = r.remote("commit-tree", treeOf(r.remote, "factory/7"), "-p", "factory/7", "-m", "theirs");
  r.remote("update-ref", "refs/heads/factory/7", theirs);
  r.local("commit", "-q", "--amend", "-m", "final");

  const push = await r.git("push", "--force-with-lease");
  assert.equal(push.code, 1);
  assert.match(push.err, /stale info/);
  assert.equal(r.tip("factory/7"), theirs);
});

test("--delete removes the branch from GitHub", async () => {
  const r = await setup();
  r.local("switch", "-q", "-c", "factory/7");
  r.commit("mine", { "mine.txt": "mine\n" });
  assert.equal((await r.git("push", "-u", "origin", "factory/7")).code, 0);

  const push = await r.git("push", "origin", "--delete", "factory/7");
  assert.equal(push.code, 0, push.err);
  assert.equal(r.tip("factory/7"), null);
});

test("tags are refused, and nothing is sent", async () => {
  const r = await setup();
  r.local("tag", "v1");
  const push = await r.git("push", "origin", "v1");
  assert.equal(push.code, 128);
  assert.match(push.err, /tags aren't supported/);
  assert.deepEqual(r.calls, []);
});

test("a push option to GitHub is refused, not pushed unsigned", async () => {
  const r = await setup();
  const before = r.tip("main");
  r.commit("mine", { "mine.txt": "mine\n" });
  const push = await r.git("push", "-o", "ci.skip", "origin", "main");
  assert.equal(push.code, 128);
  assert.match(push.err, /-o isn't supported/);
  assert.equal(r.tip("main"), before);
  assert.deepEqual(r.calls, []);
});

test("other commands, and pushes anywhere but GitHub, are git's own", async () => {
  const r = await setup();
  const elsewhere = join(r.work, "..", "elsewhere.git");
  r.local("init", "-q", "--bare", elsewhere);
  r.local("remote", "add", "elsewhere", elsewhere);

  const status = await r.git("-C", r.work, "status", "--short");
  assert.equal(status.code, 0, status.err);
  r.local("tag", "v1");
  const push = await r.git("push", "--tags", "elsewhere", "main");
  assert.equal(push.code, 0, push.err);
  assert.equal(r.local("--git-dir", elsewhere, "rev-parse", "v1"), r.local("rev-parse", "v1"));
  assert.equal(r.local("--git-dir", elsewhere, "rev-parse", "main"), r.local("rev-parse", "main"));
  assert.deepEqual(r.calls, []);
});
