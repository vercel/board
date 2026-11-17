import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { agentPrompt, joinPrompt, markdown } from "../lib/markdown.ts";
import { channel, envVarsPage, projectName, projectOf, slackChannel } from "../lib/project.ts";
import { runningOf } from "../lib/running.ts";
import { boardDeps, hasApp, isDone, setup, stepsView, type Deps, type Step, type Task } from "../lib/setup.ts";
import { CHANNELS, FACTORY, README as TEMPLATE_README } from "./fresh.ts";

// The launcher's steps, driven as the page drives them, against a fake network: what a person sees is
// each step's tasks, done or with what helps do them, and what the outside world sees is the requests it sends.

const jwt = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A production deployment of acme/factory with everything it needs. */
const PRODUCTION = {
  VERCEL_ENV: "production",
  VERCEL_PROJECT_PRODUCTION_URL: "factory.acme.dev",
  VERCEL_GIT_REPO_OWNER: "acme",
  VERCEL_GIT_REPO_SLUG: "factory",
};

type Routes = Record<string, (init?: RequestInit, url?: string) => Response>;

const ROUTES: Routes = {
  "https://factory.acme.dev/icon.svg": () => new Response("", { status: 401 }),
  "https://api.github.com/installation/repositories": () =>
    json({ total_count: 2, repositories: [{ full_name: "acme/factory" }, { full_name: "acme/web" }] }),
  "https://api.github.com/graphql": () => json({ data: { viewer: { login: "acme-factory" } } }),
};

/** What Connect throws for a connector that doesn't exist. */
const notFound = (connector: string) =>
  Promise.reject(Object.assign(new Error(`Connector not found: ${connector}`), { name: "ConnectError", status: 404, code: "not_found" }));


/** This deployment on its board: who the agent writes as, with no profile. */
const DEPLOYMENT = "vercel:project:prj_factory:production";
const me = (can: Record<string, string[]>) => ({ principal: DEPLOYMENT, can });

/** A message by a person, or by the agent. */
const message = (id: string, from: "ada" | "agent", re: string | null = null) =>
  ({ id, re, labels: {}, by: { principal: from === "agent" ? DEPLOYMENT : "vercel:user:u_ada", profile: null, actor: "a" }, createdAt: "2026-11-03T00:00:00.000Z" }) as never;

function fake(options: { env?: Record<string, string | undefined>; routes?: Routes; deps?: Partial<Deps> } = {}) {
  const requests: string[] = [];
  const routes = { ...ROUTES, ...options.routes };
  const deps: Deps = {
    env: options.env ?? PRODUCTION,
    // As the board route configures it, on a deployment of acme/factory.
    synced: {
      connectors: { github: "github/factory", slack: "slack/factory" },
      repoChannels: { "acme/factory": "project-factory/rsi" },
      slackChannels: { "#factory-rsi": "project-factory/rsi" },
      board: null,
      home: "project-factory",
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push(url);
      const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
      if (!route) throw new Error(`no route for ${url}`);
      return route[1](init, url);
    }) as typeof fetch,
    oidc: async () => jwt({ owner: "acme", project: "factory" }),
    // Every connector but Slack's, which a test connects when it needs one.
    connect: async (connector) => (connector.startsWith("slack/") ? notFound(connector) : "app-token"),
    credits: async () => 5,
    // What a new board gives every project on the team.
    me: async () => me({ "*": ["read", "post", "react", "label", "sync"] }),
    messages: async () => [message("12", "ada"), message("13", "agent", "12")],
    threads: async () => [],
    source: sources(() => CHANNELS),
    ...options.deps,
  };
  return { deps, requests };
}

/** The steps a protected deployment shows. */
async function shown(deps: Deps): Promise<Record<string, Step>> {
  const result = await setup(deps);
  assert.equal(result.open, false, "the launcher should show its steps");
  return Object.fromEntries((result.open ? [] : result.steps).map((step) => [step.id, step]));
}
/** What an open deployment shows instead: the one thing to do. */
async function onlyProtect(deps: Deps): Promise<Task> {
  const result = await setup(deps);
  assert.equal(result.open, true, "the launcher should show only how to protect the deployment");
  return (result as { task: Task }).task;
}
const done = (steps: Record<string, Step>) => Object.fromEntries(Object.entries(steps).map(([id, step]) => [id, isDone(step)]));
const todo = (step: Step) => step.tasks.filter((task) => !task.done);
const labels = (tasks: Task[]) => tasks.map((task) => task.label);
const commands = (step: Step) => todo(step).flatMap((task) => task.commands ?? []);
const links = (step: Step) => todo(step).flatMap((task) => (task.link ? [task.link.href] : []));

/** The files the launcher links to are a fresh factory's (fresh.ts), its README the template's. This is one a team has made its own. */
const OWN_README = "# Acme's factory\n\nIt works on acme/web.\n";
const REPO_URL = "https://github.com/acme/factory/blob/main/app/api/board/%5B%5B...path%5D%5D";
const CHANNELS_URL = `${REPO_URL}/channels.ts`;
/** What the launcher reads when it's given another channels.ts. */
const sources = (channels: () => string | undefined, readme: string | undefined = OWN_README): Deps["source"] =>
  (file) => (file.endsWith("/channels.ts") ? channels() : file.endsWith("/factory.ts") ? FACTORY : file === "README.md" ? readme : undefined);

/** The line of `source` a link opens on, in `url`'s file in the factory's repo: what the person lands on. */
function linked(href: string, source = CHANNELS, url = CHANNELS_URL): string {
  const [, line] = /^(?:.+)#L(\d+)$/.exec(href) ?? [];
  assert.ok(href.startsWith(`${url}#L`) && line, `${href} should name a line of ${url}`);
  return source.split("\n")[Number(line) - 1] ?? "";
}

test("a factory that's set up passes every step but Slack, which stays optional", async () => {
  const steps = await shown(fake().deps);
  assert.deepEqual(done(steps), { vercel: true, github: true, slack: false, try: true });
  assert.equal(steps.slack!.optional, true);
});

test("it asks for no secret to get through its own protection, and shows no balance", async () => {
  const { vercel } = await shown(fake({ deps: { credits: async () => 16.44 } }).deps);
  assert.deepEqual(vercel!.tasks, [
    { label: "Turn on Deployment Protection", done: true },
    { label: "Open the team's board once", done: true },
    { label: "Add AI Gateway credits", done: true },
  ]);
});

test("GitHub counts the repos the app is on that come into no channel, and links to where one is added", async () => {
  // The app is on acme/factory, which comes into its channel on its own, and acme/web, which no one mapped.
  const { github } = await shown(fake().deps);
  assert.equal(isDone(github!), true);
  const installed = github!.tasks.find((task) => task.hint);
  assert.equal(installed?.hint, "1 repo with the app isn't on the board yet.");
  // The step says how many, in a line: which ones is for the field that onboards one.
  const several = await shown(
    fake({
      routes: {
        "https://api.github.com/installation/repositories": () =>
          json({ total_count: 4, repositories: ["factory", "web", "payroll", "acquisition"].map((name) => ({ full_name: `acme/${name}` })) }),
      },
    }).deps,
  );
  assert.equal(several.github!.tasks.find((task) => task.hint)?.hint, "3 repos with the app aren't on the board yet.");
  assert.ok(!JSON.stringify(Object.values(several)).includes("payroll"));
  // The link opens where the map of repos starts.
  assert.match(linked(installed!.link!.href), /^export const repoChannels\b/);
});

