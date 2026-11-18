import { compileAccess } from "@vercel/board/access";
import { projectOf, type Project } from "./project.ts";

// The launcher's steps: each is a short list of tasks, checked from this deployment as it is now.
// Nothing here writes anything.

/** Where a task sends you: a page of the dashboard, or one on GitHub. */
export type Link = { href: string; label: string };

/** What helps do a task: one short line, a link that reads on after it, and the commands to run. */
export type Help = { hint?: string; link?: Link; commands?: string[] };

/**
 * One task of a step, named for what to do ("Create a GitHub connector") whether it's done or not.
 * A name in its label (a channel, a repo, a connector) goes in backticks, and stands out on the page.
 */
export type Task = { label: string; done: boolean } & Help;

export type StepId = "vercel" | "github";

/** A step is done once each of its tasks is. */
export type Step = { id: StepId; title: string; tasks: Task[] };

export const isDone = (step: Step) => step.tasks.every((task) => task.done);

/** This deployment on its board: who it writes as, and what it may do there, by channel pattern. */
export type Me = { principal: string; can: Record<string, readonly string[]> };

/** What the checks came across on the way, for the launch form: the repos the GitHub app is on, and where to add more. */
export type Found = { me: Me | null; repos: string[]; install: string | null };

/** What the launcher shows: its steps, or while strangers can open this deployment, only how to protect it. */
export type Setup = { open: false; steps: Step[]; found: Found } | { open: true; task: Task };

/** Where setup stands: how many steps are done, and whether that's all of them. */
export function progress(steps: Step[]): { done: number; of: number; ready: boolean } {
  const done = steps.filter(isDone).length;
  return { done, of: steps.length, ready: done === steps.length };
}

/** What a swarm is, in a line: under the page's title while it's being set up, and what a browser shows for the page. */
export const ABOUT = "Many agents on one queue: point them at a repo with a goal, and watch them plan, build, and review.";

/** What the launcher says first. */
export function headline(setup: Setup): { title: string; lede: string } {
  if (setup.open) return { title: "Protect this deployment first", lede: "The swarm shows once only your team can open this page." };
  return progress(setup.steps).ready
    ? { title: "Launch a swarm", lede: "Pick a repo and a goal. Agents take the tasks one each, in sandboxes of their own, and report on the board." }
    : { title: "Set up your swarm", lede: ABOUT };
}

type Env = Record<string, string | undefined>;

/** What the checks reach: the environment, the network, and the board. Tests pass their own. */
export type Deps = {
  env: Env;
  /** The host the checks were asked on: what strangers could reach. Production's when unknown. */
  host?: string | null;
  /** The subtree the swarm works in, with its trailing slash. */
  swarm: string;
  /** The GitHub connector's name: `github/<project>`. */
  connector: string;
  fetch: typeof fetch;
  /** This deployment's OIDC token. */
  oidc(): Promise<string>;
  /** The connector's app token. */
  connect(connector: string): Promise<string>;
  /** AI Gateway's balance, in dollars. */
  credits(): Promise<number>;
  /** Who this deployment is on its board, and what it may do there. Rejects with the board's own error when it can't use it. */
  me(): Promise<Me>;
};

const TITLES: Record<StepId, string> = { vercel: "Vercel", github: "GitHub" };

const step = (id: StepId, tasks: Task[]): Step => ({ id, title: TITLES[id], tasks });
const done = (label: string, help: Help = {}): Task => ({ label, done: true, ...help });
const todo = (label: string, help: Help = {}): Task => ({ label, done: false, ...help });
const named = (...names: string[]) => names.map((name) => `\`${name}\``).join(", ");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);

/** Your machine: `vercel env pull` writes VERCEL_ENV=development, so that counts too. */
export const isLocal = (env: Env) => !env.VERCEL_ENV || env.VERCEL_ENV === "development";

/** Where the project's settings are, from its OIDC token's claims. */
function dashboard(project: Project) {
  const base = project ? `https://vercel.com/${project.team}/${project.name}` : "https://vercel.com/dashboard";
  return { base, settings: (path: string) => (project ? `${base}/settings/${path}` : base), team: project ? `https://vercel.com/${project.team}` : base };
}

/**
 * Whether `host` turns strangers away, or why that couldn't be told: asked from outside, without
 * credentials. It asks for a static file, so an open deployment answers without rendering a page
 * that asks again.
 */
export async function closed(host: string | undefined, request: typeof fetch): Promise<boolean | Error> {
  if (!host) return new Error("no host to check");
  const status = await request(`https://${host}/icon.svg`, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(10_000) }).then(
    (response) => response.status,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  if (status instanceof Error) return status;
  return status === 401 || status === 403 || (status >= 300 && status < 400);
}

