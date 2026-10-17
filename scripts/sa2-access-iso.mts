// B2: 2SFCA v2 on Mapbox travel-time isochrones (15/30-min contours per SA2 point).
// Loads isochrone_cache -> isochrone_geom, computes service/SA2 catchment pairs via ST_Contains,
// steps weights (w=1 within 15 min, w=0.5 for 15-30 min only), updates sa2_access iso columns,
// and rewrites dashboard/sa2-access.json (method = isochrone v2). Keeps v1 columns for QC.
// NOTE: symmetric-catchment approximation — service j in SA2 i's contour is used as
// "SA2 i in service j's catchment" (standard approximation; documented in the JSON note).
// Usage: npx tsx scripts/sa2-access-iso.mts  (after scripts/isochrone-batch.mts + sa2-access.mts)
import { writeFileSync, mkdirSync } from 'node:fs';
import { pool } from '../src/db/pool.js';
import { createLogger, attachDbSink } from '../src/log.js';

attachDbSink(pool);
const log = createLogger('sa2-access-iso');

const cached = await pool.query(`select count(*) as n from isochrone_cache`);
log.info('isochrones cached', { n: cached.rows[0].n });
if (Number(cached.rows[0].n) === 0) { console.error('isochrone_cache empty — run scripts/isochrone-batch.mts first'); process.exit(1); }

// 1) Load contour polygons into PostGIS.
await pool.query(`create table if not exists isochrone_geom (
  sa2_code text, contour_min int, geom geometry(Geometry, 4326),
  primary key (sa2_code, contour_min))`);
await pool.query(`truncate isochrone_geom`);
const cacheRows = await pool.query(`select sa2_code, geojson from isochrone_cache`);
let loadedGeoms = 0;
for (let i = 0; i < cacheRows.rows.length; i += 300) {
  const b = cacheRows.rows.slice(i, i + 300);
  const vals: unknown[] = [];
  const ph: string[] = [];
  let k = 0;
  for (const r of b) {
    const feats = (r.geojson as any).features ?? [];
    for (const f of feats) {
      const cm = Number(f?.properties?.contour);
      if (cm !== 15 && cm !== 30) continue;
      const o = k * 3;
      vals.push(r.sa2_code, cm, JSON.stringify(f.geometry));
      ph.push(`($${o + 1},$${o + 2}, ST_SetSRID(ST_GeomFromGeoJSON($${o + 3}), 4326))`);
      k++;
    }
  }
  if (!ph.length) continue;
  await pool.query(`insert into isochrone_geom (sa2_code, contour_min, geom) values ${ph.join(',')}
    on conflict (sa2_code, contour_min) do update set geom = excluded.geom`, vals);
  loadedGeoms += ph.length;
}
await pool.query(`create index if not exists idx_isochrone_geom on isochrone_geom using gist (geom)`);
log.info('isochrone geoms loaded', { loadedGeoms });

// 2) Catchment pairs: LDC service inside an SA2 contour (dedupe to the tightest contour).
await pool.query(`drop table if exists iso_pairs`);
await pool.query(`create unlogged table iso_pairs as
  select se, sa2_code, min(contour_min) as contour_min from (
    select s.service_approval_no as se, g.sa2_code, g.contour_min
    from services s
    join isochrone_geom g on ST_Contains(g.geom, ST_SetSRID(ST_MakePoint(s.lon, s.lat), 4326))
    where s.is_ldc and s.lat is not null and s.approved_places > 0
  ) t group by se, sa2_code`);
const pairs = await pool.query(`select count(*) as n from iso_pairs`);
log.info('iso pairs', { n: pairs.rows[0].n });

// 3) Ratios + access scores (same two-step as v1, different basis).
await pool.query(`drop table if exists iso_ratio`);
await pool.query(`create unlogged table iso_ratio as
  select svc.se, svc.places,
    sum(case when p.contour_min = 15 then sa.pop_0_4 else 0.5 * sa.pop_0_4 end) as demand_w,
    svc.places::float / nullif(sum(case when p.contour_min = 15 then sa.pop_0_4 else 0.5 * sa.pop_0_4 end), 0) as ratio
  from iso_pairs p
  join (select service_approval_no as se, approved_places as places from services where is_ldc and approved_places > 0) svc on svc.se = p.se
  join access_sa2 sa on sa.sa2_code = p.sa2_code
  group by svc.se, svc.places`);