/** A page of an installation's repos, as GitHub pages them: 100 to a page, named so they sort in order. */
const pages = (total: number) => (_init?: RequestInit, url = "") => {
  const page = Number(new URL(url).searchParams.get("page") ?? 1);
  const names = Array.from({ length: total }, (_, i) => (i === 0 ? "acme/factory" : `acme/repo-${String(i).padStart(4, "0")}`));
  return json({ total_count: total, repositories: names.slice((page - 1) * 100, page * 100).map((full_name) => ({ full_name })) });
};
const repoPages = (requests: string[]) => requests.filter((url) => url.includes("/installation/repositories")).map((url) => new URL(url).searchParams.get("page"));

test("the checks name the repos with the app that come into no channel, in order, for the page to suggest", async () => {
  const { deps, requests } = fake({
    routes: {
      "https://api.github.com/installation/repositories": () =>
        json({ total_count: 4, repositories: ["web", "factory", "Payroll", "acquisition"].map((name) => ({ full_name: `acme/${name}` })) }),
    },
  });
  const result = await setup(deps);
  // acme/factory comes into its own channel, so it isn't one to onboard.
  assert.deepEqual(result.open ? null : result.found.unmapped, ["acme/acquisition", "acme/Payroll", "acme/web"]);
  // One page was enough, and one was asked for.
  assert.deepEqual(repoPages(requests), ["1"]);
  // A deployment anyone can open is told how to close it, and nothing of what the app can see.
  const open = await setup(fake({ routes: { "https://factory.acme.dev/icon.svg": () => new Response("", { status: 200 }) } }).deps);
  assert.equal(open.open, true);
  assert.ok(!JSON.stringify(open).includes("acme/web"), JSON.stringify(open));
});

test("the app's repos are read past GitHub's first page, a hundred at a time, and no further than ten pages", async () => {
  const some = fake({ routes: { "https://api.github.com/installation/repositories": pages(150) } });
  const read = await setup(some.deps);
  assert.deepEqual(repoPages(some.requests).sort(), ["1", "2"]);
  assert.equal(read.open ? null : read.found.waiting, 149);
  assert.equal(read.open ? null : read.found.unmapped.at(-1), "acme/repo-0149");
  // A full last page isn't followed by an empty one.
  const exact = fake({ routes: { "https://api.github.com/installation/repositories": pages(200) } });
  await setup(exact.deps);
  assert.deepEqual(repoPages(exact.requests).sort(), ["1", "2"]);
  // More than it reads: it names what it read, and doesn't say how many are left out.
  const many = fake({ routes: { "https://api.github.com/installation/repositories": pages(1500) } });
  const capped = await setup(many.deps);
  assert.equal(repoPages(many.requests).length, 10);
  assert.equal(capped.open ? null : capped.found.waiting, null);
  assert.equal(capped.open ? null : capped.found.unmapped.length, 999);
});

test("a later page of the app's repos that fails costs what came after it, not the step", async () => {
  // 350 repos, and GitHub fails the third page of four.
  const all = pages(350);
  const { deps } = fake({
    routes: { "https://api.github.com/installation/repositories": (init, url = "") => (new URL(url).searchParams.get("page") === "3" ? json({ message: "Server Error" }, 502) : all(init, url)) },
  });
  const result = await setup(deps);
  assert.equal(result.open, false);
  if (result.open) return;
  // The step stands on the first page, as it did when that was all it read.
  assert.equal(isDone(result.steps[1]!), true);
  // What was read before the gap is named, in order, and nothing is concluded about the rest.
  assert.deepEqual([result.found.unmapped.length, result.found.unmapped.at(-1)], [199, "acme/repo-0199"]);
  assert.equal(result.found.waiting, null);
  // A repo GitHub lists on two pages, as when one is added between two reads, is named once, and
  // counted once: 150 repos whose second page repeats the first's are 100 read, so not all of them.
  const repeats = pages(150);
  const twice = await setup(fake({ routes: { "https://api.github.com/installation/repositories": (init, url = "") => repeats(init, url.replace(/&page=\d+/, "&page=1")) } }).deps);
  assert.equal(twice.open ? null : twice.found.unmapped.length, 99);
  assert.equal(twice.open ? undefined : twice.found.waiting, null);
  assert.ok(!JSON.stringify(twice.open ? [] : twice.steps).includes("with the app"), "the step counts no repos it didn't read");
  // The first page failing is still the step's to say.
  const none = await setup(fake({ routes: { "https://api.github.com/installation/repositories": () => json({ message: "Server Error" }, 502) } }).deps);
  assert.deepEqual(none.open ? [] : none.steps[1]!.tasks.filter((task) => !task.done).map((task) => task.label), ["Couldn't list the app's repos"]);
});

test("whether the GitHub app is on a repo is told from every repo it's on, however the repo was typed, and not told from fewer", async () => {
  const some = await setup(fake({ routes: { "https://api.github.com/installation/repositories": pages(150) } }).deps);
  assert.equal(some.open, false);
  if (some.open) return;
  // On it, as GitHub writes its name.
  assert.equal(hasApp("ACME/Repo-0007", some.found), "acme/repo-0007");
  // Every repo was read, and it isn't one of them.
  assert.equal(hasApp("acme/elsewhere", some.found), false);
  assert.equal(hasApp("acme/repo-000", some.found), false);
  // More repos than one check reads: a repo past them may well have the app.
  const capped = await setup(fake({ routes: { "https://api.github.com/installation/repositories": pages(1500) } }).deps);
  assert.equal(capped.open ? undefined : hasApp("acme/repo-1400", capped.found), null);
  assert.equal(capped.open ? undefined : hasApp("acme/repo-0007", capped.found), "acme/repo-0007");
  // No connector, so nobody was asked.
  const none = await setup(fake({ deps: { connect: (connector) => notFound(connector) } }).deps);
  assert.equal(none.open ? undefined : hasApp("acme/web", none.found), null);
});

test("the agent's tool reads the page's steps and the factory's repos, and about one repo at a time whether the GitHub app is on it", async () => {
  const { deps } = fake({
    routes: {
      "https://api.github.com/installation/repositories": () =>
        json({ total_count: 3, repositories: ["factory", "web", "api"].map((name) => ({ full_name: `acme/${name}` })) }),
    },
  });
  const result = await setup(deps);
  assert.equal(result.open, false);
  if (result.open) return;
  const view = stepsView(result, deps.synced);
  assert.deepEqual(view.steps.map((step) => [step.title, step.done, step.optional]), [["Vercel", true, false], ["GitHub", true, false], ["Slack", false, true], ["Try it", true, false]]);
  // A task keeps what helps do it: the agent quotes the command.
  assert.deepEqual(view.steps[2]!.tasks[0], result.steps[2]!.tasks[0]);
  assert.match(view.steps[2]!.tasks[0]!.commands![0]!, /^vercel connect create slack /);
  // How many repos it works on, and how many more have the app: not which. The agent answers people
  // who aren't on the team, and a thread about one repo has no business with the others' names.
  assert.deepEqual(view.repos, { onboarded: 1, waiting: 2 });
  for (const name of ["acme/api", "acme/web", "acme/factory", "project-factory/rsi"]) assert.ok(!JSON.stringify(view.repos).includes(name), name);
  assert.equal("asked" in view, false);
  // Asked about one repo, it says what its own GitHub access can't: the app is on it, as GitHub writes its name.
  assert.deepEqual(stepsView(result, deps.synced, "ACME/Web").asked, { repo: "acme/web", onboarded: false, app: true });
  for (const other of ["acme/api", "acme/factory"]) assert.ok(!JSON.stringify([stepsView(result, deps.synced, "acme/web").repos, stepsView(result, deps.synced, "acme/web").asked]).includes(other), other);
  // Or it isn't, or the repo is already in, with where it shows.
  assert.deepEqual(stepsView(result, deps.synced, "acme/elsewhere").asked, { repo: "acme/elsewhere", onboarded: false, app: false });
  assert.deepEqual(stepsView(result, deps.synced, "Acme/Factory").asked, { onboarded: true, repo: "acme/factory", channel: "project-factory/rsi", slack: "#factory-rsi" });
  // And when the checks couldn't read every repo, it says it couldn't tell, so nothing is concluded from a repo's absence.
  const capped = await setup(fake({ routes: { "https://api.github.com/installation/repositories": pages(1500) } }).deps);
  assert.deepEqual(capped.open ? undefined : stepsView(capped, deps.synced, "acme/repo-1400").asked, { repo: "acme/repo-1400", onboarded: false, app: null });
  assert.equal(capped.open ? undefined : stepsView(capped, deps.synced).repos.waiting, null);
});

