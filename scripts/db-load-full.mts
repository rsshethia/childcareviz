// Full load: providers + services (ACECQA CSVs) + fees (JSONL) into Neon.
// Idempotent: truncates domain tables first (sample rows included), reloads clean.
// Usage: npx tsx scripts/db-load-full.mts
import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import { createInterface } from 'node:readline';
import { pool } from '../src/db/pool.js';
import { classifyProvider, quarantineFee, isStale } from '../src/etl/rules.js';
import { createLogger, attachDbSink } from '../src/log.js';

attachDbSink(pool);
const log = createLogger('db-load');
await pool.query(`insert into load_runs (run_id, stage, target, notes) values ($1,'db-load','all','full load 2026-10-16') on conflict (run_id) do nothing`, [log.runId]);
log.info('load started');

function streamCsv(path: string, onBatch: (rows: any[]) => Promise<void>, size = 500): Promise<number> {
  return new Promise((resolve, reject) => {
    let batch: any[] = [];
    let n = 0;
    const parser = parse({ columns: true, relax_quotes: true, skip_empty_lines: true });
    parser.on('data', (r) => {
      batch.push(r);
      if (batch.length >= size) {
        const b = batch;
        batch = [];
        parser.pause();
        onBatch(b).then(() => parser.resume()).catch(reject);
      }
    });
    parser.on('end', async () => {
      try {
        if (batch.length) await onBatch(batch);
        resolve(n);
      } catch (e) { reject(e); }
    });
    parser.on('error', reject);
    createReadStream(path).pipe(parser);
    // count via batch sizes
    const origResolve = resolve;
    void origResolve;
    parser.on('data', () => { n++; });
  });
}

console.log('truncating (fees, services, providers)...');
log.info('truncating domain tables');
await pool.query('truncate service_fees_history, services, providers cascade');

let provN = 0;
await streamCsv('Approved-providers-au-export.csv', async (rows) => {
  const vals: any[] = [];
  const ph: string[] = [];
  let k = 0;
  for (const p of rows) {
    const no = (p['Provider Approval Number'] || '').trim();
    if (!no) continue;
    const o = k++ * 5;
    ph.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5})`);
    vals.push(no, (p['Legal Name'] || '').trim() || null, (p['Trading Name'] || '').trim() || null, (p['Suburb'] || '').trim() || null, 'Approved-providers-au-export.csv');
  }
  if (!ph.length) return;
  // minimal cols first; enrich suburb/state/postcode in second pass is overkill — keep core
  await pool.query(
    `insert into providers (provider_approval_no, legal_name, trading_name, suburb, source_file)
     values ${ph.join(',')} on conflict (provider_approval_no) do nothing`,
    vals
  );
  provN += ph.length;
});
log.info('providers loaded', { provN });

const provNameByNo = new Map<string, string>();
const all = await pool.query('select provider_approval_no, legal_name from providers');
for (const r of all.rows) provNameByNo.set(r.provider_approval_no, r.legal_name);

let svcN = 0, svcFee = 0;
await streamCsv('Education-services-au-export.csv', async (rows) => {
  for (const s of rows) {
    const se = (s['ServiceApprovalNumber'] || '').trim();
    if (!se) continue;
    const prNo = (s['Provider Approval Number'] || '').trim() || null;
    let legal = (s['ProviderLegalName'] || '').trim();
    if (!legal && prNo) legal = provNameByNo.get(prNo) || '';
    if (prNo && !provNameByNo.has(prNo)) {
      await pool.query(
        `insert into providers (provider_approval_no, legal_name, source_file) values ($1,$2,'backfill-services-csv')
         on conflict (provider_approval_no) do nothing`, [prNo, legal || prNo]
      );
      provNameByNo.set(prNo, legal || prNo);
    }
    const { t, conf } = classifyProvider(legal);
    const places = parseInt(s['NumberOfApprovedPlaces'], 10);
    await pool.query(
      `insert into services (service_approval_no, provider_approval_no, service_name, provider_legal_name,
        service_type, address, suburb, state, postcode, approved_places, overall_rating,
        provider_type, provider_type_confidence, source_file)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Education-services-au-export.csv')
       on conflict (service_approval_no) do nothing`,
      [se, prNo, (s['ServiceName'] || '').trim() || null, legal || null,
       (s['ServiceType'] || '').trim() || null, (s['ServiceAddress'] || '').trim() || null,
       (s['Suburb'] || '').trim() || null, (s['State'] || '').trim() || null,
       (s['Postcode'] || '').trim() || null, Number.isFinite(places) ? places : null,
       (s['OverallRating'] || '').trim() || null, t, conf]
    );
    svcN++;
  }
});
log.info('services loaded', { svcN });

let feeN = 0;
let batch: any[] = [];
async function flushFees() {
  if (!batch.length) return;
  const vals: any[] = [];
  const ph: string[] = [];
  batch.forEach((r, i) => {
    const o = i * 9;
    ph.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9})`);
    vals.push(r.service_approval_no, r.startingblocks_ulid || null, r.age_group, r.session_type, r.fee,
      r.inclusions?.length ? r.inclusions : null,
      r.fee_last_updated ? new Date(r.fee_last_updated) : null, r.has_vacancy, r.source_url);
  });
  // quarantine/stale computed in JS below via separate update would double roundtrips;
  // instead compute inline: we pass quarantine+stale as extra cols
  batch = [];
  await pool.query(
    `insert into service_fees_history
      (service_approval_no, startingblocks_ulid, age_group, session_type, fee, inclusions, fee_last_updated, has_vacancy, source_url)
     values ${ph.join(',')}`, vals
  );
  feeN += ph.length;
}

