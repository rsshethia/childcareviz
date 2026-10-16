// Fee-phase-only loader with full counters (re-runnable: truncates fees first).
// Reads the whole file into memory (43MB) — readline streams proved flaky
// (silent early end, ~15-50% rows lost with no error). Fails loudly on mismatch.
// Usage: npx tsx scripts/db-load-fees.mts
import { readFileSync } from 'node:fs';
import { pool } from '../src/db/pool.js';
import { quarantineFee, isStale } from '../src/etl/rules.js';

const allSvc = await pool.query('select service_approval_no from services');
const seSet = new Set<string>(allSvc.rows.map((r) => r.service_approval_no));
console.log('services in DB (seSet size):', seSet.size);

console.log('truncating service_fees_history...');
await pool.query('truncate service_fees_history');

const lines = readFileSync('fees-2026-10-16.jsonl', 'utf8').split('\n');
let pushed = 0, noSe = 0, noSvc = 0, inserted = 0, batches = 0;
const feeBatch: any[] = [];
async function flush() {
  if (!feeBatch.length) return;
  const vals: any[] = [];
  const ph: string[] = [];
  feeBatch.forEach((r, i) => {
    const o = i * 11;
    ph.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11})`);
    vals.push(r.service_approval_no, r.startingblocks_ulid || null, r.age_group, r.session_type, r.fee,
      r.inclusions?.length ? r.inclusions : null,
      r.fee_last_updated ? new Date(r.fee_last_updated) : null, !!r.has_vacancy,
      quarantineFee(r.session_type, r.fee), isStale(r.fee_last_updated ?? null), r.source_url);
  });
  const n = feeBatch.length;
  feeBatch.length = 0;
  await pool.query(
    `insert into service_fees_history
      (service_approval_no, startingblocks_ulid, age_group, session_type, fee, inclusions, fee_last_updated, has_vacancy, quarantine, stale, source_url)
     values ${ph.join(',')}`, vals
  );
  inserted += n;
  batches++;
  if (batches % 30 === 0) console.log(`progress batches=${batches} inserted=${inserted}`);
}

for (const line of lines) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  if (!r.service_approval_no) { noSe++; continue; }
  if (!seSet.has(r.service_approval_no)) { noSvc++; continue; }
  feeBatch.push(r);
  pushed++;
  if (feeBatch.length >= 500) await flush();
}
await flush();
const v = await pool.query('select count(*) as fees from service_fees_history');
const dbCount = Number(v.rows[0].fees);
console.log(JSON.stringify({ file_lines: lines.length, pushed, noSe, noSvc, inserted, db: dbCount }));
if (inserted !== pushed || dbCount !== pushed) {
  console.error(`MISMATCH: pushed=${pushed} inserted=${inserted} db=${dbCount} — aborting loudly`);
  process.exit(1);
}
console.log('FEE LOAD OK — counts reconcile');
await pool.end();
