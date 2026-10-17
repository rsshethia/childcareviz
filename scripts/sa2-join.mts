// Spatial join v2 (B1): services -> SA2 via PostGIS ST_Contains (sa2_boundary), then typed supply.
// Fixes v1's mislabelled metric: `ldc_places` is now LDC-only; preschool/OSHC/FDC/other are separate columns.
// Outputs: service_sa2 + sa2_supply + dashboard/sa2.json. Re-runnable.
// Usage: npx tsx scripts/sa2-join.mts  (needs `npm run sa2:boundary` first)
import { writeFileSync, mkdirSync } from 'node:fs';
import { pool } from '../src/db/pool.js';
import { createLogger, attachDbSink } from '../src/log.js';

attachDbSink(pool);
const log = createLogger('sa2-join');

const guard = await pool.query(`select count(*) as n from sa2_boundary`);
if (Number(guard.rows[0].n) === 0) {
  console.error('sa2_boundary empty — run `npm run sa2:boundary` first');
  process.exit(1);
}

// 1) Point-in-polygon join via PostGIS (replaces v1's hand-rolled shapefile maths).
await pool.query(`create index if not exists idx_sa2_boundary_geom on sa2_boundary using gist (geom)`);
await pool.query(`create table if not exists service_sa2 (
  service_approval_no text primary key references services(service_approval_no),
  sa2_code text, method text default 'point-in-polygon', created_at timestamptz default now())`);
await pool.query(`truncate service_sa2`);
const assign = await pool.query(`insert into service_sa2 (service_approval_no, sa2_code, method)
  select s.service_approval_no, b.sa2_code, 'postgis-ST_Contains'
  from services s
  join sa2_boundary b on ST_Contains(b.geom, ST_SetSRID(ST_MakePoint(s.lon, s.lat), 4326))
  where s.lat is not null and s.lon is not null`);
const missed = await pool.query(`select count(*) as n from services s
  where s.lat is not null and s.lon is not null
    and not exists (select 1 from service_sa2 x where x.service_approval_no = s.service_approval_no)`);
log.info('join done', { assigned: assign.rowCount, missed: missed.rows[0].n });

// 2) Typed supply columns (idempotent).
await pool.query(`create table if not exists sa2_supply (
  sa2_code text primary key, services_n int, ldc_places int, pop_0_4 int,
  places_per_100 double precision, band text)`);
for (const col of ['preschool_places int', 'oshc_places int', 'fdc_places int', 'other_places int',
  'n_ldc int', 'n_preschool int', 'n_oshc int', 'n_fdc int', 'updated_at timestamptz default now()']) {
  await pool.query(`alter table sa2_supply add column if not exists ${col}`);
}

// 3) Recompute supply from scratch: zero, upsert per-SA2 aggregation, add missing demand areas.
await pool.query(`update sa2_supply set services_n=0, ldc_places=0, preschool_places=0, oshc_places=0,
  fdc_places=0, other_places=0, n_ldc=0, n_preschool=0, n_oshc=0, n_fdc=0`);
await pool.query(`insert into sa2_supply (sa2_code, services_n, ldc_places, preschool_places, oshc_places, fdc_places, other_places, n_ldc, n_preschool, n_oshc, n_fdc)
  select ss.sa2_code, count(*),
    coalesce(sum(s.approved_places) filter (where s.is_ldc), 0),
    coalesce(sum(s.approved_places) filter (where s.is_preschool), 0),
    coalesce(sum(s.approved_places) filter (where s.is_oshc), 0),
    coalesce(sum(s.approved_places) filter (where s.is_fdc), 0),
    coalesce(sum(s.approved_places) filter (where not coalesce(s.is_ldc,false) and not coalesce(s.is_preschool,false) and not coalesce(s.is_oshc,false) and not coalesce(s.is_fdc,false)), 0),
    count(*) filter (where s.is_ldc),
    count(*) filter (where s.is_preschool),
    count(*) filter (where s.is_oshc),
    count(*) filter (where s.is_fdc)
  from service_sa2 ss join services s on s.service_approval_no = ss.service_approval_no
  group by ss.sa2_code
  on conflict (sa2_code) do update set
    services_n=excluded.services_n, ldc_places=excluded.ldc_places, preschool_places=excluded.preschool_places,
    oshc_places=excluded.oshc_places, fdc_places=excluded.fdc_places, other_places=excluded.other_places,
    n_ldc=excluded.n_ldc, n_preschool=excluded.n_preschool, n_oshc=excluded.n_oshc, n_fdc=excluded.n_fdc`);
await pool.query(`insert into sa2_supply (sa2_code, services_n, ldc_places, preschool_places, oshc_places, fdc_places, other_places, n_ldc, n_preschool, n_oshc, n_fdc)
  select sa2_code, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 from sa2_demand
  on conflict (sa2_code) do nothing`);

// 4) Demand + bands (LDC-only ratio now; thresholds remain provisional, revisit after full geocode + B2).
await pool.query(`update sa2_supply x set pop_0_4 = d.pop_0_4 from sa2_demand d where d.sa2_code = x.sa2_code`);
await pool.query(`update sa2_supply set
    places_per_100 = case when pop_0_4 > 0 then round(100.0 * ldc_places / pop_0_4, 2) end,
    band = case when pop_0_4 is null or pop_0_4 = 0 then 'no-demand-data'
      when 100.0 * ldc_places / pop_0_4 < 30 then 'desert'
      when 100.0 * ldc_places / pop_0_4 < 60 then 'constrained' else 'adequate' end,
    updated_at = now()`);

const v = await pool.query(`select band, count(*) as sa2, coalesce(sum(pop_0_4),0) as kids
  from sa2_supply group by 1 order by 3 desc`);
log.info('bands v2 (LDC-only)', { rows: v.rows });

const nat = await pool.query(`select
  (select sum(ldc_places) from sa2_supply) as ldc_places_in_sa2,
  (select sum(ldc_places) from sa2_supply) * 100.0 / (select sum(pop_0_4) from sa2_demand) as national_ldc_per_100,
  (select sum(preschool_places) from sa2_supply) as preschool_places,
  (select sum(oshc_places) from sa2_supply) as oshc_places,
  (select sum(fdc_places) from sa2_supply) as fdc_places`);
log.info('national supply', nat.rows[0] as Record<string, unknown>);

const deserts = await pool.query(`select s.sa2_code, d.sa2_name, d.state, s.services_n, s.ldc_places, d.pop_0_4,
    s.places_per_100 as pp100,
    (select kids_added_5y from sa2_growth_summary g where g.sa2_code = s.sa2_code) as kids_added_5y
  from sa2_supply s join sa2_demand d on d.sa2_code = s.sa2_code
  where s.band = 'desert' and d.pop_0_4 >= 100 order by s.places_per_100 asc limit 25`);

mkdirSync('dashboard', { recursive: true });
writeFileSync('dashboard/sa2.json', JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  bands: v.rows,
  top_deserts: deserts.rows,
  note: 'v2 (2026-10-17): LDC-only places per 100 kids 0-4. Bands provisional: desert <30, constrained 30-60, adequate 60+. SA2 assignment via PostGIS. See sa2-access.json for the 2SFCA access model.',
}, null, 1));
log.info('wrote dashboard/sa2.json');
await log.close();
await pool.end();
console.log('SA2 JOIN v2 DONE', JSON.stringify({ assigned: assign.rowCount, missed: Number(missed.rows[0].n) }));
