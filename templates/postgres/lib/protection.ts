/** Your machine: `vercel env pull` writes VERCEL_ENV=development, so that counts too. */
const isLocal = () => !process.env.VERCEL_ENV || process.env.VERCEL_ENV === "development";

/**
 * Whether `host` turns strangers away: a request with no credentials for one of its static files
 * is refused or sent to log in. An error when it can't tell.
 */
async function closed(host: string): Promise<boolean | Error> {
  const status = await fetch(`https://${host}/icon.svg`, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(10_000) }).then(
    (response) => response.status,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  if (status instanceof Error) return status;
  return status === 401 || status === 403 || (status >= 300 && status < 400);
}

const checked = new Map<string, { at: number; closed: Promise<boolean | Error> }>();
const MINUTE = 60_000;

/** Whether this deployment turns strangers away, asked at most once a minute per host: a check that couldn't tell isn't kept. */
export function isClosed(host: string | null): Promise<boolean | Error> {
  if (isLocal()) return Promise.resolve(true);
  if (!host) return Promise.resolve(new Error("no host to check"));
  const known = checked.get(host);
  if (known && Date.now() - known.at < MINUTE) return known.closed;
  const answer = closed(host);
  checked.set(host, { at: Date.now(), closed: answer });
  void answer.then((result) => result instanceof Error && checked.delete(host));
  return answer;
}
