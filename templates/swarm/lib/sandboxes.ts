import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getVercelOidcToken } from "@vercel/oidc";
import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { SANDBOX, type RunnerConfig } from "../sandbox/shared.ts";
import { profileOf, runChannel, team } from "./board.ts";
import { githubToken } from "./credentials.ts";

// The sandboxes a run works in. Three kinds, each forked from the one before:
//
//   base      Node, pi, @vercel/board (its CLI), and the runner. Built once per version of the runner, then only forked.
//   source    The base plus the repo, cloned and set up once per run.
//   agent     The source, one per agent, running sandbox/runner.ts.
//
// No credential is ever written into one. Each sandbox's network policy adds them to its requests
// on the way out: the board's (as that agent's profile, held to the run's channel), AI Gateway's,
// and GitHub's (for the run's repo alone). Code an agent runs, the repo's own included, can use
// them only for the hosts and paths the policy names, and can't read them.

/** What the base installs, pinned: the runner is written against these. Kept in step with package.json by a test. */
export const RUNTIME = { "@earendil-works/pi-coding-agent": "1.5.2", "@vercel/board": "0.52.0" } as const;
const IMAGE = "vercel/sandbox/node:24";
const TAG = "swarm";

/** What stands in for a credential inside a sandbox, where a tool insists on having one. */
const PLACEHOLDER = "set-by-the-network-policy";

type Rules = NonNullable<Exclude<NetworkPolicy, string>["allow"]>;
export type Allow = Exclude<Rules, string[]>;

/** The file a finished base holds. A build that was cut short leaves a base without it. */
const READY = `${SANDBOX.state}/.ready`;

const sourceName = (slug: string) => `sw-${slug}-src`;
const agentPrefix = (slug: string) => `sw-${slug}-a`;

async function must(sandbox: Sandbox, what: string, cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const result = await sandbox.runCommand({ cmd, args, cwd: opts.cwd ?? "/vercel/sandbox" });
  const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
  if (result.exitCode !== 0) throw new Error(`${what} failed (exit ${result.exitCode}):\n${`${stdout}\n${stderr}`.trim().slice(-1_500)}`);
  return stdout;
}

/** The token this deployment is, for the board and for AI Gateway. On your machine, the one `vercel env pull` wrote. */
const oidc = () => getVercelOidcToken();

/**
 * GitHub, for one repo: `token` goes only on requests for that repo, its git URLs and its own part of
 * the API. Code from the repo runs in the sandbox, so it can reach GitHub, and with this it can use
 * the token for nothing but the repo it came from.
 */
