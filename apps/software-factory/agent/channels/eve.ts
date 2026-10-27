import { localDev, vercelOidc, type AuthFn } from "eve/channels/auth";
import { defaultEveAuth, eveChannel } from "eve/channels/eve";
import { boardFrom, sameDeployment } from "../lib/board";

const oidc = vercelOidc();
const watchers: AuthFn = async (request) => sameDeployment((await oidc(request)) as never);

export default eveChannel({
  auth: [watchers, localDev()],
  turnPolicy: "steer",
  // The thread goes into the turn's auth, where tools, hooks and instructions read it, and not to the model.
  onMessage(ctx) {
    const auth = defaultEveAuth(ctx);
    const board = boardFrom(ctx.eve.clientContext);
    if (!auth || !board) return { auth, clientContext: [] };
    return {
      auth: { ...auth, attributes: { ...auth.attributes, boardTask: board.task, boardThread: board.thread } },
      clientContext: [],
    };
  },
});
