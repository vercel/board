import type { NextConfig } from "next";

const config: NextConfig = {
  // Read from disk at request time, so the deployment has to carry them: JOIN.md by /join.md, and the
  // runner when a run's first sandbox is built (by the page's actions and the cron).
  outputFileTracingIncludes: { "/join.md": ["./JOIN.md"], "/*": ["./sandbox/*.ts"], "/api/tick": ["./sandbox/*.ts"] },
};

export default config;
