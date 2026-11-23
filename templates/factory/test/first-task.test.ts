import assert from "node:assert/strict";
import { test } from "node:test";
import { board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { firstTask, ownRequest, startFirstTask, templateReadme } from "../lib/first-task.ts";
import { pageBoard } from "../lib/page-board.ts";
import { README as TEMPLATE_README } from "./fresh.ts";

// The factory's first task, started as the page starts it, on a real board kept in memory: what
// lands on the board is what people see, and what the agent's watcher hears.

test("a README with the template's Deploy button is the template's, and one without it isn't", () => {
  assert.equal(templateReadme(TEMPLATE_README), true);
  assert.equal(templateReadme("# Acme's factory\n\nIt works on acme/web.\n"), false);
  // A README that can't be read is nobody's to rewrite.
  assert.equal(templateReadme(undefined), false);
});

test("starting it opens one thread where the factory changes itself, written by the launcher and not by the agent", async () => {
  const team = board({ backend: local({ memory: true }) });
  const page = pageBoard(team);
  const root = await startFirstTask(page, "project-factory/rsi");
  const { messages } = await team.channel("project-factory/rsi").messages();
  assert.deepEqual(messages.map((message) => [message.id, message.channel, message.re]), [[root.id, "project-factory/rsi", null]]);
  // It says what to do, so the agent that reads it needs nothing else.
  assert.match(messages[0]!.text, /README/);
  // Whoever reads the thread sees the page asked, not the agent asking itself: the board's own
  // writes are the agent's.
  assert.equal(messages[0]!.by.actor, (await page.me()).actor);
  assert.notEqual(messages[0]!.by.actor, (await team.me()).actor);
  assert.equal((await page.me()).name, "launcher");
  // And the page can tell it started.
  assert.equal(firstTask(TEMPLATE_README, messages), "started");
});

test("asked twice, it starts once: one thread", async () => {
  const team = board({ backend: local({ memory: true }) });
  const first = await startFirstTask(pageBoard(team), "project-factory/rsi");
  const again = await startFirstTask(pageBoard(team), "project-factory/rsi");
  assert.equal(again.id, first.id);
  assert.equal((await team.channel("project-factory/rsi").messages()).messages.length, 1);
});

test("a team's factories share a board, and each starts its own first task there", async () => {
  const team = board({ backend: local({ memory: true }) });
  const a = await startFirstTask(team, "project-web/rsi");
  const b = await startFirstTask(team, "project-api/rsi");
  assert.notEqual(a.id, b.id);
  assert.deepEqual((await team.channel("project-api/rsi").messages()).messages.map((message) => message.id), [b.id]);
});

test("the page's handle opens threads where the factory changes itself, and writes nowhere else", async () => {
  const team = board({ backend: local({ memory: true }) });
  const page = pageBoard(team);
  const elsewhere = await team.post("project-factory/web", "a thread about a repo");
  await assert.rejects(page.post("project-factory/web", "onboard something"), { code: "forbidden" });
  await assert.rejects(page.post("project-factory", "hello"), { code: "forbidden" });
  await assert.rejects(page.post("another-team", "hello"), { code: "forbidden" });
  // A thread it can't read isn't there for it at all.
  await assert.rejects(page.reply(elsewhere.id, "and this"));
  await assert.rejects(page.react(elsewhere.id, "eyes"));
  const { messages } = await team.channel("project-factory/web").messages();
  assert.deepEqual(messages.map((message) => [message.text, Object.keys(message.reactions ?? {})]), [["a thread about a repo", []]]);
  for (const channel of ["project-factory", "another-team"]) assert.deepEqual((await team.channel(channel).messages()).messages, [], channel);
});

test("the first task is on offer while the README is the template's and nothing started it, and gone once the README is the team's", async () => {
  const team = board({ backend: local({ memory: true }) });
  await team.post("project-factory/rsi", "hello");
  const { messages } = await team.channel("project-factory/rsi").messages();
  assert.equal(firstTask(TEMPLATE_README, messages), "offer");
  assert.equal(firstTask(TEMPLATE_README, []), "offer");
  assert.equal(firstTask("# Acme's factory\n", messages), null);
  assert.equal(firstTask(undefined, messages), null);
});

test("only the deployment's own page, or something that isn't a browser, starts it", () => {
  assert.equal(ownRequest("https://factory.acme.dev", "factory.acme.dev"), true);
  // No Origin: the Vercel CLI, an agent setting the factory up.
  assert.equal(ownRequest(null, "factory.acme.dev"), true);
  assert.equal(ownRequest("https://evil.example", "factory.acme.dev"), false);
  assert.equal(ownRequest("https://factory.acme.dev.evil.example", "factory.acme.dev"), false);
  assert.equal(ownRequest("null", "factory.acme.dev"), false);
});
