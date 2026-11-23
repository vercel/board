import type { Board } from "@vercel/board";
import { vb } from "@vercel/board/cli";
import { z } from "zod";
import { channel } from "../../lib/project.ts";

// The vb tool: vb's board commands, run in the function on the factory's own board handle, as this
// deployment itself, without starting `vb` in the sandbox, so typing and reads reach Slack through
// the board's sync. Files (--attach, download) are the sandbox's.

export const inputSchema = z.object({
  args: z
    .array(z.string())
    .describe(
      'vb\'s arguments, one per item, as you\'d type them after vb: ["read", "42"], ["reply", "42", "on it", "--attach", "~/shot.png"], ["label", "42", "kind=bug"], ["channels", "project-factory"].',
    ),
});

/** What the agent may do on the board, and where: read, post, react and label in this factory's channels. */
export const AGENT_CAN = { [`${channel()}/`]: ["read", "post", "react", "label"] } as const;

/**
 * The agent on `board`: this deployment itself, held to its own channels. The deployment may do
 * more (it runs the board's sync, and reads every channel its team lets it), and the board holds
 * this handle to `AGENT_CAN` on every call: the rest of the board, sync's raw events, its sources
 * and its grants are refused there, not here. `null` says no profile, whatever `BOARD_PROFILE`
 * names in the environment: under a profile its own replies would read as someone else's, and wake it.
 */
export const agentBoard = (board: Board): Board => board.as(null, { can: AGENT_CAN });

/** The sandbox's home, where clones and skills live. */
export const SANDBOX_HOME = "/home/vercel-sandbox";

/** A path as the model writes it: `~/…` and `$HOME/…` are in the sandbox's home, as its file tools read them. */
export const sandboxPath = (path: string, home = SANDBOX_HOME) => path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);

/** The sandbox's files, for --attach and download. */
export type SandboxFiles = {
  readBinaryFile(options: { path: string }): PromiseLike<Uint8Array | null>;
  writeBinaryFile(options: { path: string; content: Uint8Array }): PromiseLike<void>;
};

/**
 * Runs a vb command as the agent, and says what it printed, as bash would: stdout, then stderr, then
 * a failure's exit code. Nothing is refused here: the board refuses what the handle may not do, and
 * vb() itself answers `tail` and `wait`, which stream, with a usage error when it's given no signal.
 */
export async function runVb(board: Board, args: string[], files: () => Promise<SandboxFiles>): Promise<string> {
  const { code, stdout, stderr } = await vb(board, args, {
    readFile: async (path) => (await files()).readBinaryFile({ path: sandboxPath(path) }),
    writeFile: async (path, content, options?: { exclusive?: boolean }) => {
      const sandbox = await files();
      const at = sandboxPath(path);
      // vb asks for this when the name came from the attachment: never replace a file the sandbox has.
      if (options?.exclusive && (await sandbox.readBinaryFile({ path: at })) !== null) {
        throw Object.assign(new Error(`${path} already exists`), { code: "EEXIST" });
      }
      await sandbox.writeBinaryFile({ path: at, content });
    },
  });
  return [stdout.trimEnd(), stderr.trimEnd(), code === 0 ? "" : `(exit ${code})`].filter(Boolean).join("\n") || "(no output)";
}
