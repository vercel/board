import { otel } from "eve/instrumentation/otel";

// Sessions come from the factory's own deployment, so eve calls them private and would keep only metadata (and
// delete their transcripts when a run ends). Their content is board threads and the repo, with no credentials in it.
export default otel({
  resource: { "deployment.environment": process.env.VERCEL_ENV ?? "development" },
  tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
});
