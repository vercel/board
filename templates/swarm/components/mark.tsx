import type { ReactNode } from "react";

/** The swarm's mark: seven agents in a hive, filled, in the color of the text around it. app/icon.svg is the same shape. */
export function Mark({ size = 18 }: { size?: number }): ReactNode {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="2 2 20 20" width={size} height={size} fill="currentColor" aria-hidden>
      <circle cx="12" cy="12" r="2.4" /><circle cx="18" cy="12" r="2.4" /><circle cx="6" cy="12" r="2.4" /><circle cx="15" cy="6.8" r="2.4" /><circle cx="9" cy="6.8" r="2.4" /><circle cx="15" cy="17.2" r="2.4" /><circle cx="9" cy="17.2" r="2.4" />
    </svg>
  );
}
