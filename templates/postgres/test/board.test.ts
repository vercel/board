// The template on PGlite (Postgres in this process) served over a socket, so `pg` and
// `pnpm db:schema` talk to it as they would to a real database.
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { board } from "@vercel/board";
import { postgres } from "@vercel/board/backend-postgres";

const run = promisify(execFile);
const db = await PGlite.create();
const port = 20_000 + Math.floor(Math.random() * 20_000);
// PGlite has one connection, so the board's pool below opens one too.
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });

before(async () => {
  await server.start();
  process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
});

after(async () => {
  await server.stop();
  await db.close();
});

test("db:schema applies the board's tables, and again leaves them alone", async () => {
  for (let i = 0; i < 2; i++) {
    const { stdout } = await run(process.execPath, ["scripts/schema.ts"], { env: process.env });
    assert.match(stdout, /tables are in place/);
  }
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from pg_tables where tablename like 'board_%'");
  assert.ok(rows[0]!.n > 0);
});

test("a board on DATABASE_URL keeps a thread in the database", async () => {
  const backend = postgres({ max: 1 });
  const team = board({ backend });
  try {
    const root = await team.post("general", "hello from postgres");
    await team.reply(root.id, "a reply");
    const { rows } = await db.query<{ text: string }>("select text_lower as text from board_messages order by id");
    assert.deepEqual(rows.map((row) => row.text), ["hello from postgres", "a reply"]);
    const thread = await team.thread(root.id);
    assert.equal(thread.replies.length, 1);
  } finally {
    await backend.close();
  }
});

test("with autoMigrate, a board on an empty database creates its tables on the first request", async () => {
  const empty = await PGlite.create();
  const emptyPort = port + 1;
  const emptyServer = new PGLiteSocketServer({ db: empty, port: emptyPort, host: "127.0.0.1" });
  await emptyServer.start();
  const backend = postgres({ connectionString: `postgres://postgres@127.0.0.1:${emptyPort}/postgres?sslmode=disable`, max: 1, autoMigrate: true });
  try {
    const team = board({ backend });
    assert.equal((await team.post("general", "first")).text, "first");
  } finally {
    await backend.close();
    await emptyServer.stop();
    await empty.close();
  }
});