test("an app that's on no repo is known to be on none, so no repo is taken for one it might be on", async () => {
  // The connector is there and its app was never installed.
  const never = await setup(fake({ deps: { connect: async (connector) => (connector.startsWith("github/") ? Promise.reject(Object.assign(new Error("install it"), { name: "ConnectorInstallationRequiredError" })) : notFound(connector)) } }).deps);
  assert.equal(never.open ? undefined : hasApp("acme/web", never.found), false);
  // Installed, and on nothing.
  const empty = await setup(fake({ routes: { "https://api.github.com/installation/repositories": () => json({ total_count: 0, repositories: [] }) } }).deps);
  assert.equal(empty.open ? undefined : hasApp("acme/web", empty.found), false);
  assert.equal(empty.open ? undefined : empty.found.waiting, 0);
});

test("the checks count the pull requests the factory opened in its repos, as GitHub counts them, and say nothing when it doesn't", async () => {
  // GitHub's GraphQL, faked: who the token is, and how many pull requests each search finds.
  const searches: Record<string, string>[] = [];
  const graphql = (counts: object | null) => (init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables?: Record<string, string> };
    if (query.includes("viewer")) return json({ data: { viewer: { login: "acme-factory[bot]" } } });
    searches.push(variables ?? {});
    return json(counts ? { data: counts } : { errors: [{ message: "something went wrong" }] });
  };
  const base = fake().deps.synced;
  const synced = { ...base, repoChannels: { ...base.repoChannels, "acme/web": "project-factory/web" } };
  const counted = await setup(fake({ deps: { synced }, routes: { "https://api.github.com/graphql": graphql({ open: { issueCount: 2 }, merged: { issueCount: 1 }, closed: { issueCount: 0 } }) } }).deps);
  assert.deepEqual(counted.open ? null : counted.found.pulls, { open: 2, merged: 1, closed: 0 });
  // One request asked for all three, each for this app's pull requests in the factory's repos and no others: a team may use the app elsewhere.
  assert.equal(searches.length, 1);
  const repos = "is:pr author:app/acme-factory repo:acme/factory repo:acme/web";
  assert.deepEqual(searches[0], { open: `${repos} is:open`, merged: `${repos} is:merged`, closed: `${repos} is:closed is:unmerged` });
  // GitHub answered with an error: no count, and the step is as done as it was.
  const failed = await setup(fake({ routes: { "https://api.github.com/graphql": graphql(null) } }).deps);
  assert.equal(failed.open ? undefined : failed.found.pulls, null);
  assert.equal(failed.open ? undefined : isDone(failed.steps[1]!), true);
  // Half an answer is no count either.
  const half = await setup(fake({ routes: { "https://api.github.com/graphql": graphql({ open: { issueCount: 2 }, merged: null }) } }).deps);
  assert.equal(half.open ? undefined : half.found.pulls, null);
  // And a search that never answers costs the count, not the step.
  const answered = graphql(null);
  const down = await setup(
    fake({
      routes: {
        "https://api.github.com/graphql": (init) => {
          if (String(init?.body).includes("viewer")) return answered(init);
          throw new Error("socket hang up");
        },
      },
    }).deps,
  );
  assert.equal(down.open ? undefined : down.found.pulls, null);
  assert.equal(down.open ? undefined : isDone(down.steps[1]!), true);
});

test("once it runs, the page shows what one check found: the factory's pull requests, its repos, and what onboards another", async () => {
  const graphql = (init?: RequestInit) =>
    String(init?.body).includes("viewer")
      ? json({ data: { viewer: { login: "acme-factory[bot]" } } })
      : json({ data: { open: { issueCount: 2 }, merged: { issueCount: 1 }, closed: { issueCount: 0 } } });
  const { deps } = fake({
    routes: {
      "https://api.github.com/graphql": graphql,
      "https://api.github.com/installation/repositories": () => json({ total_count: 3, repositories: ["factory", "web", "api"].map((name) => ({ full_name: `acme/${name}` })) }),
    },
  });
  const where = { origin: "https://factory.acme.dev", team: "acme", board: null, repo: "acme/factory" };
  // The day after the thread the fake board holds.
  const now = new Date("2026-11-04T12:00:00.000Z");
  const running = runningOf(await setup(deps), deps.synced, where, now);
  assert.ok(running);
  // GitHub's count of what the factory opened, as the checks read it.
  assert.deepEqual(running.overview.pulls, { open: 2, merged: 1, closed: 0 });
  assert.deepEqual(running.repos, [{ repo: "acme/factory", channel: "project-factory/rsi", slack: "#factory-rsi" }]);
  // Another repo is asked for where the factory changes itself, and the field suggests the ones with the app.
  assert.deepEqual(running.ask, { channel: "project-factory/rsi", slack: "#factory-rsi", waiting: 2, suggest: ["acme/api", "acme/web"], install: "https://github.com/apps/acme-factory/installations/new" });
  assert.ok(running.join.includes("vercel board read project-factory/ --scope acme"));
  assert.equal(running.first, null);
  // The week is read from the same check: the thread the fake board holds, which the agent answered.
  assert.deepEqual([running.overview.week.threads, running.overview.week.messages, running.overview.week.answered], [1, 2, 1]);
  // A factory with a required step left shows its steps, not this: here, no GitHub connector.
  const unset = fake({ deps: { connect: (connector) => notFound(connector) } });
  assert.equal(runningOf(await setup(unset.deps), unset.deps.synced, where, now), null);
  // And one anyone can open shows only how to close it.
  const open = fake({ routes: { "https://factory.acme.dev/icon.svg": () => new Response("", { status: 200 }) } });
  assert.equal(runningOf(await setup(open.deps), open.deps.synced, where, now), null);
});

test("the checks find where the GitHub app is added to more repos, by the app's own name, and nowhere when GitHub doesn't say it", async () => {
  const found = async (deps: Deps) => {
    const result = await setup(deps);
    return result.open ? undefined : result.found.install;
  };
  // GitHub names the app's bot, and the app is that without the suffix.
  const bot = fake({ routes: { "https://api.github.com/graphql": () => json({ data: { viewer: { login: "acme-factory[bot]" } } }) } });
  assert.equal(await found(bot.deps), "https://github.com/apps/acme-factory/installations/new");
  assert.equal(await found(fake({ routes: { "https://api.github.com/graphql": () => json({}, 502) } }).deps), null);
  // With no connector there's no app to name.
  assert.equal(await found(fake({ deps: { connect: (connector) => notFound(connector) } }).deps), null);
});

test("GitHub asks Connect for a token that writes to the factory's own repo alone, as the agent's turns do", async () => {
  const asked: unknown[] = [];
  const { github } = await shown(fake({ deps: { connect: async (connector, scope) => (asked.push(scope ?? null), connector.startsWith("slack/") ? notFound(connector) : "app-token") } }).deps);
  assert.equal(isDone(github!), true);
  assert.deepEqual(asked.filter(Boolean), [[{ type: "github_app_installation", org: "acme", repositories: ["factory"], permissions: ["contents:write"] }]]);
});

