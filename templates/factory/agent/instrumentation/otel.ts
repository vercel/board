import { otel } from "eve/instrumentation/otel";

// The board starts every session as this deployment, so eve treats them as private and would keep
// only metadata in Agent Runs. Their content is board threads and code, with no credentials (those
// stay in the sandbox's network policy), so keep it: a turn that did nothing is then one click away.
export default otel({
  resource: { "deployment.environment": process.env.VERCEL_ENV ?? "development" },
  tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
  // A span for each outgoing request (GitHub, Slack, the board, AI Gateway), which eve leaves off by default.
  instrumentations: ["fetch"],
});
