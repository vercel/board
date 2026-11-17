import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getVercelOidcToken } from "@vercel/oidc";
import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { SANDBOX, type RunnerConfig } from "../sandbox/shared.ts";
import { ROOT, tasksChannel, team, workerName } from "./board.ts";
import { cloneUrl, githubRepo, type Config } from "./config.ts";

// The sandboxes a campaign runs in. Three kinds, each forked from the one before:
//
//   base      Node, pi, vb, and the runner. Built once per version of the runner, then only forked.
//   source    The base plus the repository, cloned and set up once per campaign.
//   worker    The source, one per agent, running sandbox/runner.ts.
//
// No credential is ever written into one. Each sandbox's network policy adds them to its requests
// on the way out: the board's (as that agent's profile, held to the campaign's channels), AI
// Gateway's, and GitHub's. Code the migration runs, the repository's own included, can use them
// only for the hosts the policy names, and can't read them.

/** What the base installs, pinned: the runner is written against these. Kept in step with package.json by a test. */
export const RUNTIME = { "@earendil-works/pi-coding-agent": "1.5.2", "@vercel/board": "0.49.0" } as const;
const IMAGE = "vercel/sandbox/node:24";
const TAG = "migration-campaign";

/** What stands in for a credential inside a sandbox, where a tool insists on having one. */
const PLACEHOLDER = "set-by-the-network-policy";

type Rules = NonNullable<Exclude<NetworkPolicy, string>["allow"]>;
type Allow = Exclude<Rules, string[]>;

/** The file a finished base holds. A build that was cut short (a function that timed out, a closed laptop) leaves a base without it. */
const READY = `${SANDBOX.dir}/.ready`;

const sourceName = (slug: string) => `mc-${slug}-src`;
const workerPrefix = (slug: string) => `mc-${slug}-w`;

async function must(sandbox: Sandbox, what: string, cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const result = await sandbox.runCommand({ cmd, args, cwd: opts.cwd ?? "/vercel/sandbox" });
  const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
  if (result.exitCode !== 0) throw new Error(`${what} failed (exit ${result.exitCode}):\n${`${stdout}\n${stderr}`.trim().slice(-1_500)}`);
  return stdout;
}

/** The token this deployment is, for the board and for AI Gateway. On your machine, the one `vercel env pull` wrote. */
const oidc = () => getVercelOidcToken();

/**
 * GitHub, for one repository. The deployment's token (GITHUB_TOKEN) goes only on requests for that
 * repository: its git URLs, and its own part of the API. Code a campaign runs is the repository's
 * own, so it can reach GitHub, and with this it can use the token for nothing but the repository
 * it came from. Without a token, or for a repository that isn't on GitHub, requests go as they are.
 */