test("GitHub isn't done until the app can write to the factory's own repo", async () => {
  // GitHub refuses a token with contents:write for an app that can't write there.
  const { github } = await shown(
    fake({ deps: { connect: async (connector, scope) => (scope ? Promise.reject(new Error("GitHub installation token failed")) : connector.startsWith("slack/") ? notFound(connector) : "app-token") } }).deps,
  );
  assert.deepEqual(todo(github!).map((task) => [task.label, task.hint]), [["Let the app write to `acme/factory`", "So the agent can change its own code."]]);
  assert.deepEqual(links(github!), ["https://github.com/apps/acme-factory/installations/new"]);
});

test("GitHub says nothing more when every repo the app is on comes in", async () => {
  const { github } = await shown(
    fake({ routes: { "https://api.github.com/installation/repositories": () => json({ total_count: 1, repositories: [{ full_name: "acme/factory" }] }) } }).deps,
  );
  assert.deepEqual(github!.tasks.filter((task) => task.hint || task.link), []);
});

test("an open production shows only how to protect it, and asks nothing of GitHub or the board", async () => {
  let read = false;
  const { deps, requests } = fake({
    routes: { "https://factory.acme.dev/icon.svg": () => new Response("<svg/>", { status: 200 }) },
    deps: { messages: async () => ((read = true), []), me: async () => ((read = true), me({})) },
  });
  const task = await onlyProtect(deps);
  assert.equal(task.link?.href, "https://vercel.com/acme/factory/settings/deployment-protection");
  assert.deepEqual(requests, ["https://factory.acme.dev/icon.svg"]);
  assert.equal(read, false);
});

test("an open preview shows only how to protect it, even while production is closed", async () => {
  const { deps, requests } = fake({
    deps: { host: "factory-git-fix-acme.vercel.app" },
    routes: { "https://factory-git-fix-acme.vercel.app/icon.svg": () => new Response("<svg/>", { status: 200 }) },
  });
  await onlyProtect(deps);
  assert.deepEqual(requests, ["https://factory-git-fix-acme.vercel.app/icon.svg"]);
});

