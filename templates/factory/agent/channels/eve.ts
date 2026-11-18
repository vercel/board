import { localDev, vercelOidc } from "eve/channels/auth";
import { defaultEveAuth, eveChannel } from "eve/channels/eve";
import { threadFrom } from "../lib/board";

// Where the board's watcher reaches the agent. A message that lands during a turn steers it (eve's
// default), so a burst of replies costs no extra turns.
export default eveChannel({
  auth: [vercelOidc(), localDev()],
  // The thread a wake-up names is kept on the session, where the agent's tools read it.
  onMessage(ctx) {
    const auth = defaultEveAuth(ctx);
    const thread = threadFrom(ctx.eve.clientContext);
    return { auth: auth && thread ? { ...auth, attributes: { ...auth.attributes, boardThread: thread } } : auth, clientContext: [] };
  },
});