/** The command that opens the board in a browser, as whoever runs it, on `team` when it's known. */
export const inspectCommand = (team: string | undefined) => `npx @vercel/board inspect${team ? ` --scope ${team}` : ""}`;

/** What the agents and the app do under the swarm's channels. */
const NEEDS = ["read", "post", "label"] as const;

/** Whether `me` may do what the swarm needs under `swarm`: it reads, posts, and labels (claims are labels) in a run's channel. */
export function canRun(me: Me, swarm: string): boolean {
  try {
    const access = compileAccess(me.can as Record<string, readonly (typeof NEEDS)[number][]>);
    return NEEDS.every((permission) => access.can(permission, `${swarm}runs`) && access.can(permission, `${swarm}r0`));
  } catch {
    return false;
  }
}

/** The steps, in order. While strangers can open this deployment, or that can't be told, only how to protect it. */
export async function setup(deps: Deps): Promise<Setup> {
  const local = isLocal(deps.env);
  const token = await deps.oidc().catch(() => null);
  const project = token ? projectOf(token) : null;
  if (!local) {
    const shut = await closed(deps.host ?? deps.env.VERCEL_PROJECT_PRODUCTION_URL, deps.fetch);
    if (shut instanceof Error) return { open: true, task: todo("Couldn't check that this deployment is protected", { hint: message(shut) }) };
    if (!shut) return { open: true, task: todo("Turn on Vercel Authentication for all deployments", { link: { href: dashboard(project).settings("deployment-protection"), label: "Open Deployment Protection" } }) };
  }
  const found: Found = { me: null, repos: [], install: null };
  const [vercel, github] = await Promise.all([vercelStep(deps, local, project, found), githubStep(deps, project, found)]);
  return { open: false, steps: [vercel, github], found };
}

/** Protected, on the team's board with room to work, with AI Gateway, and with the cron's secret. */
async function vercelStep(deps: Deps, local: boolean, project: Project, found: Found): Promise<Step> {
  const links = dashboard(project);
  const signedOut = local && !deps.env.VERCEL_OIDC_TOKEN;
  const tasks: Task[] = [];
  if (!local) {
    tasks.push(done("Turn on Deployment Protection"));
    if (!project) return step("vercel", [...tasks, todo("Turn on OIDC Federation, then redeploy", { link: { href: links.settings("security"), label: "Open Security settings" } })]);
  }
  if (signedOut) tasks.push(todo("Link this directory, then restart the dev server", { commands: ["vercel link", "vercel env pull"] }));

  // The board is the team's, in Vercel's API. A team has one once someone on it has opened it.
  const OPEN_BOARD = "Open the team's board once";
  const access = await deps.me().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (access instanceof Error) {
    const refused = ["board_not_granted", "no_board"].includes((access as { code?: string }).code ?? "");
    if (signedOut) tasks.push(todo(OPEN_BOARD));
    else if (refused) tasks.push(todo(OPEN_BOARD, { commands: [inspectCommand(project?.team)] }));
    else tasks.push(todo("Couldn't reach the team's board", { hint: message(access) }));
  } else {
    found.me = access;
    tasks.push(done(OPEN_BOARD));
    const WRITE = `Let this project post and label under ${named(deps.swarm)}`;
    if (canRun(access, deps.swarm)) tasks.push(done(WRITE));
    else tasks.push(todo(WRITE, { hint: "Its grants were narrowed. Whoever manages the board can widen them:", commands: [`vb grants create --project ${project?.name ?? "<project>"} --can '${deps.swarm}=read,post,react,label'`] }));
  }

  const balance = await deps.credits().catch((error: unknown) => error);
  // A prepaid team's balance runs down to zero; a team billed for usage shows it as negative.
  const CREDITS = "Add AI Gateway credits";
  if (typeof balance === "number" && balance !== 0) tasks.push(done(CREDITS));
  else if (balance === 0) tasks.push(todo(CREDITS, { link: { href: `${links.team}/~/ai`, label: "Open AI Gateway" } }));
  else if (signedOut) tasks.push(todo(CREDITS));
  else tasks.push(todo("Couldn't reach AI Gateway", { hint: message(balance) }));

  // Vercel's cron keeps runs going while nobody has the page open, and sends this secret so nothing else can.
  if (!local) {
    const CRON = "Add a `CRON_SECRET` environment variable, then redeploy";
    tasks.push(deps.env.CRON_SECRET ? done(CRON) : todo(CRON, { hint: "Any long random string. Vercel's cron sends it to keep runs going while nobody has this page open.", link: { href: links.settings("environment-variables"), label: "Open Environment Variables" } }));
  }
  return step("vercel", tasks);
}

