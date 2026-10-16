// DB connection probe. Prints only status/counts, never credentials.
// Usage: npx tsx scripts/db-probe.mts (reads PG* vars from .env, dotenv not required if env already set)
import { readFileSync, existsSync } from 'node:fs';
import { Client } from 'pg';

if (existsSync('.env') && !process.env.PGHOST) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}
const client = new Client({
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
});
try {
  await client.connect();
  const r = await client.query('select version() as v, current_database() as db');
  console.log('CONNECTED db=', r.rows[0].db);
  console.log('server=', String(r.rows[0].v).split(' ').slice(0, 2).join(' '));
  const t = await client.query(
    "select count(*)::int as n from information_schema.tables where table_schema='public'"
  );
  console.log('public tables=', t.rows[0].n);
} catch (e) {
  console.log('CONNECT FAILED:', (e as Error).message);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
