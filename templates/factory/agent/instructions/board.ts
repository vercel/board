import { defineDynamic } from "eve";
import { defineInstructions } from "eve/instructions";
import { threadOf } from "../lib/board";
import { NAME, ownToken } from "../lib/identity";
import { INSTRUCTIONS, secrets } from "../lib/instructions";
import { envVarsPage, projectOf } from "../../lib/project";

// The instructions, with the thread the session is for, and where this project keeps its secrets:
// the page is named from the deployment's own token, a dev server's from the one it pulled.
export default defineDynamic(async (ctx) => {
  const thread = threadOf(ctx.session);
  if (!thread) return null;
  const token = (await ownToken().catch(() => null)) ?? process.env.VERCEL_OIDC_TOKEN ?? "";
  return defineInstructions({
    content: `${INSTRUCTIONS}\n\n${secrets(envVarsPage(projectOf(token)))}\nOn the board you're ${NAME}, working on thread #${thread} only. Other threads have sessions of their own.`,
  });
});