const rl = createInterface({ input: createReadStream('fees-2026-10-16.jsonl'), crlfDelay: Infinity });
const feeBatch: any[] = [];
async function flush2() {
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
  feeBatch.length = 0;
  await pool.query(
    `insert into service_fees_history
      (service_approval_no, startingblocks_ulid, age_group, session_type, fee, inclusions, fee_last_updated, has_vacancy, quarantine, stale, source_url)
     values ${ph.join(',')}`, vals
  );
  feeN += ph.length;
}
void flushFees;
const seSet = new Set<string>();
const allSvc = await pool.query('select service_approval_no from services');
for (const r of allSvc.rows) seSet.add(r.service_approval_no);
log.info('fee phase starting', { seSetSize: seSet.size });
let skippedNoService = 0, noSe = 0, pushedCount = 0;
const { readFileSync } = await import('node:fs');
const feeLines = readFileSync('fees-2026-10-16.jsonl', 'utf8').split('\n');
for (const line of feeLines) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  if (!r.service_approval_no) { noSe++; continue; }
  if (!seSet.has(r.service_approval_no)) { skippedNoService++; continue; } // non-NQF pages
  feeBatch.push(r);
  pushedCount++;
  if (feeBatch.length >= 500) await flush2();
}
await flush2();
if (feeN !== pushedCount) throw new Error(`fee mismatch: flushed=${feeN} pushed=${pushedCount}`);
log.info('fee rows loaded', { feeN, skippedNoService, noSe });

const v = await pool.query(`select (select count(*) from providers) as providers,
  (select count(*) from services) as services,
  (select count(*) from service_fees_history) as fees,
  (select count(*) from service_fees_history where quarantine is null) as clean,
  (select count(distinct service_approval_no) from service_fees_history where fee is not null) as services_with_fee`);
log.info('verify counts', v.rows[0] as Record<string, unknown>);
await pool.query(`insert into crawl_log (finished_at, urls_targeted, urls_ok, urls_fee_found, urls_failed, notes)
  values (now(), 18492, 18419, 10454, 73, 'full load 2026-10-16: providers+services+fees with quarantine/stale')`);
await pool.query(`update load_runs set rows_ok=$2, rows_skipped=$3, finished_at=now(), notes=$4 where run_id=$1`,
  [log.runId, feeN, skippedNoService, 'providers+services+fees']);
await log.close();
await pool.end();
console.log('FULL LOAD DONE run=' + log.runId);
