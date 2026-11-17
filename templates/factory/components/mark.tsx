import type { ReactNode } from "react";

/** The factory's mark: a sawtooth roofline, filled, in the color of the text around it. app/icon.svg is the same shape. */
export function Mark({ size = 18 }: { size?: number }): ReactNode {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="2 3.5 20 20" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M3 20v-9l6-4v4l6-4v4l6-4v13z" />
    </svg>
  );
}
