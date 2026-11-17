// `git push` to GitHub, through GitHub's API: each outgoing commit is made again there, with the
// same tree, message and parents, and GitHub signs the commits an app makes through its API. The
// branch then points at those signed commits, and so does the local branch: the same files, with
// new commit IDs. No credentials here: the sandbox's network policy adds them on the way out.
// Arguments are git's own, global options included, as `scripts/git` passes them.
import { spawnSync } from "node:child_process";

const GIT = process.env.GIT_REAL || "git";
const API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const GITHUB = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
/** Git's global options that take their value as the next argument. */
const VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
/** More than this in one push is likely a branch git can't place on GitHub's history. */
const MAX_COMMITS = 500;
/** Push options this doesn't do that take a value as the next argument. */
const VALUED_PUSH = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
const IGNORED = new Set(["-v", "--verbose", "--progress", "--no-progress", "--verify", "--no-verify", "--force-if-includes", "--no-force-if-includes"]);

class Exit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** A push this can't do: say what instead. */
const refuse = (what) =>
  new Exit(128, `fatal: git push here goes through GitHub's API so GitHub signs it, and ${what}.\nhint: ${GIT} push pushes without signing.`);

const argv = process.argv.slice(2);
let at = 0;
while (at < argv.length && argv[at] !== "push") at += VALUED.has(argv[at]) ? 2 : 1;
const globals = argv.slice(0, at);

function git(args, { input, buffer = false, check = true } = {}) {
  const run = spawnSync(GIT, [...globals, ...args], { input, encoding: buffer ? "buffer" : "utf8", maxBuffer: 1 << 30 });
  if (check && run.status !== 0) throw new Exit(1, `error: git ${args.join(" ")}: ${String(run.stderr).trim()}`);
  return buffer ? run.stdout : check ? run.stdout.trimEnd() : run;
}
const config = (key) => {
  const run = git(["config", "--get", key], { check: false });
  return run.status === 0 ? run.stdout.trim() : null;
};
const short = (sha) => sha.slice(0, 7);
const has = (sha) => git(["cat-file", "-e", `${sha}^{commit}`], { check: false }).status === 0;
const ancestor = (a, b) => git(["merge-base", "--is-ancestor", a, b], { check: false }).status === 0;
const branchName = (ref) => {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/")) throw refuse(`only branches can be pushed, not ${ref}`);
  return ref;
};

