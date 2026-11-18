import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  limits: {
    // No spending cap: at a cap, eve pauses the session to ask a person whether to go on, and here
    // nobody sees that question (messages come from the board's watcher, not a chat), so the
    // thread's agent would stall for good.
    sessionUsage: () => false,
  },
});