function github(repo: string | null): Allow {
  const token = process.env.GITHUB_TOKEN;
  if (!token || !repo) return { "github.com": [], "api.github.com": [], "codeload.github.com": [] };
  const path = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    "api.github.com": [{ match: { path: { regex: `^/repos/${path}(/.*)?$` } }, transform: [{ headers: { authorization: `Bearer ${token}` } }] }],
    "github.com": [{ match: { path: { regex: `^/${path}(\\.git)?(/.*)?$` } }, transform: [{ headers: { authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` } }] }],
    "codeload.github.com": [],
  };
}

/** Whether pull requests and pushes can work: they need a token. */
export const canPush = () => !!process.env.GITHUB_TOKEN;

/**
 * The sandbox every other one is forked from: Node, the runner and its dependencies. Named by a
 * hash of what goes in it, so it's built once per version of the runner. `say` hears when a build
 * starts, since the first one takes a couple of minutes.
 */
export async function baseSandbox(say: (text: string) => Promise<void> = async () => {}): Promise<string> {
  const files = await Promise.all(["runner.ts", "shared.ts"].map(async (name) => ({ name, content: await readFile(join(process.cwd(), "sandbox", name)) })));
  const hash = createHash("sha256").update(IMAGE).update(JSON.stringify(RUNTIME));
  for (const file of files) hash.update(file.name).update(file.content);
  const name = `mc-base-${hash.digest("hex").slice(0, 12)}`;

  const existing = await Sandbox.get({ name }).catch(() => null);
  if (existing) {
    // Running means another launch is building it right now: forking it before it stops would copy half an install.
    for (let waited = 0; waited < 8 * 60_000; waited += 5_000) {
      const { status } = await Sandbox.get({ name });
      if (status !== "running" && status !== "pending" && status !== "snapshotting" && status !== "stopping") break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    return name;
  }

  await say("Building the sandbox image the agents run in. This happens once, and takes a couple of minutes.");
  const base = await Sandbox.create({
    name,
    image: IMAGE,
    persistent: true,
    timeout: 15 * 60_000,
    networkPolicy: { allow: { "registry.npmjs.org": [] } },
    tags: { app: TAG, role: "base" },
  });
  try {
    await base.writeFiles([
      ...files.map((file) => ({ path: `${SANDBOX.dir}/${file.name}`, content: file.content })),
      { path: `${SANDBOX.dir}/package.json`, content: JSON.stringify({ name: "campaign-runner", private: true, type: "module", dependencies: RUNTIME }) },
    ]);
    await must(base, "installing the runner", "npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: SANDBOX.dir });
    await must(base, "checking vb", "node", ["node_modules/.bin/vb", "--version"], { cwd: SANDBOX.dir });
    // The last thing a build does: a base without it was cut short, and `prepare` builds it again.
    await base.writeFiles([{ path: READY, content: "ready" }]);
    // Stopping a persistent sandbox snapshots it, which is what forks start from.
    await base.stop();
    return name;
  } catch (error) {
    // A base that stopped mid-install would be forked as it is, by name, forever: it goes.
    await base.delete().catch(() => base.stop().catch(() => {}));
    throw error;
  }
}

/** What preparing a campaign's checkout found. */
export type Checkout = { base: string; baseBranch: string; discovered: string };

/**
 * A campaign's source sandbox: the repository cloned, set up, and its files listed, then stopped so
 * every agent forks the same checkout. It reaches the whole internet while it sets up (a
 * repository's install wants its registries), with GitHub's token and no other credential.
 */
export async function prepare(slug: string, config: Config, base: string, say: (text: string) => Promise<void> = async () => {}): Promise<Checkout> {
  let sandbox = await forkSource(slug, config, base);
  if ((await sandbox.runCommand({ cmd: "test", args: ["-f", READY] })).exitCode !== 0) {
    // The base's build never finished: it goes, and one more build replaces it.
    await sandbox.delete().catch(() => {});
    await (await Sandbox.get({ name: base })).delete();
    sandbox = await forkSource(slug, config, await baseSandbox(say));
  }
  return checkout(sandbox, slug, config);
}

function forkSource(slug: string, config: Config, base: string) {
  return Sandbox.fork({
    sourceSandbox: base,
    name: sourceName(slug),
    persistent: true,
    timeout: 40 * 60_000,
    resources: { vcpus: config.vcpus },
    networkPolicy: { allow: { ...github(githubRepo(config.repo)), "*": [] } },
    tags: { app: TAG, campaign: slug, role: "source" },
  });
}

async function checkout(sandbox: Sandbox, slug: string, config: Config): Promise<Checkout> {
  try {
    await must(sandbox, `cloning ${config.repo}`, "git", ["clone", "--quiet", "--depth", "1", ...(config.branch ? ["--branch", config.branch] : []), cloneUrl(config.repo), SANDBOX.repo]);
    const sha = (await must(sandbox, "reading the commit", "git", ["rev-parse", "HEAD"], { cwd: SANDBOX.repo })).trim();
    const baseBranch = (await must(sandbox, "reading the branch", "git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: SANDBOX.repo })).trim();
    if (config.setup) await must(sandbox, "the setup command", "bash", ["-lc", config.setup], { cwd: SANDBOX.repo });
    const discovered = await must(sandbox, "the command that lists the files", "bash", ["-lc", config.discover], { cwd: SANDBOX.repo });
    if (config.delivery === "branch") await must(sandbox, `pushing the branch ${campaignBranch(slug)}`, "git", ["push", "--quiet", "origin", `HEAD:refs/heads/${campaignBranch(slug)}`], { cwd: SANDBOX.repo });
    await sandbox.stop();
    return { base: sha, baseBranch, discovered };
  } catch (error) {
    await sandbox.delete().catch(() => sandbox.stop().catch(() => {}));
    throw error;
  }
}

/** The branch a campaign pushes to: every task's commits with `branch` delivery, and the prefix of each task's branch with `prs`. */
export const campaignBranch = (slug: string) => `campaign/${slug}`;

/**
 * A worker's network policy: the board as that agent, AI Gateway, and GitHub. Every other host is
 * blocked. It holds this deployment's OIDC token as it is now, which lives under two hours, so a
 * running campaign's policies are made again every few minutes (`refresh`).
 */
async function workerPolicy(n: number, scope: Scope): Promise<{ policy: NetworkPolicy; boardUrl: string }> {
  const token = await oidc();
  const worker = team().as(workerName(n));
  // Its own campaign's tasks to work, and the campaigns' threads only to read: it can't touch another campaign's tasks, or any campaign's phase.
  const can = `${ROOT}=read;${tasksChannel(scope.slug)}=read,post,react,label`;
  const [{ allow }, { url }] = await Promise.all([worker.sandboxPolicy({ token, can }), team().discovery()]);
  const gateway = process.env.AI_GATEWAY_API_KEY ?? token;
  const policy = {
    allow: {
      ...(allow as Allow),
      "ai-gateway.vercel.sh": [{ transform: [{ headers: { "x-api-key": gateway, authorization: `Bearer ${gateway}` } }] }],
      // GitHub only where the campaign pushes: an agent that delivers patches has no use for it.
      ...(scope.push ? github(scope.repo) : {}),
      // A patch goes to the board as a file, which Vercel's API takes on a link it signs for its own bucket.
      ...(new URL(url).host === "api.vercel.com" ? { "vercel-messageboard-attachments.s3.us-west-1.amazonaws.com": [] } : {}),
    },
  } as NetworkPolicy;
  return { policy, boardUrl: url };
}

/** What a worker's policy is for: its campaign, and the one repository it may push to, if it pushes. */
export type Scope = { slug: string; repo: string | null; push: boolean };

/** An unsigned token with the real one's claims a client reads (its expiry, its team) and no signature: `vb` wants one to send, and the policy replaces it. */
function standIn(token: string): string {
  const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({ exp: claims.exp, iat: claims.iat, owner_id: claims.owner_id, project_id: claims.project_id, sub: "stand-in" })}.stand-in`;
}

/** What `vb` in a sandbox needs to find the board: where it is, who it writes as, and something to send where the policy puts the credential. */
async function boardEnv(url: string, worker: string): Promise<Record<string, string>> {
  const at = new URL(url);
  if (at.hostname === "localhost" || at.hostname === "127.0.0.1") throw new Error("A sandbox can't reach a board on your machine. Unset BOARD_URL to use your team's board.");
  const env: Record<string, string> = { BOARD_URL: url, BOARD_PROFILE: worker };
  if (at.host !== "api.vercel.com") return { ...env, BOARD_TOKEN: PLACEHOLDER };
  const teamId = at.searchParams.get("teamId");
  return { ...env, VERCEL_OIDC_TOKEN: standIn(await oidc()), ...(teamId ? { VERCEL_ORG_ID: teamId } : {}) };
}

/** Starts agent `n` of a campaign in a sandbox of its own, forked from the campaign's checkout. */
export async function startWorker(slug: string, n: number, runner: RunnerConfig, opts: { vcpus: number; timeoutMs: number }): Promise<string> {
  const { policy, boardUrl } = await workerPolicy(n, { slug, repo: runner.github, push: runner.delivery !== "patch" });
  const env = await boardEnv(boardUrl, runner.worker);
  const sandbox = await Sandbox.fork({
    sourceSandbox: sourceName(slug),
    // A worker that's started again gets a name of its own: the one before it may still be shutting down.
    name: `${workerPrefix(slug)}${n}-${Date.now().toString(36)}`,
    persistent: false,
    timeout: opts.timeoutMs,
    resources: { vcpus: opts.vcpus },
    networkPolicy: policy,
    tags: { app: TAG, campaign: slug, role: "worker" },
  });
  await sandbox.writeFiles([{ path: SANDBOX.config, content: JSON.stringify(runner) }]);
  const home = `${SANDBOX.dir}/home`;
  await sandbox.runCommand({
    cmd: "node",
    args: ["runner.ts"],
    cwd: SANDBOX.dir,
    env: { ...env, AI_GATEWAY_API_KEY: PLACEHOLDER, HOME: home, XDG_CONFIG_HOME: `${home}/.config`, NODE_NO_WARNINGS: "1" },
    detached: true,
  });
  return sandbox.name;
}

/** The number a worker's sandbox was started as, from its name. */
const workerNumber = (slug: string, name: string) => Number(/^(\d+)-/.exec(name.slice(workerPrefix(slug).length))?.[1] ?? NaN);

/** Every worker sandbox of a campaign that's up, whatever its runner is doing. */
async function up(slug: string): Promise<{ name: string; n: number; young: boolean }[]> {
  const listed = await Sandbox.list({ namePrefix: workerPrefix(slug), sortBy: "name" });
  const running: { name: string; n: number; young: boolean }[] = [];
  for await (const sandbox of listed) {
    if (sandbox.status !== "running" && sandbox.status !== "pending") continue;
    const n = workerNumber(slug, sandbox.name);
    if (Number.isFinite(n)) running.push({ name: sandbox.name, n, young: Date.now() - sandbox.createdAt < STARTING_MS });
  }
  return running;
}

/** A sandbox this young may not have started its runner yet: it counts as working. */
const STARTING_MS = 90_000;

/**
 * A campaign's agents that are working, by number. An agent that found nothing to claim exits, and
 * its sandbox would idle until its timeout: one whose runner is gone is stopped here, and isn't
 * counted, so the campaign starts a new one when there's work again.
 */
export async function workers(slug: string): Promise<{ name: string; n: number }[]> {
  const running = await up(slug);
  const alive = await Promise.all(
    running.map(async ({ name, young }) => {
      if (young) return true;
      try {
        const sandbox = await Sandbox.get({ name });
        const check = await sandbox.runCommand({ cmd: "sh", args: ["-c", `pid=$(cat ${SANDBOX.pid}) && test -n "$pid" && test -d "/proc/$pid"`] });
        if (check.exitCode === 0) return true;
        await sandbox.stop();
        return false;
      } catch {
        // One that can't be asked is left as it is: stopping an agent mid-task costs more than counting one too many.
        return true;
      }
    }),
  );
  return running.filter((_, at) => alive[at]).map(({ name, n }) => ({ name, n }));
}

/** Hands each running worker a new policy, before the token in its last one runs out. */
export async function refresh(up: { name: string; n: number }[], scope: Scope): Promise<void> {
  await Promise.allSettled(
    up.map(async ({ name, n }) => {
      const [{ policy }, sandbox] = await Promise.all([workerPolicy(n, scope), Sandbox.get({ name })]);
      await sandbox.update({ networkPolicy: policy });
    }),
  );
}

/** Stops sandboxes by name. One that's already gone is fine. */
export async function stop(names: string[]): Promise<void> {
  await Promise.allSettled(names.map(async (name) => (await Sandbox.get({ name })).stop()));
}

/**
 * Ends a campaign's sandboxes: its workers stop, and its checkout is deleted. It throws while a
 * worker is still up (one that was only just starting can outlive a stop), so whoever called it
 * tries again rather than leaving a sandbox running for nobody.
 */
export async function teardown(slug: string): Promise<void> {
  await stop((await up(slug)).map(({ name }) => name));
  await Sandbox.get({ name: sourceName(slug) })
    .then((sandbox) => sandbox.delete())
    .catch(() => {});
  const left = await up(slug);
  if (left.length) throw new Error(`${left.length} of ${slug}'s sandboxes are still stopping`);
}