export function github(repo: string, token: string): Allow {
  const path = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    "api.github.com": [{ match: { path: { regex: `^/repos/${path}(/.*)?$` } }, transform: [{ headers: { authorization: `Bearer ${token}` } }] }],
    "github.com": [{ match: { path: { regex: `^/${path}(\\.git)?(/.*)?$` } }, transform: [{ headers: { authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` } }] }],
    "codeload.github.com": [],
  };
}

/**
 * The sandbox every other one is forked from: Node, the runner and its dependencies. Named by a hash
 * of what goes in it, so it's built once per version of the runner. `say` hears when a build starts,
 * since the first one takes a couple of minutes.
 */
export async function baseSandbox(say: (text: string) => Promise<void> = async () => {}): Promise<string> {
  const files = await Promise.all(["runner.ts", "shared.ts"].map(async (name) => ({ name, content: await readFile(join(process.cwd(), "sandbox", name)) })));
  const hash = createHash("sha256").update(IMAGE).update(JSON.stringify(RUNTIME));
  for (const file of files) hash.update(file.name).update(file.content);
  const name = `sw-base-${hash.digest("hex").slice(0, 12)}`;

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
      { path: `${SANDBOX.dir}/package.json`, content: JSON.stringify({ name: "swarm-runner", private: true, type: "module", dependencies: RUNTIME }) },
    ]);
    await must(base, "installing the runner", "npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: SANDBOX.dir });
    await must(base, "checking the board's CLI", "node", ["node_modules/.bin/vb", "--version"], { cwd: SANDBOX.dir });
    // What the runner writes (its config, its process ID, the agent's home) lives apart from it.
    await must(base, "making the runner's state directory", "mkdir", ["-p", `${SANDBOX.state}/home`]);
    // The last thing a build does: a base without it was cut short, and `prepare` builds it again.
    await base.writeFiles([{ path: READY, content: "ready" }]);
    // Stopping a persistent sandbox snapshots it, which is what forks start from.
    await base.stop();
    return name;
  } catch (error) {
    await base.delete().catch(() => base.stop().catch(() => {}));
    throw error;
  }
}

/** What preparing a run's checkout found: the commit, its branch, and the repo's files. */
export type Checkout = { base: string; baseBranch: string; files: string[]; setup: string | null };

/**
 * The install a repo's lockfile asks for, so the agents can run its tests: their sandboxes reach no
 * registry, and fork from this one, so pnpm or yarn is installed globally here, at the version the
 * repo's `packageManager` pins (a plain version only) or the latest. No install scripts run, the
 * repo's own or its dependencies': this sandbox reaches the internet and holds the repo's GitHub
 * token in its policy, and a package's scripts are anyone's code. pnpm 11 and later fail the
 * install over the build scripts they skip, so that's turned off.
 */
const INSTALL = `set -e
# Only a plain version the repo pins, like pnpm@9.15.0: anything else (an alias, a URL, a tag) is the latest.
pinned() { node -p "const m = (require('./package.json').packageManager || '').split('+')[0]; /^$1@\\d+\\.\\d+\\.\\d+$/.test(m) ? m : '$1@latest'" 2>/dev/null || echo "$1@latest"; }
global() { sudo -n npm i -g --ignore-scripts --no-audit --no-fund --silent "$1" 2>/dev/null || npm i -g --ignore-scripts --no-audit --no-fund --silent "$1"; }
export COREPACK_ENABLE_STRICT=0
if [ -f pnpm-lock.yaml ]; then global "$(pinned pnpm)"; pnpm install --frozen-lockfile --ignore-scripts --config.strict-dep-builds=false; echo pnpm
elif [ -f yarn.lock ]; then global "$(pinned yarn)"; yarn install --frozen-lockfile --ignore-scripts; echo yarn
elif [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund; echo npm
elif [ -f bun.lock ] || [ -f bun.lockb ]; then global bun; bun install --frozen-lockfile --ignore-scripts; echo bun
else echo none; fi`;

/**
 * A run's source sandbox: the repo cloned, its dependencies installed when a lockfile names them,
 * and its files listed, then stopped so every agent forks the same checkout. It reaches the whole
 * internet while it sets up (an install wants its registries), with GitHub's token for the repo and
 * no other credential.
 */
export async function prepare(slug: string, repo: string, base: string, say: (text: string) => Promise<void> = async () => {}, opts: { install?: boolean } = {}): Promise<Checkout> {
  const token = await githubToken(repo, false);
  let sandbox = await forkSource(slug, repo, token, base);
  if ((await sandbox.runCommand({ cmd: "test", args: ["-f", READY] })).exitCode !== 0) {
    // The base's build never finished: it goes, and one more build replaces it.
    await sandbox.delete().catch(() => {});
    await (await Sandbox.get({ name: base })).delete();
    sandbox = await forkSource(slug, repo, token, await baseSandbox(say));
  }
  try {
    await must(sandbox, `cloning ${repo}`, "git", ["clone", "--quiet", `https://github.com/${repo}.git`, SANDBOX.repo]);
    const sha = (await must(sandbox, "reading the commit", "git", ["rev-parse", "HEAD"], { cwd: SANDBOX.repo })).trim();
    const baseBranch = (await must(sandbox, "reading the branch", "git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: SANDBOX.repo })).trim();
    const files = (await must(sandbox, "listing the files", "git", ["ls-files"], { cwd: SANDBOX.repo })).split("\n").filter(Boolean);
    // A review reads the code and runs nothing, so it installs nothing. An install that fails costs
    // the agents their tests, not the run.
    let setup: string | null = null;
    if (opts.install ?? true) {
      const install = await sandbox.runCommand({ cmd: "bash", args: ["-c", INSTALL], cwd: SANDBOX.repo });
      const out = (await install.stdout()).trim().split("\n").pop() ?? "none";
      if (install.exitCode !== 0) {
        // What it printed stays in the sandbox: it can name private packages and registries.
        console.error(`[swarm] the dependency install for ${slug} exited ${install.exitCode}`);
        setup = `The dependency install failed (exit ${install.exitCode}), so tests may not run.`;
      } else setup = ["pnpm", "yarn", "npm", "bun"].includes(out) ? `Dependencies installed with ${out}.` : null;
    }
    await sandbox.stop();
    return { base: sha, baseBranch, files, setup };
  } catch (error) {
    await sandbox.delete().catch(() => sandbox.stop().catch(() => {}));
    throw error;
  }
}

function forkSource(slug: string, repo: string, token: string, base: string) {
  return Sandbox.fork({
    sourceSandbox: base,
    name: sourceName(slug),
    persistent: true,
    timeout: 30 * 60_000,
    resources: { vcpus: 2 },
    networkPolicy: { allow: { ...github(repo, token), "*": [] } },
    tags: { app: TAG, run: slug, role: "source" },
  });
}

/** What an agent's policy is for: its run, the one repo it works on, and whether it may push there. */
export type Scope = { slug: string; repo: string; write: boolean };

/** What an agent may do on the board: read the runs, and work its own run's tasks. Nothing else, so it can't touch another run, or any run's phase. */
export const agentCan = (slug: string) => `${runChannel(slug)}=read,post,react,label`;

/**
 * An agent's network policy: the board as that agent, AI Gateway, and GitHub for the run's repo.
 * Every other host is blocked. It holds this deployment's OIDC token and a GitHub token as they are
 * now, which both live about an hour, so a running run's policies are made again on every reconcile
 * (`refresh`).
 */
async function agentPolicy(n: number, scope: Scope): Promise<{ policy: NetworkPolicy; boardUrl: string }> {
  const token = await oidc();
  const agent = team().as(profileOf(n));
  const [{ allow }, { url }, gh] = await Promise.all([agent.sandboxPolicy({ token, can: agentCan(scope.slug) }), team().discovery(), githubToken(scope.repo, scope.write)]);
  const gateway = process.env.AI_GATEWAY_API_KEY ?? token;
  const policy = {
    allow: {
      ...(allow as Allow),
      "ai-gateway.vercel.sh": [{ transform: [{ headers: { "x-api-key": gateway, authorization: `Bearer ${gateway}` } }] }],
      ...github(scope.repo, gh),
    },
  } as NetworkPolicy;
  return { policy, boardUrl: url };
}

/** An unsigned token with the real one's claims a client reads (its expiry, its team) and no signature: the board's CLI wants one to send, and the policy replaces it. */
function standIn(token: string): string {
  const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({ exp: claims.exp, iat: claims.iat, owner_id: claims.owner_id, project_id: claims.project_id, sub: "stand-in" })}.stand-in`;
}

/** What the board's CLI in a sandbox needs to find the board: where it is, who it writes as, and something to send where the policy puts the credential. */
async function boardEnv(url: string, profile: string): Promise<Record<string, string>> {
  const at = new URL(url);
  if (at.hostname === "localhost" || at.hostname === "127.0.0.1") throw new Error("A sandbox can't reach a board on your machine. Unset BOARD_URL to use your team's board.");
  const env: Record<string, string> = { BOARD_URL: url, BOARD_PROFILE: profile };
  if (at.host !== "api.vercel.com") return { ...env, BOARD_TOKEN: PLACEHOLDER };
  const teamId = at.searchParams.get("teamId");
  return { ...env, VERCEL_OIDC_TOKEN: standIn(await oidc()), ...(teamId ? { VERCEL_ORG_ID: teamId } : {}) };
}

/** Starts agent `n` of a run in a sandbox of its own, forked from the run's checkout. */
export async function startAgent(slug: string, n: number, runner: RunnerConfig, opts: { timeoutMs: number; write: boolean }): Promise<string> {
  const { policy, boardUrl } = await agentPolicy(n, { slug, repo: runner.github, write: opts.write });
  const env = await boardEnv(boardUrl, profileOf(n));
  const sandbox = await Sandbox.fork({
    sourceSandbox: sourceName(slug),
    // Named for its slot and the window it starts in: two reconciles that start slot n at once fork
    // the same name, and the second is refused, so a slot never gets two paid agents. One started
    // again after its agent left is in a later window.
    name: `${agentPrefix(slug)}${n}-${Math.floor(Date.now() / STARTING_MS).toString(36)}`,
    persistent: false,
    timeout: opts.timeoutMs,
    resources: { vcpus: 2 },
    networkPolicy: policy,
    tags: { app: TAG, run: slug, role: "agent" },
  });
  await sandbox.writeFiles([{ path: SANDBOX.config, content: JSON.stringify(runner) }]);
  const home = `${SANDBOX.state}/home`;
  // What the runner prints goes to a file in the sandbox too, for whoever needs to see why an agent stopped.
  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `node runner.ts >> ${SANDBOX.state}/runner.log 2>&1`],
    cwd: SANDBOX.dir,
    env: { ...env, AI_GATEWAY_API_KEY: PLACEHOLDER, HOME: home, XDG_CONFIG_HOME: `${home}/.config`, NODE_NO_WARNINGS: "1" },
    detached: true,
  });
  return sandbox.name;
}

/** The number an agent's sandbox was started as, from its name. */
const agentNumber = (slug: string, name: string) => Number(/^(\d+)-/.exec(name.slice(agentPrefix(slug).length))?.[1] ?? NaN);

/** A sandbox this young may not have started its runner yet: it counts as working. */
const STARTING_MS = 90_000;

/** Every agent sandbox of a run that's up, whatever its runner is doing. */
async function up(slug: string): Promise<{ name: string; n: number; young: boolean }[]> {
  const listed = await Sandbox.list({ namePrefix: agentPrefix(slug), sortBy: "name" });
  const running: { name: string; n: number; young: boolean }[] = [];
  for await (const sandbox of listed) {
    if (sandbox.status !== "running" && sandbox.status !== "pending") continue;
    const n = agentNumber(slug, sandbox.name);
    if (Number.isFinite(n)) running.push({ name: sandbox.name, n, young: Date.now() - sandbox.createdAt < STARTING_MS });
  }
  return running;
}

/**
 * A run's agents that are working, by number. An agent that found nothing to claim exits, and its
 * sandbox would idle until its timeout: one whose runner is gone is stopped here, and isn't counted,
 * so the run starts a new one when there's work again.
 */
export async function agents(slug: string): Promise<{ name: string; n: number }[]> {
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

/** Hands each running agent a new policy, before the tokens in its last one run out. */
export async function refresh(up: { name: string; n: number }[], scope: Scope): Promise<void> {
  await Promise.allSettled(
    up.map(async ({ name, n }) => {
      const [{ policy }, sandbox] = await Promise.all([agentPolicy(n, scope), Sandbox.get({ name })]);
      await sandbox.update({ networkPolicy: policy });
    }),
  );
}

/** Stops sandboxes by name. One that's already gone is fine. */
export async function stop(names: string[]): Promise<void> {
  await Promise.allSettled(names.map(async (name) => (await Sandbox.get({ name })).stop()));
}

/**
 * Ends a run's sandboxes: its agents stop, and its checkout is deleted. It throws while an agent is
 * still up (one that was only just starting can outlive a stop), so whoever called it tries again
 * rather than leaving a sandbox running for nobody.
 */
export async function teardown(slug: string): Promise<void> {
  await stop((await up(slug)).map(({ name }) => name));
  await Sandbox.get({ name: sourceName(slug) })
    .then((sandbox) => sandbox.delete())
    .catch(() => {});
  const left = await up(slug);
  if (left.length) throw new Error(`${left.length} of ${slug}'s sandboxes are still stopping`);
}
