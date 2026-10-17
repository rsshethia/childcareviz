// Load AEDC 2024 (2009-24 series) SA2 "vulnerable on one or more domains" into aedc_sa2.
// Source: AEDC "sa2-2009-24.xlsx" (data/abs/), public data — cite AEDC in outputs.
// Usage: npx tsx scripts/aedc-load.mts
import XLSX from 'xlsx';
import { pool } from '../src/db/pool.js';
import { createLogger, attachDbSink } from '../src/log.js';

attachDbSink(pool);
const log = createLogger('aedc-load');

const YEARS = [2009, 2012, 2015, 2018, 2021, 2024];
const wb = XLSX.readFile('data/abs/AEDC_2009-24_SA2.xlsx');
const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets['SA2 One or more'], { header: 1, defval: '' });

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : null;
};

interface Row { code: string; name: string; year: number; valid_n: number | null; dv_n: number | null; dv_pct: number | null }
const out: Row[] = [];
for (let i = 6; i < rows.length; i++) {
  const r = rows[i];
  const code = String(r[0] ?? '').trim();
  if (!/^\d{9}$/.test(code)) continue;
  const name = String(r[1] ?? '').trim();
  for (let k = 0; k < YEARS.length; k++) {
    const valid = num(r[2 + k]);
    const dvN = num(r[8 + 2 * k]);
    const dvPct = num(r[9 + 2 * k]);
    if (valid === null && dvN === null && dvPct === null) continue;
    out.push({ code, name, year: YEARS[k], valid_n: valid, dv_n: dvN, dv_pct: dvPct });
  }
}
log.info('parsed', { rows: out.length });

await pool.query(`create table if not exists aedc_sa2 (
  sa2_code text, sa2_name text, collection_year int,
  valid_n int, dv_n int, dv_pct double precision,
  source_file text default 'AEDC sa2-2009-24.xlsx', loaded_at timestamptz default now(),
  primary key (sa2_code, collection_year))`);
await pool.query(`truncate aedc_sa2`);

for (let i = 0; i < out.length; i += 1000) {
  const b = out.slice(i, i + 1000);
  const vals: unknown[] = [];
  const ph = b.map((r, j) => {
    const o = j * 6;
    vals.push(r.code, r.name, r.year, r.valid_n, r.dv_n, r.dv_pct);
    return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`;
  });
  await pool.query(`insert into aedc_sa2 (sa2_code, sa2_name, collection_year, valid_n, dv_n, dv_pct)
    values ${ph.join(',')} on conflict (sa2_code, collection_year) do update set
      sa2_name=excluded.sa2_name, valid_n=excluded.valid_n, dv_n=excluded.dv_n, dv_pct=excluded.dv_pct, loaded_at=now()`, vals);
}

const v = await pool.query(`select
  (select count(distinct sa2_code) from aedc_sa2) as sa2s,
  (select count(*) from aedc_sa2 where collection_year = 2024) as rows_2024,
  (select sum(valid_n) from aedc_sa2 where collection_year = 2024) as kids_2024,
  (select round(100.0 * sum(dv_n) / nullif(sum(valid_n), 0), 2) from aedc_sa2 where collection_year = 2024) as dv_pct_national_2024,
  (select count(*) from aedc_sa2 a join sa2_demand d on d.sa2_code = a.sa2_code where a.collection_year = 2024) as joined_demand_2024`);
log.info('verify', v.rows[0] as Record<string, unknown>);
const spot = await pool.query(`select sa2_code, sa2_name, valid_n, dv_n, round(dv_pct::numeric, 1) as dv_pct
  from aedc_sa2 where collection_year = 2024 and sa2_name in ('Braidwood','Schofields - East','Mickleham - Yuroke') order by 2`);
log.info('spot check', { rows: spot.rows });
await log.close();
await pool.end();
console.log('AEDC LOAD DONE', JSON.stringify(v.rows[0]));
