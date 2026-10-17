// ERP trend ingest (B5): DS0005 Table 3 (SA2 persons 2001-25) + DS0006 Table 3 (LGA persons 2001-25).
// Creates sa2_growth / lga_growth (one row per area x year, pop 0-4) + growth summary view.
// Usage: npx tsx scripts/abs-load-trends.mts
import XLSX from 'xlsx';
import { pool } from '../src/db/pool.js';
import { createLogger, attachDbSink } from '../src/log.js';

attachDbSink(pool);
const log = createLogger('abs-trends');

interface TrendRow { code: string; name: string; year: number; pop04: number }

function readTrends(file: string, sheet: string, codeIdx: number, nameIdx: number, ageIdx: number, codeRe: RegExp): TrendRow[] {
  const wb = XLSX.readFile(file);
  const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '' });
  const out: TrendRow[] = [];
  for (let i = 6; i < rows.length; i++) {
    const r = rows[i];
    const code = String(r[codeIdx] ?? '').trim();
    if (!codeRe.test(code)) continue;
    const year = Number(r[0]);
    const pop04 = Number(r[ageIdx]);
    if (!Number.isFinite(year) || !Number.isFinite(pop04)) continue;
    out.push({ code, name: String(r[nameIdx] ?? '').trim(), year, pop04 });
  }
  return out;
}

log.info('parsing DS0005 (SA2 persons)');
const sa2 = readTrends('data/abs/32350DS0005_2001-25.xlsx', 'Table 3', 9, 10, 11, /^\d{9}$/);
log.info('parsing DS0006 (LGA persons)');
const lga = readTrends('data/abs/32350DS0006_2001-25.xlsx', 'Table 3', 3, 4, 5, /^\d{4,5}$/);
log.info('parsed', { sa2: sa2.length, lga: lga.length });

await pool.query(`create table if not exists sa2_growth (
  sa2_code text, sa2_name text, year int, pop_0_4 int,
  source_file text default '32350DS0005_2001-25.xlsx', primary key (sa2_code, year))`);
await pool.query(`create table if not exists lga_growth (
  lga_code text, lga_name text, year int, pop_0_4 int,
  source_file text default '32350DS0006_2001-25.xlsx', primary key (lga_code, year))`);
await pool.query(`truncate sa2_growth`);
await pool.query(`truncate lga_growth`);

async function load(table: string, codeCol: string, nameCol: string, rows: TrendRow[]) {
  for (let i = 0; i < rows.length; i += 1000) {
    const b = rows.slice(i, i + 1000);
    const vals: unknown[] = [];
    const ph = b.map((r, j) => {
      const o = j * 4;
      vals.push(r.code, r.name, r.year, r.pop04);
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4})`;
    });
    await pool.query(`insert into ${table} (${codeCol}, ${nameCol}, year, pop_0_4) values ${ph.join(',')}
      on conflict (${codeCol}, year) do update set pop_0_4 = excluded.pop_0_4, ${nameCol} = excluded.${nameCol}`, vals);
  }
}
await load('sa2_growth', 'sa2_code', 'sa2_name', sa2);
await load('lga_growth', 'lga_code', 'lga_name', lga);

// Growth summary view: 5y and 10y kid change + CAGR (safe when prior pop = 0).
await pool.query(`create or replace view sa2_growth_summary as
  select sa2_code, max(sa2_name) as sa2_name,
    max(pop_0_4) filter (where year = 2015) as pop_2015,
    max(pop_0_4) filter (where year = 2020) as pop_2020,
    max(pop_0_4) filter (where year = 2025) as pop_2025,
    max(pop_0_4) filter (where year = 2025) - max(pop_0_4) filter (where year = 2020) as kids_added_5y,
    max(pop_0_4) filter (where year = 2025) - max(pop_0_4) filter (where year = 2015) as kids_added_10y,
    case when max(pop_0_4) filter (where year = 2020) > 0 and max(pop_0_4) filter (where year = 2025) is not null
      then power(1.0 * (max(pop_0_4) filter (where year = 2025)) / (max(pop_0_4) filter (where year = 2020)), 0.2) - 1 end as cagr_5y
  from sa2_growth group by sa2_code`);
await pool.query(`create or replace view lga_growth_summary as
  select lga_code, max(lga_name) as lga_name,
    max(pop_0_4) filter (where year = 2020) as pop_2020,
    max(pop_0_4) filter (where year = 2025) as pop_2025,
    max(pop_0_4) filter (where year = 2025) - max(pop_0_4) filter (where year = 2020) as kids_added_5y
  from lga_growth group by lga_code`);

const v = await pool.query(`select
  (select count(distinct sa2_code) from sa2_growth) as sa2_areas,
  (select count(distinct lga_code) from lga_growth) as lga_areas,
  (select sum(pop_0_4) from sa2_growth where year = 2025) as sa2_kids_2025,
  (select sum(pop_0_4) from sa2_demand) as demand_kids,
  (select count(*) from sa2_growth where year = 2025) as sa2_rows_2025`);
log.info('verify', v.rows[0] as Record<string, unknown>);
const growth = await pool.query(`select sa2_code, sa2_name, pop_2020, pop_2025, kids_added_5y, round(cagr_5y::numeric, 4) as cagr
  from sa2_growth_summary where sa2_name ilike '%Mickleham%' or sa2_name ilike '%Schofields%' or sa2_name ilike '%Rockbank%' order by kids_added_5y desc nulls last`);
log.info('growth corridor spot check', { rows: growth.rows });
await log.close();
await pool.end();
console.log('ABS TRENDS DONE', JSON.stringify(v.rows[0]));
