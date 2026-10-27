import { defineAgent } from "eve";
import { MODEL } from "../app/api/board/[[...path]]/harness.ts";

export default defineAgent({
  model: MODEL,
  limits: {
    // Nobody could answer its "continue?" prompt.
    sessionUsage: () => false,
  },
});
