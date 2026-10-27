import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import { BOARD, TOOLS } from "../app/api/board/[[...path]]/harness.ts";
import xinput from "./lib/xinput.py?raw";
import { XINPUT } from "./lib/computer";

// Tools are installed once, at build, into the snapshot.
export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    // A file, not `bash -c "…"`: inside double quotes the script's newlines stay `\n` and its `$(…)` run too early.
    await sandbox.writeTextFile({ path: "/tmp/factory-tools.sh", content: TOOLS });
    const tools = await sandbox.run({ command: "sudo bash /tmp/factory-tools.sh" });
    if (tools.exitCode !== 0) throw new Error(`sandbox setup failed: ${tools.stderr.slice(-500)}`);
    await sandbox.run({ command: `mkdir -p "$(dirname ${XINPUT})"` });
    await sandbox.writeTextFile({ path: XINPUT, content: xinput });
    const scripts = await sandbox.run({ command: `chmod +x ${XINPUT} && { chmod +x "$HOME"/.agents/skills/*/scripts/* 2>/dev/null || true; }` });
    if (scripts.exitCode !== 0) throw new Error(`sandbox setup failed: ${scripts.stderr.slice(-500)}`);
  },
});

// Credentials are placeholders; hooks/credentials.ts puts the real ones in the network policy.
export default defineSandbox(() =>
  environment.open({
    resources: { vcpus: 6 },
    timeout: 45 * 60_000,
    networkPolicy: "deny-all",
    env: {
      AI_GATEWAY_API_KEY: "from-the-network-policy",
      BOARD_URL: BOARD,
      BOARD_TOKEN: "from-the-network-policy",
      GH_TOKEN: "from-the-network-policy",
    },
  }),
);
