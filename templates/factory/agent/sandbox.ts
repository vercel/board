import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { installAgentBrowser } from "@agent-browser/eve/sandbox";
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import { placeholders } from "./lib/services";

/** Pinned: asking GitHub's API for the latest hits the unauthenticated rate limit sandboxes share. */
const GH = "2.102.0";
/** ffmpeg, for recording demos (the ui-demo skill): a static build, since the sandbox's packages have none. */
const FFMPEG_STATIC = "5.2.0";

/** Sandbox setup, as root, once at build into the snapshot. */
const TOOLS = `set -e
command -v pnpm >/dev/null || npm install -g pnpm >/dev/null 2>&1
command -v gh >/dev/null || {
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH}/gh_${GH}_linux_amd64.tar.gz" | tar xz -C /tmp
  install "/tmp/gh_${GH}_linux_amd64/bin/gh" /usr/local/bin/gh
}
# Demos are optional: without ffmpeg, the agent still has the browser, just no video.
command -v ffmpeg >/dev/null || { npm install -g ffmpeg-static@${FFMPEG_STATIC} >/dev/null 2>&1 \\
  && ln -sf "$(npm root -g)/ffmpeg-static/ffmpeg" /usr/local/bin/ffmpeg; } || true`;

/** The sandbox's git (agent/lib/git), ahead of /usr/bin/git: a push to GitHub goes through its API, so GitHub signs it. */
const GIT = `set -e
test -x /usr/bin/git
sudo install -D -m 755 /tmp/factory-git-dispatch /usr/local/lib/factory/git
sudo install -D -m 644 /tmp/factory-git-push.mjs /usr/local/lib/factory/git-push.mjs
sudo ln -sf /usr/local/lib/factory/git /usr/local/bin/git
[ "$(command -v git)" = /usr/local/bin/git ]`;

/** A file of agent/lib/git, read from the checkout: prepare runs at build, in the project. */
const gitFile = (name: string) => readFile(join(process.cwd(), "agent/lib/git", name), "utf8");

export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    // A file, not `bash -c "…"`: inside double quotes the script's newlines stay `\n` and its `$(…)` run too early.
    await sandbox.writeTextFile({ path: "/tmp/factory-tools.sh", content: TOOLS });
    const tools = await sandbox.run({ command: "sudo bash /tmp/factory-tools.sh" });
    if (tools.exitCode !== 0) throw new Error(`sandbox setup failed: ${tools.stderr.slice(-500)}`);
    const scripts = await sandbox.run({ command: `{ chmod +x "$HOME"/.agents/skills/*/scripts/* 2>/dev/null || true; }` });
    if (scripts.exitCode !== 0) throw new Error(`sandbox setup failed: ${scripts.stderr.slice(-500)}`);
    await sandbox.writeTextFile({ path: "/tmp/factory-git-dispatch", content: await gitFile("git") });
    await sandbox.writeTextFile({ path: "/tmp/factory-git-push.mjs", content: await gitFile("git-push.mjs") });
    await sandbox.writeTextFile({ path: "/tmp/factory-git.sh", content: GIT });
    const git = await sandbox.run({ command: "bash /tmp/factory-git.sh" });
    if (git.exitCode !== 0) throw new Error(`sandbox git setup failed: ${git.stderr.slice(-500)}`);
    // The browser (agent/extensions/browser.ts) and Chromium. Optional too: the extension installs on first use otherwise.
    await installAgentBrowser(sandbox).catch((error: unknown) => console.warn("[factory] agent-browser didn't install; it will on first use:", error));
  },
});

// Credentials are placeholders: lib/credentials.ts puts the real ones in the network policy, never in the sandbox.
export default defineSandbox(() =>
  environment.open({
    resources: { vcpus: 4 },
    timeout: 45 * 60_000,
    networkPolicy: "deny-all",
    env: {
      GH_TOKEN: "from-the-network-policy",
      // Each service's key the project has (agent/lib/services.ts): a placeholder too, in every
      // thread. Whether the real key is added is the thread's channel's to say.
      ...placeholders(),
    },
  }),
);
