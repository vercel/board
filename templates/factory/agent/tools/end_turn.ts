import { defineTool } from "eve/tools";
import { noReply } from "eve/tools/no_reply";
import { z } from "zod";

// eve's no_reply under a name that fits: replies go out through the vb tool and the final text reaches
// nobody, so ending the turn skips only the closing summary, not the reply. Named after this file.
export default defineTool({
  ...noReply,
  description: `End your turn now, without writing a final message. Your final message reaches nobody: people in the thread see only what you post with the vb tool (vb reply, vb react, vb label). So reply with vb first, then call this as your last step instead of writing a closing summary: right after the vb reply that finishes the work, or when a new message isn't for you and you're staying quiet. Call it alone, not alongside other tools in the same step.`,
  inputSchema: z.object({}),
  execute: () => "Turn ended.",
});
