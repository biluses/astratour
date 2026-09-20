import { readFile, readdir } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) throw new Error('Configura DATABASE_URL en .env.local');
const sql = neon(url);
await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
const directory = new URL('../db/', import.meta.url);
const files = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
for (const name of files) {
  const existing = await sql`SELECT name FROM schema_migrations WHERE name = ${name}`;
  if (existing.length) continue;
  const schema = await readFile(new URL(name, directory), 'utf8');
  // Migration files deliberately contain no procedural blocks or semicolons in literals.
  const statements = schema.split(';').map(s => s.trim()).filter(Boolean);
  await sql.transaction([
    ...statements.map(statement => sql.query(statement)),
    sql`INSERT INTO schema_migrations (name) VALUES (${name})`,
  ]);
  console.log(`Migración ${name} aplicada.`);
}