test("a protection check that fails shows nothing else, as if the deployment were open", async () => {
  const { deps, requests } = fake({ deps: { host: "unreachable.acme.dev" } });
  const task = await onlyProtect(deps);
  assert.match(task.label, /Couldn't check that this deployment is protected/);
  assert.match(task.hint ?? "", /no route for https:\/\/unreachable\.acme\.dev/);
  assert.deepEqual(requests, ["https://unreachable.acme.dev/icon.svg"]);
});

test("a team whose board nobody has opened yet is told to open it once, with the command that does", async () => {
  // What board() throws for a project the API names no board to: a team has one once a person has used it.
  const refused = Object.assign(new Error("this project has no access to the team's board (prj_factory, production)."), { code: "board_not_granted" });
  const { vercel, try: tryIt } = await shown(fake({ deps: { me: () => Promise.reject(refused) } }).deps);
  assert.deepEqual(labels(todo(vercel!)), ["Open the team's board once"]);
  assert.deepEqual(commands(vercel!), ["npx @vercel/board inspect --scope acme"]);
  // Try it waits on the board: its tasks are still to do, with nothing of the board's error under them.
  assert.deepEqual(tryIt!.tasks, [
    { label: "Give it its first task", done: false },
    { label: "Get a reply from the agent", done: false },
  ]);
});

test("a board that can't be reached for another reason says what it answered", async () => {
  const { vercel } = await shown(fake({ deps: { me: () => Promise.reject(new Error("Vercel's API answered 503")) } }).deps);
  assert.equal(todo(vercel!)[0]?.hint, "Vercel's API answered 503");
  assert.deepEqual(commands(vercel!), []);
});

test("a project the board's grants don't let sync isn't ready, and is told who can let it, with no grant of the launcher's own", async () => {
  const { vercel } = await shown(fake({ deps: { me: async () => me({ "*": ["read", "post", "react", "label"] }) } }).deps);
  assert.deepEqual(todo(vercel!).map((task) => [task.label, task.hint]), [
    ["Let this project sync on the board", "Its grants were narrowed. Whoever manages the board can widen them."],
  ]);
  assert.deepEqual(commands(vercel!), []);
});

test("sync in one channel pattern is enough for the Vercel step", async () => {
  const { vercel } = await shown(fake({ deps: { me: async () => me({ "*": ["read"], "dev/": ["read", "post", "sync"] }) } }).deps);
  assert.equal(isDone(vercel!), true);
});

test("a GitHub connector that isn't attached says how to create and attach it, a command per box", async () => {
  const { github } = await shown(fake({ deps: { connect: async () => Promise.reject(new Error("connector not found")) } }).deps);
  assert.equal(isDone(github!), false);
  assert.deepEqual(commands(github!), [
    "vercel connect create github --name factory --triggers --trigger-project factory --trigger-path /api/board/webhooks/github --scope acme",
  ]);
});

/** What Connect throws this project for a connector that's on its team for another project. */
const notLinked = () => Promise.reject(Object.assign(new Error("Connector is not linked to this project"), { name: "ConnectError", status: 403, code: "forbidden" }));

test("a connector another project on the team has is attached, not created again, with where to name another", async () => {
  // A team has one connector per name: creating github/factory again answers 409.
  const { github, slack } = await shown(fake({ deps: { connect: notLinked } }).deps);
  assert.deepEqual(labels(todo(github!)), ["Attach `github/factory` to this project", "Install its app on your repos"]);
  assert.deepEqual(commands(github!), ["vercel connect attach github/factory --triggers --trigger-path /api/board/webhooks/github --project factory --scope acme"]);
  assert.equal(todo(github!)[0]!.hint, "It's on this team for another project.");
  // The link opens where this factory's connectors are named.
  assert.match(linked(links(github!)[0]!, FACTORY, `${REPO_URL}/factory.ts`), /^export const connectors\b/);
  assert.deepEqual(labels(todo(slack!)), ["Attach `slack/factory` to this project", "Invite the app to `#factory-rsi`"]);
  assert.deepEqual(commands(slack!), ["vercel connect attach slack/factory --triggers --trigger-path /api/board/webhooks/slack --project factory --scope acme"]);
});

test("GitHub isn't done until the app is on the factory's own repo", async () => {
  const { github } = await shown(
    fake({
      routes: { "https://api.github.com/installation/repositories": () => json({ total_count: 1, repositories: [{ full_name: "acme/web" }] }) },
    }).deps,
  );
  assert.deepEqual(labels(todo(github!)), ["Install the app on `acme/factory`"]);
  assert.deepEqual(links(github!), ["https://github.com/apps/acme-factory/installations/new"]);
});

test("an app GitHub lists with every permission false is done once it can write", async () => {
  // How GitHub answers /installation/repositories for an app's token, whatever the app may do.
  const { github } = await shown(
    fake({
      routes: {
        "https://api.github.com/installation/repositories": () =>
          json({ total_count: 1, repositories: [{ full_name: "acme/factory", permissions: { admin: false, push: false, pull: false } }] }),
      },
    }).deps,
  );
  assert.equal(isDone(github!), true);
});

test("Slack without its connector shows how to create it, then to invite its app", async () => {
  const { slack } = await shown(fake().deps);
  assert.deepEqual(labels(todo(slack!)), ["Create a Slack connector", "Invite the app to `#factory-rsi`"]);
  assert.deepEqual(commands(slack!), [
    "vercel connect create slack --name factory --triggers --trigger-project factory --trigger-path /api/board/webhooks/slack --scope acme",
  ]);
});

/** Slack's users.conversations as Connect's Slack app gets it: channels:read, but not groups:read. */
const conversations = (...channels: { id: string; name: string }[]) => (_init?: RequestInit, url = "") =>
  url.includes("private_channel") ? json({ ok: false, error: "missing_scope", needed: "groups:read" }) : json({ ok: true, channels });

test("Slack set up without its app in the channel says to invite it, and holds up nothing", async () => {
  const { deps, requests } = fake({
    deps: { connect: async () => "app-token" },
    routes: {
      "https://slack.com/api/auth.test": () => json({ ok: true, team: "Acme", user: "factory" }),
      "https://slack.com/api/users.conversations": conversations({ id: "C1", name: "general" }),
    },
  });
  const steps = await shown(deps);
  assert.deepEqual(labels(todo(steps.slack!)), ["Invite the app to `#factory-rsi`"]);
  assert.deepEqual(commands(steps.slack!), ["/invite @factory"]);
  // It says what the channel is for, in a line, and links to the line that names it, in this factory's own repo.
  assert.equal(todo(steps.slack!)[0]!.hint, "Where the factory updates itself.");
  // The template puts the channel's name together from the project's: that entry is the line.
  const [href] = links(steps.slack!);
  assert.match(linked(href!), /^\s*\[slackChannel\("-rsi"\)\]: channel\("rsi"\),$/);
  assert.ok(requests.includes("https://slack.com/api/auth.test"));
  assert.deepEqual(Object.values(steps).filter((step) => !step.optional && !isDone(step)), []);
});

/** Slack connected, its app in no channel yet: the step that links to the channel's line. */
const uninvited = (channels: () => string | undefined) =>
  fake({
    deps: { connect: async () => "app-token", source: sources(channels) },
    routes: {
      "https://slack.com/api/auth.test": () => json({ ok: true, team: "Acme", user: "factory" }),
      "https://slack.com/api/users.conversations": conversations(),
    },
  }).deps;

test("the link to the Slack channel follows its line after someone edits channels.ts", async () => {
  // A factory that added repos above its Slack channels, put another channel first, and wrote its own
  // in single quotes under a comment that names it.
  const edited = CHANNELS.replace('  // "acme/web": channel("web"),', '  "acme/web": channel("web"),\n  "acme/api": channel("api"),\n  "acme/docs": channel("docs"),').replace(
    '  [slackChannel("-rsi")]: channel("rsi"),',
    `  "#web": channel("web"),\n  // '#factory-rsi' is where the factory updates itself.\n  '#factory-rsi': channel("rsi"),`,
  );
  assert.equal(edited.split("\n").length, CHANNELS.split("\n").length + 4);
  const [href] = links((await shown(uninvited(() => edited))).slack!);
  assert.match(linked(href!, edited), /^\s*'#factory-rsi': channel\("rsi"\)/);
  // And not on the line it had before the edit.
  assert.notEqual(href, links((await shown(uninvited(() => CHANNELS))).slack!)[0]);
});

test("a channels.ts that can't be read, or doesn't name the channel on a line, is linked as a file", async () => {
  assert.deepEqual(links((await shown(uninvited(() => undefined))).slack!), [CHANNELS_URL]);
  assert.deepEqual(links((await shown(uninvited(() => "export const slackChannels = channelsFromEnv();\n"))).slack!), [CHANNELS_URL]);
  // A map with no entry has no line of its own: not its comment, not its closing brace.
  assert.deepEqual(links((await shown(uninvited(() => "export const slackChannels = {\n  // none yet\n};\n"))).slack!), [CHANNELS_URL]);
});

test("what's named for the Vercel project follows its name, so two factories on a team don't collide", () => {
  // Vercel names the project on a deployment.
  assert.equal(projectName({ VERCEL_PROJECT_NAME: "acme-factory" }), "acme-factory");
  // A dev server has no VERCEL_PROJECT_NAME: its project is the one the token it pulled names.
  assert.equal(projectName({ VERCEL_OIDC_TOKEN: jwt({ owner: "acme", project: "web-factory" }) }), "web-factory");
  // Signed out, with nothing to name it for.
  assert.equal(projectName({}), "factory");
  assert.equal(slackChannel("-rsi", { VERCEL_PROJECT_NAME: "acme-factory" }), "#acme-factory-rsi");
  // Vercel takes a dot in a project's name and 100 characters. Slack takes neither in a channel's: 80 at most.
  assert.equal(slackChannel("-rsi", { VERCEL_PROJECT_NAME: "acme.factory" }), "#acme-factory-rsi");
  assert.equal(slackChannel("-rsi", { VERCEL_PROJECT_NAME: "f".repeat(100) }), `#${"f".repeat(76)}-rsi`);
  // A board's channel takes no dot either, and 80 characters with what's under it.
  assert.equal(channel(undefined, { VERCEL_PROJECT_NAME: "acme.factory" }), "project-acme-factory");
  assert.equal(channel("web", { VERCEL_PROJECT_NAME: "acme.factory" }), "project-acme-factory/web");
  assert.equal(channel("web", { VERCEL_PROJECT_NAME: "f".repeat(100) }), `project-${"f".repeat(40)}/web`);
});

test("the page where a project keeps its secrets is its own, on its team, from the token it runs with", () => {
  // What the agent links when it needs a key: this project's environment variables, not a place to look for them.
  assert.equal(envVarsPage(projectOf(jwt({ owner: "acme", project: "web-factory" }))), "https://vercel.com/acme/web-factory/settings/environment-variables");
  // A token that names no project gives no page: the agent says where in words.
  assert.equal(envVarsPage(projectOf("not-a-token")), null);
  assert.equal(envVarsPage(projectOf(jwt({ owner: "acme" }))), null);
});

/** This checkout's own config as a deployment with `env` loads it: where each repo and Slack channel comes in, and what its agent hears. */
function configured(env: Record<string, string>): { repos: Record<string, string>; slack: Record<string, string>; hears: string } {
  const script = `
    const { hears } = await import("./app/api/board/[[...path]]/factory.ts");
    const { repoChannels, slackChannels } = await import("./app/api/board/[[...path]]/channels.ts");
    console.log(JSON.stringify({ repos: repoChannels, slack: slackChannels, hears }));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), env: { PATH: process.env.PATH, NODE_ENV: "test", ...env }, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

test("this factory's own channels.ts, whatever it has onboarded, brings every repo and Slack channel into a board channel its agent hears, and none another factory's agent hears", () => {
  // The one test that reads this checkout's config. It names nothing a factory adds, so it holds
  // once repos are onboarded, and fails for one that comes in where the agent wouldn't hear it.
  const git = { VERCEL_GIT_REPO_OWNER: "acme", VERCEL_GIT_REPO_SLUG: "factory" };
  const into = (config: ReturnType<typeof configured>) => [...new Set([...Object.values(config.repos), ...Object.values(config.slack)])];
  const acme = configured({ VERCEL_PROJECT_NAME: "acme-factory", ...git });
  assert.equal(acme.hears, "project-acme-factory/");
  // Its own repo, on a deployment from Git, comes into the channel where it changes itself.
  assert.equal(acme.repos["acme/factory"], "project-acme-factory/rsi");
  assert.deepEqual(into(acme).filter((to) => !to.startsWith(acme.hears)), []);
  // The same code as the team's second factory, on a dev server: board channels of its own, none shared.
  // Nothing here says its Slack channels or connectors differ: a factory may name those itself.
  const web = configured({ VERCEL_OIDC_TOKEN: jwt({ owner: "acme", project: "web-factory" }), ...git });
  assert.equal(web.hears, "project-web-factory/");
  assert.equal(web.repos["acme/factory"], "project-web-factory/rsi");
  assert.deepEqual(into(web).filter((to) => !to.startsWith(web.hears)), []);
});

test("a Slack channel that mirrors a repo's channel is said to be that, not the factory's own", async () => {
  // As the agent leaves it after onboarding acme/web, before anyone invites the app to the new channel.
  const base = fake().deps.synced;
  const synced = { ...base, slackChannels: { ...base.slackChannels, "#factory-web": "project-factory/web" } };
  const routes = (...channels: { id: string; name: string }[]) => ({
    "https://slack.com/api/auth.test": () => json({ ok: true, team: "Acme", user: "factory" }),
    "https://slack.com/api/users.conversations": conversations(...channels),
  });
  const web = await shown(fake({ deps: { connect: async () => "app-token", synced }, routes: routes({ id: "C2", name: "factory-rsi" }) }).deps);
  assert.deepEqual(labels(todo(web.slack!)), ["Invite the app to `#factory-web`"]);
  assert.equal(todo(web.slack!)[0]!.hint, "Where project-factory/web shows in Slack.");
  // In neither: one task for both, and a line that's true of both.
  const both = await shown(fake({ deps: { connect: async () => "app-token", synced }, routes: routes({ id: "C1", name: "general" }) }).deps);
  assert.deepEqual(labels(todo(both.slack!)), ["Invite the app to `#factory-rsi`, `#factory-web`"]);
  assert.equal(todo(both.slack!)[0]!.hint, "Where the factory's channels show in Slack.");
});

