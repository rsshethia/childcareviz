// Applies db/schema.sql to Neon. PostGIS is optional (lat/lon are plain doubles).
// Usage: npx tsx scripts/db-migrate.mts
import { readFileSync } from 'node:fs';
import { pool } from '../src/db/pool.js';

const sql = readFileSync('db/schema.sql', 'utf8');
try {
  await pool.query(sql);
  console.log('MIGRATE OK');
} catch (e) {
  const msg = (e as Error).message;
  if (/postgis|extension/i.test(msg)) {
    console.log('PostGIS unavailable, retrying without it');
    await pool.query(sql.replace(/create extension[^;]+;/i, ''));
    console.log('MIGRATE OK (no postgis)');
  } else {
    console.log('MIGRATE FAILED:', msg);
    process.exit(1);
  }
}
const t = await pool.query(
  "select tablename from pg_tables where schemaname='public' order by 1"
);
console.log('tables:', t.rows.map((r) => r.tablename).join(','));
await pool.query(`alter table service_fees_history add column if not exists quarantine text`);
await pool.query(`alter table service_fees_history add column if not exists stale boolean`);
await pool.query(`alter table services add column if not exists provider_type text`);
await pool.query(`alter table services add column if not exists provider_type_confidence double precision`);
console.log('columns ok');
await pool.end();