async function main() {
  const flags = { upstream: false, force: false, lease: null, quiet: false, del: false };
  const positional = [];
  const unsupported = [];
  const rest = argv.slice(at + 1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-")) positional.push(arg);
    else if (arg === "-u" || arg === "--set-upstream") flags.upstream = true;
    else if (arg === "-f" || arg === "--force") flags.force = true;
    else if (arg === "-d" || arg === "--delete") flags.del = true;
    else if (arg === "-q" || arg === "--quiet") flags.quiet = true;
    else if (arg === "--force-with-lease" || arg.startsWith("--force-with-lease=")) {
      const [ref, expect] = arg.slice("--force-with-lease=".length).split(":");
      flags.lease = { ref: ref ? branchName(ref) : null, expect: expect ?? null };
    } else if (VALUED_PUSH.has(arg)) unsupported.push(arg, rest[++i]);
    else if (!IGNORED.has(arg)) unsupported.push(arg);
  }

  const current = git(["symbolic-ref", "-q", "--short", "HEAD"], { check: false }).stdout.trim() || null;
  const remote =
    positional[0] ?? ((current && (config(`branch.${current}.pushRemote`) ?? config("remote.pushDefault") ?? config(`branch.${current}.remote`))) || "origin");
  const named = config(`remote.${remote}.url`) !== null;
  const url = config(`remote.${remote}.pushurl`) ?? config(`remote.${remote}.url`) ?? remote;
  const match = GITHUB.exec(url);
  if (!match) {
    // Not GitHub: nothing to sign, so it's git's own push.
    const run = spawnSync(GIT, argv, { stdio: "inherit" });
    throw new Exit(run.status ?? 1);
  }
  const repo = `${match[1]}/${match[2]}`;
  if (unsupported.length) throw refuse(`${unsupported[0]} isn't supported`);

  let specs = positional.slice(1);
  if (specs.length === 0) {
    if (!current) throw new Exit(128, "fatal: You are not currently on a branch.");
    const merge = config(`branch.${current}.remote`) === remote ? config(`branch.${current}.merge`) : null;
    specs = [`${current}:${merge ?? current}`];
  }
  const targets = specs.map((spec) => {
    const force = flags.force || spec.startsWith("+");
    const bare = spec.replace(/^\+/, "");
    const colon = bare.indexOf(":");
    const src = colon === -1 ? bare : bare.slice(0, colon);
    if (flags.del) return { del: true, dst: branchName(bare) };
    if (src === "") return { del: true, dst: branchName(bare.slice(1)) };
    const ref = git(["rev-parse", "--symbolic-full-name", src], { check: false }).stdout.trim();
    if (ref.startsWith("refs/tags/")) throw refuse("tags aren't supported");
    const local = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
    const resolved = git(["rev-parse", "--verify", "-q", `${src}^{commit}`], { check: false });
    if (resolved.status !== 0) throw new Exit(1, `error: src refspec ${src} does not match any`);
    const dst = colon === -1 ? local : branchName(bare.slice(colon + 1));
    if (!dst) throw new Exit(1, `error: name the branch to push ${src} to: git push ${remote} ${src}:<branch>`);
    const lease = flags.lease && (flags.lease.ref === null || flags.lease.ref === dst) ? flags.lease : null;
    return { src, local, sha: resolved.stdout.trim(), dst, force: force || lease !== null, lease };
  });

  async function api(method, path, body) {
    const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "factory-git-push" };
    if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
    if (body) headers["content-type"] = "application/json";
    const res = await fetch(`${API}/repos/${repo}${path}`, { method, headers, body: body && JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text.slice(0, 200) };
    }
    return { status: res.status, data };
  }
  const ok = ({ status, data }, doing) => {
    if (status >= 300) throw new Exit(1, `error: GitHub answered ${status} ${doing}: ${data?.message ?? ""}`.trimEnd());
    return data;
  };
  const refPath = (branch) => `/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
  async function tipOf(branch) {
    const res = await api("GET", refPath(branch).replace("/git/refs/", "/git/ref/"));
    return res.status === 404 ? null : ok(res, `reading ${branch}`).object.sha;
  }

  // What GitHub already has, so each blob and tree goes up once.
  const blobs = new Set();
  const trees = new Set();
  async function sendTree(commit, parent, tree) {
    if (trees.has(tree)) return;
    const base = parent ? git(["rev-parse", `${parent}^{tree}`]) : null;
    if (base === tree) return void trees.add(tree);
    const fields = git(["diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", "--raw", ...(parent ? [parent, commit] : ["--root", commit])]).split("\0");
    const entries = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [from, to, , sha, status] = fields[i].slice(1).split(" ");
      const mode = status === "D" ? from : to;
      entries.push({ path: fields[i + 1], mode, type: mode === "160000" ? "commit" : "blob", sha: status === "D" ? null : sha });
    }
    const uploads = [...new Set(entries.filter((e) => e.type === "blob" && e.sha && !blobs.has(e.sha)).map((e) => e.sha))];
    await Promise.all(
      Array.from({ length: Math.min(8, uploads.length) }, async () => {
        for (let sha; (sha = uploads.shift()); ) {
          const content = git(["cat-file", "blob", sha], { buffer: true }).toString("base64");
          const made = ok(await api("POST", "/git/blobs", { content, encoding: "base64" }), `uploading blob ${short(sha)}`);
          if (made.sha !== sha) throw new Exit(1, `error: GitHub stored blob ${short(sha)} as ${short(made.sha)}; nothing was published`);
          blobs.add(sha);
        }
      }),
    );
    const made = ok(await api("POST", "/git/trees", { ...(base ? { base_tree: base } : {}), tree: entries }), `building the tree of ${short(commit)}`);
    if (made.sha !== tree) throw new Exit(1, `error: GitHub built tree ${short(made.sha)} for ${short(commit)}, not ${short(tree)}; nothing was published`);
    trees.add(tree);
  }

  const lines = [];
  const notes = [];
  let failed = false;
  for (const t of targets) {
    if (t.del) {
      const res = await api("DELETE", refPath(t.dst));
      if (res.status === 404 || res.status === 422) {
        lines.push(` ! [rejected]        ${t.dst} (remote ref does not exist)`);
        failed = true;
        continue;
      }
      ok(res, `deleting ${t.dst}`);
      if (named) git(["update-ref", "-d", `refs/remotes/${remote}/${t.dst}`], { check: false });
      lines.push(` - [deleted]         ${t.dst}`);
      continue;
    }

    const remoteTip = await tipOf(t.dst);
    const arrow = `${t.local ?? t.src} -> ${t.dst}`;
    if (remoteTip === t.sha) {
      lines.push(` = [up to date]      ${arrow}`);
      continue;
    }
    if (t.lease) {
      const expected = t.lease.expect
        ? git(["rev-parse", "--verify", `${t.lease.expect}^{commit}`])
        : named
          ? git(["rev-parse", "--verify", "-q", `refs/remotes/${remote}/${t.dst}`], { check: false }).stdout.trim() || null
          : null;
      if (remoteTip !== expected) {
        lines.push(` ! [rejected]        ${arrow} (stale info)`);
        failed = true;
        continue;
      }
    }
    if (remoteTip && !has(remoteTip)) git(["fetch", "-q", url, `refs/heads/${t.dst}`], { check: false });
    if (remoteTip && !t.force && !(has(remoteTip) && ancestor(remoteTip, t.sha))) {
      lines.push(` ! [rejected]        ${arrow} (non-fast-forward)`);
      notes.push(`hint: GitHub's ${t.dst} has commits you don't have. Fetch and merge or rebase, then push again.`);
      failed = true;
      continue;
    }

    // Everything GitHub lacks: what no remote branch reaches, oldest first.
    const known = remoteTip && has(remoteTip) ? [remoteTip] : [];
    const outgoing = git(["rev-list", "--reverse", "--topo-order", t.sha, "--not", ...known, named ? `--remotes=${remote}` : "--remotes"])
      .split("\n")
      .filter(Boolean);
    if (outgoing.length > MAX_COMMITS) {
      throw new Exit(1, `error: ${arrow} would make ${outgoing.length} commits on GitHub, past ${MAX_COMMITS}: is it based on ${remote}'s history? git fetch ${remote}, then push again`);
    }
    const signed = new Map();
    for (const commit of outgoing) {
      const [, ...parents] = git(["rev-list", "--parents", "-n1", commit]).split(" ");
      const tree = git(["rev-parse", `${commit}^{tree}`]);
      await sendTree(commit, parents[0], tree);
      const raw = git(["cat-file", "commit", commit], { buffer: true }).toString("utf8");
      const cut = raw.indexOf("\n\n");
      const message = cut === -1 ? "" : raw.slice(cut + 2);
      // No author or committer: GitHub signs only what it makes as the app.
      const made = ok(await api("POST", "/git/commits", { message, tree, parents: parents.map((p) => signed.get(p) ?? p) }), `making ${short(commit)}`);
      if (made.verification && !made.verification.verified) notes.push(`warning: GitHub didn't sign ${short(made.sha)} (${made.verification.reason})`);
      signed.set(commit, made.sha);
    }
    const tip = signed.get(t.sha) ?? t.sha;

    const res = remoteTip
      ? await api("PATCH", refPath(t.dst), { sha: tip, force: t.force })
      : await api("POST", "/git/refs", { ref: `refs/heads/${t.dst}`, sha: tip });
    if (res.status === 422) {
      lines.push(` ! [rejected]        ${arrow} (${remoteTip ? "non-fast-forward" : "already exists"})`);
      notes.push(`hint: ${t.dst} changed on GitHub during the push. Fetch and merge or rebase, then push again.`);
      failed = true;
      continue;
    }
    ok(res, `moving ${t.dst}`);
    lines.push(
      !remoteTip
        ? ` * [new branch]      ${arrow}`
        : t.force && !(has(remoteTip) && ancestor(remoteTip, t.sha))
          ? ` + ${short(remoteTip)}...${short(tip)} ${arrow} (forced update)`
          : `   ${short(remoteTip)}..${short(tip)}  ${arrow}`,
    );

    // Bring GitHub's commits back, and move the local branch onto them: same trees, so the
    // working tree and the index stay as they are.
    const into = named ? `+refs/heads/${t.dst}:refs/remotes/${remote}/${t.dst}` : `refs/heads/${t.dst}`;
    const fetched = git(["fetch", "-q", named ? remote : url, into], { check: false }).status === 0;
    if (t.local && tip !== t.sha) {
      const moved =
        fetched && git(["update-ref", "-m", "push: GitHub's signed commits", `refs/heads/${t.local}`, tip, t.sha], { check: false }).status === 0;
      notes.push(
        moved
          ? `GitHub signed ${signed.size} commit${signed.size === 1 ? "" : "s"}: ${t.local} is now ${short(tip)}, with the same files`
          : `warning: ${t.local} still has the unsigned commits: git fetch ${remote} && git reset --keep ${short(tip)}`,
      );
    }
    if (flags.upstream && named && t.local) git(["branch", "-q", `--set-upstream-to=${remote}/${t.dst}`, t.local], { check: false });
  }

  if (!flags.quiet || failed) {
    process.stderr.write(`To ${url}\n${lines.join("\n")}\n`);
    if (failed) process.stderr.write(`error: failed to push some refs to '${url}'\n`);
    if (notes.length) process.stderr.write(`${notes.join("\n")}\n`);
  }
  if (failed) throw new Exit(1);
}

main().catch((error) => {
  if (!(error instanceof Exit)) throw error;
  if (error.message) process.stderr.write(`${error.message}\n`);
  process.exit(error.code);
});
