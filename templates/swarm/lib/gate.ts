// The page starts sandboxes and spends money as this deployment, whoever is looking at it. So it
// does that only where strangers can't reach it: on your machine, or on a deployment behind
// Deployment Protection.

/** Your machine: `vercel env pull` writes VERCEL_ENV=development, so that counts too. */
export const isLocal = (env: NodeJS.ProcessEnv = process.env) => !env.VERCEL_ENV || env.VERCEL_ENV === "development";

/**
 * Whether a request with no credentials is turned away at `host`: what Vercel Authentication does
 * to everyone outside the team. It asks for a static file, never a page: a page runs this check,
 * and one that asked for itself would ask again without end on a deployment anyone can open.
 */
export async function closed(host: string, request: typeof fetch = fetch): Promise<boolean> {
  const status = await request(`https://${host}/icon.svg`, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(10_000) }).then(
    (response) => response.status,
    () => 0,
  );
  return status === 401 || status === 403 || (status >= 300 && status < 400);
}

const checked = new Map<string, { at: number; open: boolean }>();

/**
 * Whether anyone can reach this deployment at `host`, the domain a request came in on. Checked
 * again every 10 seconds, and a check that fails counts as open. Locally, the dev server is yours.
 */
export async function open(host: string | null): Promise<boolean> {
  if (isLocal()) return false;
  if (!host) return true;
  const known = checked.get(host);
  if (known && Date.now() - known.at < 10_000) return known.open;
  const result = { at: Date.now(), open: !(await closed(host)) };
  checked.set(host, result);
  return result.open;
}

/** What the page says instead of its controls when anyone can reach it. */
export const OPEN = "Anyone can open this deployment, so it shows nothing and starts nothing. Turn on Vercel Authentication for all deployments in the project's Deployment Protection settings.";
