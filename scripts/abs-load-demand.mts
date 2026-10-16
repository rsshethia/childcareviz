// ABS ERP demand ingest: DS0001 Table 3 (SA2 2025) + DS0003 Table 3 (LGA 2025), persons 0-4.
// Layout (verified): 6 header rows, data from index 6; DS0001: SA2 code idx 8,
// name idx 9, age 0-4 idx 10, total idx 28. DS0003: LGA code idx 2, name idx 3,
// age 0-4 idx 4, total idx 22.
// Usage: npx tsx scripts/abs-load-demand.mts
import XLSX from 'xlsx';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pool } from '../src/db/pool.js';
import { createLogger, attachDbSink } from '../src/log.js';

attachDbSink(pool);
const log = createLogger('abs-demand');

interface DemandRow { code: string; name: string; state: string; pop04: number; popTotal: number }

function readTable(file: string, sheet: string, geoIdx: number[], ageIdx: number, totalIdx: number): DemandRow[] {
  const wb = XLSX.readFile(file);
  const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '' });
  const out: DemandRow[] = [];
  for (let i = 6; i < rows.length; i++) {
    const r = rows[i];
    const code = String(r[geoIdx[0]] ?? '').trim();
    if (!code || !/^\d+$/.test(code)) continue;
    const pop04 = Number(r[ageIdx]);
    const popTotal = Number(r[totalIdx]);
    if (!Number.isFinite(pop04)) continue;
    out.push({ code, name: String(r[geoIdx[1]] ?? '').trim(), state: String(r[1] ?? '').trim(), pop04, popTotal });
  }
  return out;
}

const sa2 = readTable('data/abs/32350DS0001_2025.xlsx', 'Table 3', [8, 9], 10, 28);
const lga = readTable('data/abs/32350DS0003_2025.xlsx', 'Table 3', [2, 3], 4, 22);
log.info('parsed', { sa2: sa2.length, lga: lga.length });

await pool.query(`create table if not exists sa2_demand (
  sa2_code text primary key, sa2_name text, state text,
  pop_0_4 int not null, pop_total int, year int default 2025, source_file text)`);
await pool.query(`create table if not exists lga_demand (
  lga_code text primary key, lga_name text, state text,
  pop_0_4 int not null, pop_total int, year int default 2025, source_file text)`);

async function load(table: string, codeCol: string, nameCol: string, rows: DemandRow[], file: string) {
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const b = rows.slice(i, i + 500);
    const vals: unknown[] = [];
    const ph = b.map((r, j) => {
      const o = j * 6;
      vals.push(r.code, r.name, r.state, r.pop04, r.popTotal, file);
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},2025)`;
    });
    await pool.query(`insert into ${table} (${codeCol}, ${nameCol}, state, pop_0_4, pop_total, source_file, year)
      values ${ph.join(',')} on conflict (${codeCol}) do update set pop_0_4=excluded.pop_0_4, pop_total=excluded.pop_total, year=2025, source_file=excluded.source_file`, vals);
    n += b.length;
  }
  return n;
}
const n1 = await load('sa2_demand', 'sa2_code', 'sa2_name', sa2, '32350DS0001_2025.xlsx');
const n2 = await load('lga_demand', 'lga_code', 'lga_name', lga, '32350DS0003_2025.xlsx');

const v = await pool.query(`select (select count(*) from sa2_demand) as sa2,
  (select sum(pop_0_4) from sa2_demand) as sa2_kids,
  (select count(*) from lga_demand) as lga,
  (select sum(pop_0_4) from lga_demand) as lga_kids`);
log.info('verify', v.rows[0] as Record<string, unknown>);
mkdirSync('data/processed', { recursive: true });
writeFileSync('data/processed/sa2_demand_2025.csv',
  'sa2_code,sa2_name,state,pop_0_4,pop_total\n' + sa2.map((r) => [r.code, JSON.stringify(r.name), JSON.stringify(r.state), r.pop04, r.popTotal].join(',')).join('\n'));
writeFileSync('data/processed/lga_demand_2025.csv',
  'lga_code,lga_name,state,pop_0_4,pop_total\n' + lga.map((r) => [r.code, JSON.stringify(r.name), JSON.stringify(r.state), r.pop04, r.popTotal].join(',')).join('\n'));
await log.close();
await pool.end();
console.log('ABS DEMAND DONE', JSON.stringify(v.rows[0]));