await pool.query(`create unique index if not exists sa2_access_pk on sa2_access (sa2_code)`);
await pool.query(`insert into sa2_access (sa2_code) select distinct sa2_code from iso_pairs on conflict do nothing`);
await pool.query(`alter table sa2_access add column if not exists score_15_iso double precision`);
await pool.query(`alter table sa2_access add column if not exists score_30_iso double precision`);
await pool.query(`alter table sa2_access add column if not exists services_30min_iso int`);
await pool.query(`alter table sa2_access add column if not exists band_iso text`);
await pool.query(`alter table sa2_access add column if not exists method text`);

await pool.query(`update sa2_access a set
    score_15_iso = x.s15, score_30_iso = x.s30, services_30min_iso = x.n, method = '2sfca-iso'
  from (
    select sa.sa2_code,
      sum(case when p.contour_min = 15 then r.ratio else 0 end) as s15,
      sum(case when p.contour_min = 15 then r.ratio else 0.5 * r.ratio end) as s30,
      count(*) as n
    from iso_pairs p
    join iso_ratio r on r.se = p.se
    join access_sa2 sa on sa.sa2_code = p.sa2_code
    where r.ratio is not null
    group by sa.sa2_code
  ) x where x.sa2_code = a.sa2_code`);
await pool.query(`update sa2_access a set pop_0_4 = d.pop_0_4 from sa2_demand d
  where d.sa2_code = a.sa2_code and a.pop_0_4 is null`);

// 4) Iso bands: national tertiles among SA2s with >=100 kids.
await pool.query(`with base as (
    select score_30_iso from sa2_access where pop_0_4 >= 100 and score_30_iso is not null
  ), cut as (
    select percentile_cont(0.3333) within group (order by score_30_iso) as p33,
           percentile_cont(0.6667) within group (order by score_30_iso) as p67
    from base
  )
  update sa2_access a set band_iso = case
    when a.score_30_iso is null then coalesce(a.band, 'no-service')
    when a.score_30_iso < (select p33 from cut) then 'desert'
    when a.score_30_iso < (select p67 from cut) then 'constrained'
    else 'adequate' end`);
const cut = await pool.query(`select
  round(percentile_cont(0.3333) within group (order by score_30_iso)::numeric, 2) as p33,
  round(percentile_cont(0.5) within group (order by score_30_iso)::numeric, 2) as median,
  round(percentile_cont(0.6667) within group (order by score_30_iso)::numeric, 2) as p67
  from sa2_access where pop_0_4 >= 100 and score_30_iso is not null`);
log.info('iso tertile cutoffs', cut.rows[0] as Record<string, unknown>);

// 5) QC: v1 vs iso correlation + fallback count.
const qc = await pool.query(`select
  round(corr(score_30, score_30_iso)::numeric, 3) as corr_v1_iso,
  count(*) filter (where score_30_iso is null) as iso_missing,
  count(*) filter (where band_iso is distinct from band) as band_changed
  from sa2_access`);
log.info('qc v1 vs iso', qc.rows[0] as Record<string, unknown>);

const bands = await pool.query(`select coalesce(band_iso,'unknown') as band, count(*) as sa2, coalesce(sum(pop_0_4),0) as kids
  from sa2_access group by 1 order by 3 desc`);
log.info('iso bands', { rows: bands.rows });

const top = await pool.query(`select a.sa2_code, d.sa2_name, d.state, a.services_30min_iso as services_30min,
    d.pop_0_4, round(a.score_30_iso::numeric, 1) as score_30,
    (select round(dv_pct::numeric,1) from aedc_sa2 e where e.sa2_code = a.sa2_code and e.collection_year = 2024) as aedc_dv_pct,
    (select irsad_decile from seifa_sa2 f where f.sa2_code = a.sa2_code) as irsad_decile,
    (select kids_added_5y from sa2_growth_summary g where g.sa2_code = a.sa2_code) as kids_added_5y
  from sa2_access a join sa2_demand d on d.sa2_code = a.sa2_code
  where a.band_iso = 'desert' and d.pop_0_4 >= 100 order by a.score_30_iso asc limit 25`);

mkdirSync('dashboard', { recursive: true });
writeFileSync('dashboard/sa2-access.json', JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  method: '2SFCA v2 — Mapbox driving isochrones (15/30 min), stepped decay w=1 / w=0.5, symmetric-catchment approximation',
  cutoffs: cut.rows[0],
  bands: bands.rows,
  qc: qc.rows[0],
  top_access_gaps: top.rows,
  note: 'LDC places vs kids 0-4. Bands are national tertiles among SA2s with >=100 kids 0-4. v1 (distance proxy) kept in sa2_access for comparison.',
}, null, 1));
log.info('wrote dashboard/sa2-access.json (iso v2)');
await log.close();
await pool.end();
console.log('SA2 ACCESS ISO DONE');
