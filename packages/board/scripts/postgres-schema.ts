// Writes sql/postgres/schema.sql, and src/store/postgres-schema.generated.ts with it: the bundled A2 release's schema.sql, then board's tables, so a
// database needs one file. Run it after changing the tables or bumping experimental-a2:
// test/postgres.test.ts fails until the file matches.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { postgresSchema } from '../src/store/postgres-db.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const a2 = join(dirname(createRequire(import.meta.url).resolve('experimental-a2/package.json')), 'sql', 'postgres', 'schema.sql')
mkdirSync(join(root, 'sql', 'postgres'), { recursive: true })
const schema = postgresSchema(readFileSync(a2, 'utf8'))
writeFileSync(join(root, 'sql', 'postgres', 'schema.sql'), schema.sql)
// The same file, for postgres({ autoMigrate: true }) to apply: a bundled app can't read the package's files.
writeFileSync(
  join(root, 'src', 'store', 'postgres-schema.generated.ts'),
  `// Written by scripts/postgres-schema.ts from sql/postgres/schema.sql. Don't edit it by hand.\nexport const POSTGRES_SCHEMA: { sql: string; version: string } = ${JSON.stringify(schema, null, 2)}\n`,
)