test("Slack's app in its channel, by name, is done", async () => {
  const { slack } = await shown(
    fake({
      deps: { connect: async () => "app-token" },
      routes: {
        "https://slack.com/api/auth.test": () => json({ ok: true, team: "Acme", user: "factory" }),
        "https://slack.com/api/users.conversations": conversations({ id: "C2", name: "factory-rsi" }),
      },
    }).deps,
  );
  assert.equal(isDone(slack!), true);
});

test("a private channel mapped by its ID, which Connect's app can't list, is done once the app can read it", async () => {
  // Connect's Slack app has groups:history but not groups:read: a private channel never shows in
  // users.conversations, but reading it works once the app's in it.
  const base = fake().deps.synced;
  const synced = { ...base, slackChannels: { ...base.slackChannels, C0PRIVATE: "project-factory/alerts" } };
  const checked = (history: () => Response) =>
    fake({
      deps: { connect: async () => "app-token", synced },
      routes: {
        "https://slack.com/api/auth.test": () => json({ ok: true, team: "Acme", user: "factory" }),
        "https://slack.com/api/users.conversations": conversations({ id: "C2", name: "factory-rsi" }),
        "https://slack.com/api/conversations.history": history,
      },
    });
  const inside = checked(() => json({ ok: true, messages: [] }));
  assert.equal(isDone((await shown(inside.deps)).slack!), true);
  // It asks about that channel alone: the one it found in the list needs no second request.
  assert.deepEqual(inside.requests.filter((url) => url.includes("conversations.history")), ["https://slack.com/api/conversations.history?channel=C0PRIVATE&limit=1"]);
  // Outside it, Slack says a private channel isn't there, and a public one that the app isn't in it.
  for (const error of ["channel_not_found", "not_in_channel"]) {
    const { slack } = await shown(checked(() => json({ ok: false, error })).deps);
    assert.deepEqual(labels(todo(slack!)), ["Invite the app to `C0PRIVATE`"]);
    assert.deepEqual(commands(slack!), ["/invite @factory"]);
  }
  // Slack not answering isn't the app being outside: nobody is sent to invite an app that's already in.
  const { slack } = await shown(checked(() => json({ ok: false, error: "ratelimited" })).deps);
  assert.deepEqual(labels(todo(slack!)), ["Couldn't ask Slack which channels the app is in"]);
  assert.match(todo(slack!)[0]!.hint ?? "", /ratelimited/);
});

test("a channel mapped by its name is looked for in the app's channels only", async () => {
  // A name isn't an ID Slack can read by, so there's nothing more to ask.
  const { deps, requests } = fake({
    deps: { connect: async () => "app-token" },
    routes: {
      "https://slack.com/api/auth.test": () => json({ ok: true, team: "Acme", user: "factory" }),
      "https://slack.com/api/users.conversations": conversations({ id: "C1", name: "general" }),
    },
  });
  assert.deepEqual(labels(todo((await shown(deps)).slack!)), ["Invite the app to `#factory-rsi`"]);
  assert.deepEqual(requests.filter((url) => url.includes("conversations.history")), []);
});

/** A reply by this deployment under a profile. */
const under = (profile: string) => ({ id: "13", re: "12", labels: {}, by: { principal: DEPLOYMENT, profile, actor: "a" } }) as never;

test("what the deployment's watcher wrote, or its sync brought in, isn't the agent's reply", async () => {
  const steps = await shown(fake({ deps: { messages: async () => [message("12", "ada"), under("wake"), under("github:user:583231")] } }).deps);
  assert.deepEqual(labels(todo(steps.try!)), ["Get a reply from the agent"]);
});

test("a reply from when the agent wrote under a profile of its own still counts", async () => {
  // A factory set up before its agent wrote as the factory itself: its replies are under `factory`.
  const steps = await shown(fake({ deps: { messages: async () => [message("12", "ada"), under("factory")] } }).deps);
  assert.equal(isDone(steps.try!), true);
});

test("try reads this factory's channels, and no one else's: its own and the ones under it, in one read", async () => {
  const asked: unknown[] = [];
  await shown(fake({ deps: { messages: async (query) => (asked.push(query), []) } }).deps);
  assert.deepEqual(asked, [{ channel: "project-factory/", limit: 200 }]);
});

test("try isn't done until someone has posted and the agent has replied", async () => {
  const nothing = await shown(fake({ deps: { messages: async () => [] } }).deps);
  assert.deepEqual(labels(todo(nothing.try!)), ["Give it its first task", "Get a reply from the agent"]);
  const unanswered = await shown(fake({ deps: { messages: async () => [message("12", "ada")] } }).deps);
  assert.deepEqual(labels(todo(unanswered.try!)), ["Get a reply from the agent"]);
});

test("try says how to open the board in its own step, on this team and by the board's name, so the agent's tool has it too", async () => {
  const waiting = fake({ deps: { messages: async () => [] } });
  assert.deepEqual(commands((await shown(waiting.deps)).try!), ["npx @vercel/board inspect --scope acme"]);
  const named = fake({ deps: { messages: async () => [] } });
  named.deps.synced.board = "factory-dev";
  assert.deepEqual(commands((await shown(named.deps)).try!), ["npx @vercel/board inspect --scope acme --name factory-dev"]);
});

/** A factory whose README is still the template's, and nothing in its channels yet. */
const untouched = (more: Partial<Deps> = {}, routes: Routes = {}) => fake({ deps: { messages: async () => [], source: sources(() => CHANNELS, TEMPLATE_README), ...more }, routes });
const SLACK_ROUTES = (channel: { id: string; name: string }): Routes => ({
  "https://slack.com/api/auth.test": () => json({ ok: true, team: "Acme", user: "factory" }),
  "https://slack.com/api/users.conversations": conversations(channel),
});
const START = { label: "Start", path: "/api/launcher/first-task" };

test("try offers the factory's first task while its README is still the template's: a button, and where to ask it anything else", async () => {
  // Slack isn't connected: people ask it things on the board.
  const [first] = todo((await shown(untouched().deps)).try!);
  assert.deepEqual(first, { label: "Give it its first task", done: false, hint: "It makes the README yours. Or ask it anything in project-factory/rsi.", action: START });
  // Slack is, with its app in the channel.
  const slack = await shown(untouched({ connect: async () => "app-token" }, SLACK_ROUTES({ id: "C2", name: "factory-rsi" })).deps);
  assert.equal(todo(slack.try!)[0]!.hint, "It makes the README yours. Or ask it anything in #factory-rsi.");
  // A Slack channel mapped by its ID has no name to say.
  const byId = untouched({ connect: async () => "app-token" }, SLACK_ROUTES({ id: "C0123ABC", name: "factory-rsi" }));
  byId.deps.synced.slackChannels = { C0123ABC: "project-factory/rsi" };
  const mapped = await shown(byId.deps);
  assert.equal(isDone(mapped.slack!), true);
  assert.equal(todo(mapped.try!)[0]!.hint, "It makes the README yours. Or ask it anything in project-factory/rsi.");
});

