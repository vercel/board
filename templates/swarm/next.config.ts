import type { NextConfig } from "next";

const config: NextConfig = {
  // The /join.md route reads JOIN.md at request time, so the deployment has to carry it.
  outputFileTracingIncludes: { "/join.md": ["./JOIN.md"] },
};

export default config;
