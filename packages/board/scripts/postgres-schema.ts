// Writes sql/postgres/schema.sql: the bundled A2 release's schema.sql, then board's tables, so a
// database needs one file. Run it after changing the tables or bumping experimental-a2:
// test/postgres.test.ts fails until the file matches.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { postgresSchemaSql } from '../src/store/postgres-db.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const a2 = join(dirname(createRequire(import.meta.url).resolve('experimental-a2/package.json')), 'sql', 'postgres', 'schema.sql')
mkdirSync(join(root, 'sql', 'postgres'), { recursive: true })
writeFileSync(join(root, 'sql', 'postgres', 'schema.sql'), postgresSchemaSql(readFileSync(a2, 'utf8')))
