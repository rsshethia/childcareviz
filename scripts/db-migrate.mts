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
// Service flavours + operating profile (B0: spatial-equity program)
for (const col of [
  'is_ldc boolean', 'is_preschool boolean', 'is_oshc boolean', 'is_fdc boolean', 'is_other boolean',
  'temporarily_closed boolean', 'granted_date date', 'hours jsonb', 'days_open int',
  'weekday_open_min int', 'weekday_close_min int',
]) {
  await pool.query(`alter table services add column if not exists ${col}`);
}
await pool.query(`create table if not exists app_log (id bigserial primary key, run_id text not null, stage text not null, level text not null, message text not null, details jsonb, created_at timestamptz default now())`);
await pool.query(`create index if not exists idx_app_log_run on app_log(run_id)`);
await pool.query(`create table if not exists load_runs (id bigserial primary key, run_id text not null unique, stage text not null, target text not null, rows_ok int default 0, rows_failed int default 0, rows_skipped int default 0, started_at timestamptz default now(), finished_at timestamptz, notes text)`);
console.log('columns ok');
await pool.end();