type Installed = { total_count: number; repositories: { full_name: string }[] };

/** How many pages of the app's repos one check reads, 100 to a page. */
const REPO_PAGES = 5;

/** The repos the connector's app is on: the first page says how many, and the rest are read together. */
async function installed(api: (path: string) => Promise<Response>): Promise<string[]> {
  const page = async (number: number) => {
    const response = await api(`/installation/repositories?per_page=100&page=${number}`);
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return (await response.json()) as Installed;
  };
  const first = await page(1);
  const pages = Math.min(Math.ceil(first.total_count / 100), REPO_PAGES);
  const rest = await Promise.allSettled(Array.from({ length: Math.max(pages - 1, 0) }, (_, i) => page(i + 2)));
  const names = first.repositories.map((repo) => repo.full_name);
  for (const read of rest) if (read.status === "fulfilled") names.push(...read.value.repositories.map((repo) => repo.full_name));
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** The commands that create the connector and give this project its tokens, from any directory. */
const createConnector = (connector: string, project: Project) => {
  const scope = project ? ` --scope ${project.team}` : "";
  return [`vercel connect create github --name ${connector.split("/")[1] ?? "swarm"} --yes${scope}`, `vercel connect attach ${connector} --project ${project?.name ?? "<project>"} --yes${scope}`];
};

/** The connector, and the repos its app is on: what the launch form offers. */
async function githubStep(deps: Deps, project: Project, found: Found): Promise<Step> {
  const CONNECT = `Create the ${named(deps.connector)} connector`;
  const INSTALL = "Install its app on the repos the swarm may work on";
  const token = await deps.connect(deps.connector).catch((error: unknown) => error);
  if (typeof token !== "string") {
    if (isLocal(deps.env) && !deps.env.VERCEL_OIDC_TOKEN) return step("github", [todo(CONNECT), todo(INSTALL)]);
    if (token instanceof Error && token.name === "ConnectorInstallationRequiredError") return step("github", [done(CONNECT), todo(INSTALL)]);
    if ((token as { code?: string } | null)?.code === "forbidden")
      return step("github", [todo(`Attach ${named(deps.connector)} to this project`, { hint: "It's on this team for another project.", commands: [`vercel connect attach ${deps.connector}${project ? ` --project ${project.name} --scope ${project.team}` : ""}`] }), todo(INSTALL)]);
    return step("github", [todo(CONNECT, { commands: createConnector(deps.connector, project) }), todo(INSTALL)]);
  }
  const api = (path: string, init: RequestInit = {}) =>
    deps.fetch(`https://api.github.com${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", ...init.headers }, signal: AbortSignal.timeout(10_000) });
  const [repos, viewer] = await Promise.all([
    installed(api).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))),
    api("/graphql", { method: "POST", body: JSON.stringify({ query: "query { viewer { login } }" }) })
      .then(async (response) => ((await response.json()) as { data?: { viewer?: { login?: string } } }).data?.viewer?.login ?? null)
      .catch(() => null),
  ]);
  const app = viewer?.replace(/\[bot\]$/, "") ?? null;
  found.install = app ? `https://github.com/apps/${app}/installations/new` : null;
  const configure = found.install ? { link: { href: found.install, label: "Configure the app" } } : {};
  if (repos instanceof Error) return step("github", [done(CONNECT), todo("Couldn't list the app's repos", { hint: message(repos) })]);
  found.repos = repos;
  if (repos.length === 0) return step("github", [done(CONNECT), todo(INSTALL, configure)]);
  const on = `On ${repos.length} ${repos.length === 1 ? "repo" : "repos"}.`;
  return step("github", [done(CONNECT), done(INSTALL, { hint: on, ...(found.install ? { link: { href: found.install, label: "Add more" } } : {}) })]);
}

/** The checks' real dependencies, loaded only when the launcher runs. */
export async function liveDeps(me: Deps["me"], base: Pick<Deps, "swarm" | "connector" | "host">): Promise<Deps> {
  const [{ getVercelOidcToken }, { getToken }] = await Promise.all([import("@vercel/oidc"), import("@vercel/connect")]);
  const oidc = () => getVercelOidcToken();
  return {
    ...base,
    env: process.env,
    fetch,
    oidc,
    connect: (connector) => getToken(connector, { subject: { type: "app" } }),
    credits: async () => {
      const response = await fetch("https://ai-gateway.vercel.sh/v1/credits", { headers: { authorization: `Bearer ${await oidc()}` }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`AI Gateway answered ${response.status}`);
      return Number(((await response.json()) as { balance?: string }).balance);
    },
    me,
  };
}