test("the first task isn't offered before the factory can write to its own repo, or once its README is the team's own", async () => {
  // It's a pull request in the factory's repo: without the connector there's nothing it could open.
  const unconnected = await shown(untouched({ connect: async () => Promise.reject(new Error("connector not found")) }).deps);
  assert.equal(todo(unconnected.try!)[0]!.action, undefined);
  // A README the team already made its own: the step says where to ask, and how to open the board.
  const [own] = todo((await shown(fake({ deps: { messages: async () => [] } }).deps)).try!);
  assert.deepEqual(own, { label: "Give it its first task", done: false, hint: "Ask it anything in project-factory/rsi.", commands: ["npx @vercel/board inspect --scope acme"] });
});

test("a first task started long ago, past what one read brings, isn't offered again", async () => {
  // Its channels are busy with other things: the page asks for the first task's thread by its label.
  const opened = { id: "20", re: null, labels: { "first-task": "readme" }, by: { principal: DEPLOYMENT, profile: null, actor: "a" } } as never;
  const asked: unknown[] = [];
  const busy = await setup(untouched({ messages: async () => [message("90", "ada")], threads: async (query) => (asked.push(query), [opened]) }).deps);
  assert.equal(busy.open ? null : busy.found.first, "started");
  assert.deepEqual(asked, [{ channel: "project-factory/", label: ["first-task"], limit: 1 }]);
  // With no such thread, it's on offer.
  const none = await setup(untouched({ messages: async () => [message("90", "ada")] }).deps);
  assert.equal(none.open ? null : none.found.first, "offer");
});

test("once the first task started, it's the factory's to finish: the thread it opened isn't its reply", async () => {
  const opened = { id: "20", re: null, labels: { "first-task": "readme" }, by: { principal: DEPLOYMENT, profile: null, actor: "a" } } as never;
  const started = await shown(untouched({ messages: async () => [opened] }).deps);
  assert.deepEqual(labels(todo(started.try!)), ["Get a reply from the agent"]);
  // What it says in that thread is.
  const answered = await shown(untouched({ messages: async () => [opened, message("21", "agent", "20")] }).deps);
  assert.equal(isDone(answered.try!), true);
});

test("locally, nothing asks whether the deployment is protected, and signing in is one link and one pull, said once", async () => {
  const { deps, requests } = fake({
    env: { PORT: "3000" },
    deps: {
      oidc: async () => Promise.reject(new Error("no token")),
      credits: async () => Promise.reject(new Error("no token")),
      me: async () => Promise.reject(new Error("no team to find a board for")),
      connect: async () => Promise.reject(new Error("The 'x-vercel-oidc-token' header is missing")),
    },
  });
  const steps = await shown(deps);
  assert.deepEqual(done(steps), { vercel: false, github: false, slack: false, try: false });
  assert.deepEqual(Object.values(steps).flatMap(commands), ["vercel link", "vercel env pull"]);
  assert.ok(!requests.some((url) => url.includes("icon.svg")));
});

test("locally, a board that answers through your own login still leaves signing in to do, said once", async () => {
  // The directory is linked, so the board works as you, but its environment was never pulled.
  const { deps } = fake({
    env: { PORT: "3000" },
    deps: {
      oidc: async () => Promise.reject(new Error("no token")),
      credits: async () => Promise.reject(new Error("no token")),
      connect: async () => Promise.reject(new Error("The 'x-vercel-oidc-token' header is missing")),
    },
  });
  const steps = await shown(deps);
  assert.deepEqual(done(steps), { vercel: false, github: false, slack: false, try: true });
  assert.deepEqual(Object.values(steps).flatMap(commands), ["vercel link", "vercel env pull"]);
  assert.deepEqual(commands(steps.vercel!), ["vercel link", "vercel env pull"]);
});

test("AI Gateway without credits says where to add them", async () => {
  const { vercel } = await shown(fake({ deps: { credits: async () => 0 } }).deps);
  assert.deepEqual(labels(todo(vercel!)), ["Add AI Gateway credits"]);
  assert.deepEqual(links(vercel!), ["https://vercel.com/acme/~/ai"]);
});

test("a team billed for AI Gateway usage, with a negative balance, is ready", async () => {
  const { vercel } = await shown(fake({ deps: { credits: async () => -1194239.37 } }).deps);
  assert.equal(isDone(vercel!), true);
});

// The launcher for whatever doesn't ask for a page: the same steps, as markdown.

const INSPECT = "npx @vercel/board inspect --scope acme";

test("as markdown, the launcher is the page's steps as a checklist, each task with its help under it", async () => {
  // Everything set up but Slack's app in its channel. The links name no line: channels.ts wasn't read.
  const result = await setup(uninvited(() => undefined));
  assert.equal(
    markdown(result, INSPECT),
    `# Your software factory is running

Bring it issues, threads, and questions. 3 of 3 steps done, checked on this request.

## 1. Vercel (done)

- [x] Turn on Deployment Protection
- [x] Open the team's board once
- [x] Add AI Gateway credits

## 2. GitHub (done)

- [x] Create a GitHub connector
- [x] Install its app on your repos
  1 repo with the app isn't on the board yet. [Add it](${CHANNELS_URL})
- [x] Let the app write to \`acme/factory\`

## 3. Slack (optional)

- [x] Create a Slack connector
- [ ] Invite the app to \`#factory-rsi\`
  Where the factory updates itself. [Change the channel](${CHANNELS_URL})

  \`\`\`
  /invite @factory
  \`\`\`

## 4. Try it (done)

- [x] Give it its first task
- [x] Get a reply from the agent

## Watch the board

\`\`\`
${INSPECT}
\`\`\`
`,
  );
});

test("as markdown, a factory that isn't set up says so first, and gives each command its own block", async () => {
  const { deps } = fake({
    env: { PORT: "3000" },
    deps: {
      oidc: async () => Promise.reject(new Error("no token")),
      credits: async () => Promise.reject(new Error("no token")),
      me: async () => Promise.reject(new Error("no team to find a board for")),
      connect: async () => Promise.reject(new Error("The 'x-vercel-oidc-token' header is missing")),
    },
  });
  const text = markdown(await setup(deps), INSPECT);
  assert.ok(text.startsWith("# Set up your software factory\n\nAn agent that takes your team's issues to pull requests. 0 of 3 steps done, checked on this request.\n\n## 1. Vercel\n"));
  assert.ok(
    text.includes(`- [ ] Link this directory, then restart the dev server

  \`\`\`
  vercel link
  \`\`\`

  \`\`\`
  vercel env pull
  \`\`\`

- [ ] Open the team's board once
`),
    text,
  );
  // The board's command isn't in a task here, so it's under the steps.
  assert.ok(text.endsWith(`## Watch the board\n\n\`\`\`\n${INSPECT}\n\`\`\`\n`), text);
});

test("the command that opens the board is on the launcher once, always: in the task that asks for it, or under the steps", async () => {
  const count = (text: string) => text.split(INSPECT).length - 1;
  // Nobody has posted, and there's no first task to offer: the task that says to ask carries it.
  const fresh = markdown(await setup(fake({ deps: { messages: async () => [] } }).deps), INSPECT);
  assert.equal(count(fresh), 1);
  assert.ok(!fresh.includes("## Watch the board"));
  // With the first task on offer, the task carries the button's request, and the command is under the steps.
  const offered = markdown(await setup(untouched().deps), INSPECT);
  assert.ok(offered.includes("- [ ] Give it its first task\n  It makes the README yours. Or ask it anything in project-factory/rsi.\n  Start: POST /api/launcher/first-task\n"), offered);
  assert.equal(count(offered), 1);
  assert.ok(offered.includes("## Watch the board"));
  // Someone has, and the agent hasn't replied yet: no task carries it, so it's under the steps.
  const waiting = markdown(await setup(fake({ deps: { messages: async () => [message("12", "ada")] } }).deps), INSPECT);
  assert.equal(count(waiting), 1);
  assert.ok(waiting.includes("## Watch the board"));
});

