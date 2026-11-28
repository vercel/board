// Applies the board's tables to DATABASE_URL's database (or POSTGRES_URL's). Every statement creates
// only what's missing, so it's safe to run again: after each @vercel/board upgrade whose changelog
// says the tables changed.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import pg from "pg";

const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!connectionString) {
  console.error("db:schema: set DATABASE_URL, or pull it into .env.local with vercel env pull");
  process.exit(1);
}

const pkg = dirname(createRequire(import.meta.url).resolve("@vercel/board/package.json"));
const sql = readFileSync(join(pkg, "sql", "postgres", "schema.sql"), "utf8");

const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query(sql);
  console.log("db:schema: the board's tables are in place");
} finally {
  await client.end();
}
