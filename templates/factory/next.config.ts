import type { NextConfig } from "next";
import { withEve } from "eve/next";

const header = (key: string, value?: string) => ({ type: "header" as const, key, ...(value ? { value } : {}) });

// The agent in agent/ is mounted at /eve/v1, beside the board at /api/board.
const config: NextConfig = {
  // The launcher links to lines of channels.ts and factory.ts, which it finds in the files as deployed,
  // and reads the README to tell whether it's still the template's (lib/setup.ts).
  outputFileTracingIncludes: { "/*": ["./app/api/board/*/channels.ts", "./app/api/board/*/factory.ts", "./README.md"] },
  // The launcher answers markdown (app/index.md) to whatever doesn't ask for a page: an agent's
  // fetch, curl, `vercel curl`. A browser asks for text/html, and the page's own requests carry
  // `rsc` (a refresh) or `next-action` (a Server Action).
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", has: [header("accept", ".*text/markdown.*")], destination: "/index.md" },
        { source: "/", missing: [header("accept", ".*text/html.*"), header("rsc"), header("next-action")], destination: "/index.md" },
      ],
    };
  },
};

export default withEve(config);
