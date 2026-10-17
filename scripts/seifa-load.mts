// Load SEIFA 2021 SA2 indexes (Table 1 summary cube) into seifa_sa2.
// Source: ABS "Statistical Area Level 2, Indexes, SEIFA 2021.xlsx" (data/abs/).
// Usage: npx tsx scripts/seifa-load.mts
import XLSX from 'xlsx';
import { pool } from '../src/db/pool.js';
import { createLogger, attachDbSink } from '../src/log.js';

attachDbSink(pool);
const log = createLogger('seifa-load');

const wb = XLSX.readFile('data/abs/SEIFA_2021_SA2_Indexes.xlsx');
const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets['Table 1'], { header: 1, defval: '' });

interface Row {
  code: string; name: string; pop: number | null;
  irsd_score: number | null; irsd_decile: number | null;
  irsad_score: number | null; irsad_decile: number | null;
  ier_score: number | null; ier_decile: number | null;
  ieo_score: number | null; ieo_decile: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const out: Row[] = [];
for (let i = 6; i < rows.length; i++) {
  const r = rows[i];
  const code = String(r[0] ?? '').trim();
  if (!/^\d{9}$/.test(code)) continue;
  const name = String(r[1] ?? '').trim();
  if (!name) continue;
  out.push({
    code, name, pop: num(r[10]),
    irsd_score: num(r[2]), irsd_decile: num(r[3]),
    irsad_score: num(r[4]), irsad_decile: num(r[5]),
    ier_score: num(r[6]), ier_decile: num(r[7]),
    ieo_score: num(r[8]), ieo_decile: num(r[9]),
  });
}
log.info('parsed', { n: out.length });

await pool.query(`create table if not exists seifa_sa2 (
  sa2_code text primary key, sa2_name text, pop int,
  irsd_score double precision, irsd_decile int,
  irsad_score double precision, irsad_decile int,
  ier_score double precision, ier_decile int,
  ieo_score double precision, ieo_decile int,
  source_file text, loaded_at timestamptz default now())`);
await pool.query(`truncate seifa_sa2`);

for (let i = 0; i < out.length; i += 500) {
  const b = out.slice(i, i + 500);
  const vals: unknown[] = [];
  const ph = b.map((r, j) => {
    const o = j * 11;
    vals.push(r.code, r.name, r.pop, r.irsd_score, r.irsd_decile, r.irsad_score, r.irsad_decile, r.ier_score, r.ier_decile, r.ieo_score, r.ieo_decile);
    return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11},'SEIFA_2021_SA2_Indexes.xlsx')`;
  });
  await pool.query(`insert into seifa_sa2 (sa2_code, sa2_name, pop, irsd_score, irsd_decile, irsad_score, irsad_decile, ier_score, ier_decile, ieo_score, ieo_decile, source_file)
    values ${ph.join(',')} on conflict (sa2_code) do update set
      sa2_name=excluded.sa2_name, pop=excluded.pop,
      irsd_score=excluded.irsd_score, irsd_decile=excluded.irsd_decile,
      irsad_score=excluded.irsad_score, irsad_decile=excluded.irsad_decile,
      ier_score=excluded.ier_score, ier_decile=excluded.ier_decile,
      ieo_score=excluded.ieo_score, ieo_decile=excluded.ieo_decile, loaded_at=now()`, vals);
}

const v = await pool.query(`select
  (select count(*) from seifa_sa2) as seifa,
  (select count(*) from seifa_sa2 s join sa2_demand d on d.sa2_code = s.sa2_code) as joined_demand,
  (select count(*) from sa2_demand d where not exists (select 1 from seifa_sa2 s where s.sa2_code = d.sa2_code)) as demand_no_seifa,
  (select count(*) from seifa_sa2 where irsad_decile is null) as no_irsad`);
log.info('verify', v.rows[0] as Record<string, unknown>);
const dist = await pool.query(`select irsad_decile, count(*) from seifa_sa2 group by 1 order by 1`);
log.info('irsad decile distribution', { dist: dist.rows });
const spot = await pool.query(`select sa2_code, sa2_name, irsad_score, irsad_decile, irsd_decile from seifa_sa2 where sa2_name in ('Woollahra - North','Woorabinda','Schofields - East') order by 1`);
log.info('spot check', { rows: spot.rows });
await log.close();
await pool.end();
console.log('SEIFA LOAD DONE', JSON.stringify(v.rows[0]));
