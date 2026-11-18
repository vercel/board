/** A GitHub token is asked for again this long before it dies, so a long turn renews it as it goes. */
export const REFRESH_LEAD_MS = 15 * 60_000;

/** Whether tokens that die at `until` are near their end. */
export const stale = (until: number, now: number) => until - REFRESH_LEAD_MS <= now;
