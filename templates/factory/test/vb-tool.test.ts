import assert from "node:assert/strict";
import { test } from "node:test";
import { board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { agentBoard, runVb } from "../agent/lib/vb-tool.ts";

// The agent's vb tool, run as the tool runs it, on a real board kept in memory: what the agent gets
// back is what vb prints, and what lands on the board is what people see.

const noFiles = async () => ({ readBinaryFile: async () => null, writeBinaryFile: async () => {} });

async function factory() {
  const team = board({ backend: local({ memory: true }) });
  const root = await team.post("project-factory/rsi", "the build is red");
  return { team, root, agent: agentBoard(team) };
}

test("a reply through the tool lands on the board as the factory itself, under no profile, whatever the handle it's given names", async () => {
  // On Vercel a handle that says nothing writes under the project's BOARD_PROFILE, when it has one.
  // Here that's a handle that names a profile: the tool's handle must still write under none.
  const { team, root } = await factory();
  const named = team.as("someone-else");
  const printed = await runVb(agentBoard(named), ["reply", String(root.id), "looking into it"], noFiles);
  assert.doesNotMatch(printed, /\(exit/);
  await named.reply(root.id, "as the handle says");
  const { messages } = await team.channel("project-factory/rsi").messages();
  const by = (text: string) => messages.find((message) => message.text === text)?.by;
  // The board itself wrote it: the actor is the board's own, with no profile on it.
  assert.equal(by("looking into it")?.actor, (await team.me()).actor);
  assert.equal(by("looking into it")?.profile, null);
  // The handle the tool was given, to show the profile was there to be taken.
  assert.equal(by("as the handle says")?.actor, `${(await team.me()).actor}:someone-else`);
});

test("the board keeps the agent to its own channels: it reads and writes there, and nowhere else", async () => {
  const { team, root, agent } = await factory();
  const elsewhere = await team.post("elsewhere", "another team's thread");
  // In its channels, what a thread needs.
  for (const args of [["read", "project-factory/rsi"], ["reply", root.id, "on it"], ["label", root.id, "kind=bug"], ["react", root.id, "eyes"], ["schedule", root.id, "check", "--in", "5m"], ["typing", root.id, "reading"]]) {
    assert.doesNotMatch(await runVb(agent, args, noFiles), /\(exit/, args.join(" "));
  }
  // Outside them, nothing: not a read, not a post, not a reply. The board's own handle does each, so it's the handle that's held.
  for (const args of [["read", "elsewhere"], ["post", "elsewhere", "hi"], ["reply", elsewhere.id, "hi"]]) {
    assert.match(await runVb(agent, args, noFiles), /\(exit 1\)/, args.join(" "));
    assert.doesNotMatch(await runVb(team, args, noFiles), /\(exit/, args.join(" "));
  }
  assert.equal((await team.channel("elsewhere").messages()).messages.filter((message) => message.text === "hi").length, 2);
});

test("the board refuses the agent what's the deployment's alone: the platforms' raw events, and who's let onto the board", async () => {
  const { team, agent } = await factory();
  for (const args of [["inbox", "slack"], ["grants"]]) {
    assert.match(await runVb(agent, args, noFiles), /\(exit 1\)/, args.join(" "));
    assert.doesNotMatch(await runVb(team, args, noFiles), /\(exit/, args.join(" "));
  }
});

test("a command that runs until it's stopped answers at once, with nothing held", async () => {
  const { agent, root } = await factory();
  for (const command of ["tail", "wait"]) assert.match(await runVb(agent, [command, "project-factory/"], noFiles), /\(exit 2\)/, command);
  // The next call isn't waiting behind one.
  assert.doesNotMatch(await runVb(agent, ["read", root.id], noFiles), /\(exit/);
});

test("download by the attachment's name keeps a file the sandbox has; given a path, it replaces it", async () => {
  const { agent, root } = await factory();
  const sandbox = new Map<string, Uint8Array>([["/home/vercel-sandbox/shot.png", new Uint8Array([1, 2, 3])]]);
  const files = async () => ({
    readBinaryFile: async ({ path }: { path: string }) => sandbox.get(path) ?? null,
    writeBinaryFile: async ({ path, content }: { path: string; content: Uint8Array }) => void sandbox.set(path, content),
  });
  const { message } = JSON.parse(await runVb(agent, ["reply", root.id, "proof", "--attach", "~/shot.png", "--json"], files));
  const attachment = message.attachments[0].id;

  sandbox.set("shot.png", new Uint8Array([7]));
  assert.match(await runVb(agent, ["download", attachment], files), /already here[\s\S]*\(exit 2\)$/);
  assert.deepEqual(sandbox.get("shot.png"), new Uint8Array([7]));

  assert.doesNotMatch(await runVb(agent, ["download", attachment, "shot.png"], files), /\(exit/);
  assert.deepEqual(sandbox.get("shot.png"), new Uint8Array([1, 2, 3]));
});