test("as markdown, an open deployment says only how to protect it", async () => {
  const { deps } = fake({ routes: { "https://factory.acme.dev/icon.svg": () => new Response("<svg/>", { status: 200 }) } });
  assert.equal(
    markdown(await setup(deps), INSPECT),
    `# Protect this deployment first

The setup shows once only your team can open this page.

- [ ] Turn on Vercel Authentication for all deployments
  [Open Deployment Protection](https://vercel.com/acme/factory/settings/deployment-protection)
`,
  );
});

test("the prompt for an agent names the deployment and the command that reads it: through protection on Vercel, plainly on a dev server", () => {
  const deployed = agentPrompt("https://factory.acme.dev", false);
  assert.ok(deployed.startsWith("Set up https://factory.acme.dev\n"));
  assert.ok(deployed.endsWith("vercel curl https://factory.acme.dev"));
  const local = agentPrompt("http://localhost:3000", true);
  assert.ok(local.endsWith(": curl http://localhost:3000"));
  assert.ok(!local.includes("vercel curl"));
});

test("once it runs, the markdown opens with what the factory has been doing, and how to onboard a repo", async () => {
  const running = {
    overview: {
      week: { threads: 6, messages: 22, answered: 5, firstReplyMs: 14_000, more: false },
      lastReplyAt: "2026-11-12T11:56:00.000Z",
      pulls: { open: 1, merged: 3, closed: 1 },
    },
    repos: [
      { repo: "acme/factory", channel: "project-factory/rsi", slack: "#factory-rsi" },
      { repo: "acme/web", channel: "project-factory/web", slack: null },
    ],
    ask: { channel: "project-factory/rsi", slack: "#factory-rsi", waiting: 3, suggest: ["acme/api", "acme/docs", "acme/ops"], install: "https://github.com/apps/acme-factory/installations/new" },
    join: "",
    first: null,
  };
  const text = markdown(await setup(fake().deps), INSPECT, running, new Date("2026-11-12T12:00:00.000Z"));
  assert.ok(
    text.startsWith(`# Your software factory is running

Bring it issues, threads, and questions. 3 of 3 steps done, checked on this request.

## This week

- 6 threads, 22 messages
- 5 answered, the first reply after 14s (median)
- Last reply 4m ago

## Pull requests

- 1 open, 3 merged, 1 closed, opened by the factory

## Repos

- acme/factory in \`project-factory/rsi\`, #factory-rsi in Slack
- acme/web in \`project-factory/web\`
- 3 more have the GitHub app. Onboard one: POST /api/launcher/onboard with {"repo": "<owner>/<repo>"}, or ask in #factory-rsi: onboard <owner>/<repo>
- With the app, not onboarded: acme/api, acme/docs, acme/ops
- [Add the GitHub app to more repos](https://github.com/apps/acme-factory/installations/new)

## 1. Vercel (done)
`),
    text,
  );
  // A week the read didn't reach the end of says so, and with no Slack channel the ask is on the board.
  const busy = markdown(await setup(fake().deps), INSPECT, { ...running, overview: { ...running.overview, week: { ...running.overview.week, more: true, firstReplyMs: null } }, ask: { channel: "project-factory/rsi", slack: null, waiting: null, suggest: [], install: null } });
  assert.ok(busy.includes("- 6+ threads, 22+ messages\n- 5 answered\n"), busy);
  // And when GitHub didn't say the app's name or its repos, there's nowhere to send anyone to add it, and none to name.
  assert.ok(busy.includes(`- acme/web in \`project-factory/web\`\n- Onboard one: POST /api/launcher/onboard with {"repo": "<owner>/<repo>"}, or ask in project-factory/rsi: onboard <owner>/<repo>\n\n## 1. Vercel`), busy);
  // While its README is still the template's, the first task comes before the week: on offer, then where it is.
  const offer = markdown(await setup(fake().deps), INSPECT, { ...running, first: "offer" });
  assert.ok(offer.includes("checked on this request.\n\n## First task\n\n- Make the README yours: the factory opens a pull request. Start: POST /api/launcher/first-task\n\n## This week\n"), offer);
  const started = markdown(await setup(fake().deps), INSPECT, { ...running, first: "started" });
  assert.ok(started.includes("## First task\n\n- The factory is making the README yours, in #factory-rsi.\n"), started);
  assert.ok(!markdown(await setup(fake().deps), INSPECT, running).includes("First task"));
  // When GitHub didn't count the factory's pull requests, the week is followed by the repos.
  const uncounted = markdown(await setup(fake().deps), INSPECT, { ...running, overview: { ...running.overview, pulls: null } }, new Date("2026-11-12T12:00:00.000Z"));
  assert.ok(uncounted.includes("- Last reply 4m ago\n\n## Repos\n"), uncounted);
});

test("the prompt for an agent to join names the team's board, the factory's channels, and where its ways are written", () => {
  const prompt = joinPrompt({ origin: "https://factory.acme.dev", team: "acme", board: null, home: "project-factory", repo: "acme/factory" });
  assert.ok(prompt.startsWith("Join the software factory at https://factory.acme.dev"));
  assert.ok(prompt.includes("vercel board whoami --scope acme"));
  assert.ok(prompt.includes("vercel board read project-factory/ --scope acme"));
  assert.ok(prompt.includes("https://github.com/acme/factory"));
  // Off a deployment from Git there's no repo to point at, and with no team the CLI's own linked one is used.
  const bare = joinPrompt({ origin: "http://localhost:3000", team: undefined, board: null, home: "project-factory", repo: null });
  assert.ok(!bare.includes("github.com") && !bare.includes("--scope"));
  assert.ok(bare.includes("vercel board read project-factory/\n"));
  // A preview's or a dev server's board isn't the team's default one: the commands name it, or they'd reach production's.
  const named = joinPrompt({ origin: "https://factory-git-fix.acme.dev", team: "acme", board: "factory-dev", home: "project-factory", repo: null });
  assert.ok(named.includes("vercel board whoami --scope acme --name factory-dev"));
  assert.ok(named.includes("vercel board read project-factory/ --scope acme --name factory-dev"));
});

test("the threads the checks find by a label are their roots, however many replies bury them", async () => {
  // A real board kept in memory, with one busy thread: more replies than one read of messages brings.
  // The first task is found this way, by its label, once it's older than what one read brings.
  const { board } = await import("@vercel/board");
  const { local } = await import("@vercel/board/backend-local");
  const team = board({ backend: local({ memory: true }) });
  const busy = await team.post("project-factory/web", { text: "PR #1: Fix the build", labels: { pr: "acme/web#1", state: "open" } });
  const quiet = await team.post("project-factory/rsi", { text: "PR #2: Tidy the README", labels: { pr: "acme/factory#2", state: "merged" } });
  await team.post("project-factory", "not a pull request");
  await team.post("elsewhere", { text: "PR #9: another factory's", labels: { pr: "acme/other#9", state: "open" } });
  for (let i = 0; i < 12; i++) await team.reply(busy.id, `ci run ${i}`);
  const roots = await boardDeps(team).threads({ channel: "project-factory/", label: ["pr"], limit: 10 });
  assert.deepEqual(roots.map((root) => root.id).sort(), [busy.id, quiet.id].sort());
});
