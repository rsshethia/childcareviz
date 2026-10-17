// B1: Two-Step Floating Catchment Area (2SFCA) access model for childcare (LDC places vs kids 0-4).
// v1 distance basis: crow-flies x circuity 1.35 @ 40 km/h ~ 15 min = 7.4 km crow, 30 min = 14.8 km crow.
// (B2 upgrades the decay basis to cached Mapbox travel-time isochrones later.)
// Stepped decay: w=1.0 within 15 min; w=0.5 within 15-30 min. Bands = national tertiles among SA2s with >=100 kids.
// Outputs: sa2_access table + dashboard/sa2-access.json. Needs sa2_points (npm run sa2:boundary) + typed services.
// Usage: npx tsx scripts/sa2-access.mts
import { writeFileSync, mkdirSync } from 'node:fs';
import { pool } from '../src/db/pool.js';
import { createLogger, attachDbSink } from '../src/log.js';

attachDbSink(pool);
const log = createLogger('sa2-access');

const CIRCUITY = 1.35;
const SPEED_KMH = 40;
const R15 = Math.round((15 / 60) * SPEED_KMH * 1000 / CIRCUITY); // ~7407 m crow
const R30 = Math.round((30 / 60) * SPEED_KMH * 1000 / CIRCUITY); // ~14815 m crow

const guard = await pool.query(`select count(*) as n from sa2_points`);
if (Number(guard.rows[0].n) === 0) {
  console.error('sa2_points empty — run `npm run sa2:boundary` first');
  process.exit(1);
}
const svcCount = await pool.query(`select count(*) as n from services where is_ldc and lat is not null and approved_places > 0`);
log.info('ldc services with places + coords', { n: svcCount.rows[0].n, R15, R30 });

// 1) Materialise supply + demand points with geography columns.
await pool.query(`drop table if exists access_svc`);
await pool.query(`create unlogged table access_svc as
  select service_approval_no as se, approved_places as places,
    ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography as geog
  from services where is_ldc and lat is not null and approved_places > 0`);
await pool.query(`create index on access_svc using gist (geog)`);

await pool.query(`drop table if exists access_sa2`);
await pool.query(`create unlogged table access_sa2 as
  select p.sa2_code, d.pop_0_4,
    ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)::geography as geog
  from sa2_points p join sa2_demand d on d.sa2_code = p.sa2_code
  where d.pop_0_4 > 0`);
await pool.query(`create index on access_sa2 using gist (geog)`);
log.info('points ready', {
  svc: (await pool.query('select count(*) as n from access_svc')).rows[0].n,
  sa2: (await pool.query('select count(*) as n from access_sa2')).rows[0].n,
});

// 2) Service x SA2 pairs within 30-min proxy + step weights.
await pool.query(`drop table if exists access_pairs`);
await pool.query(`create unlogged table access_pairs as
  select svc.se, sa.sa2_code,
    ST_Distance(svc.geog, sa.geog) as dist_m,
    case when ST_Distance(svc.geog, sa.geog) <= ${R15} then 1.0 else 0.5 end as w
  from access_svc svc join access_sa2 sa on ST_DWithin(svc.geog, sa.geog, ${R30})`);
const pairs = await pool.query(`select count(*) as n from access_pairs`);
log.info('pairs', { n: pairs.rows[0].n });

// 3) Supply-to-demand ratios per service.
await pool.query(`drop table if exists access_ratio`);
await pool.query(`create unlogged table access_ratio as
  select svc.se, svc.places,
    sum(p.w * sa.pop_0_4) as demand_w,
    svc.places::float / nullif(sum(p.w * sa.pop_0_4), 0) as ratio
  from access_pairs p
  join access_svc svc on svc.se = p.se
  join access_sa2 sa on sa.sa2_code = p.sa2_code
  group by svc.se, svc.places`);
const noDemand = await pool.query(`select count(*) as n from access_ratio where ratio is null`);
log.info('ratios', { services: (await pool.query('select count(*) as n from access_ratio')).rows[0].n, zeroDemand: noDemand.rows[0].n });

// 4) Access scores per SA2 (sum of reachable service ratios, decay-weighted).
await pool.query(`drop table if exists sa2_access`);
await pool.query(`create table sa2_access as
  select sa.sa2_code,
    sum(case when p.dist_m <= ${R15} then r.ratio else 0 end) as score_15,
    sum(p.w * r.ratio) as score_30,
    count(*) as services_30min
  from access_pairs p
  join access_ratio r on r.se = p.se
  join access_sa2 sa on sa.sa2_code = p.sa2_code
  where r.ratio is not null
  group by sa.sa2_code`);
await pool.query(`alter table sa2_access add column if not exists pop_0_4 int`);
await pool.query(`alter table sa2_access add column if not exists ratio_vs_median double precision`);
await pool.query(`alter table sa2_access add column if not exists band text`);
await pool.query(`alter table sa2_access add column if not exists computed_at timestamptz default now()`);
await pool.query(`update sa2_access a set pop_0_4 = d.pop_0_4 from sa2_demand d where d.sa2_code = a.sa2_code`);
// SA2s whose point reaches no service at all still belong in the model (explicit zero access).
await pool.query(`insert into sa2_access (sa2_code, score_15, score_30, services_30min, pop_0_4)
  select d.sa2_code, 0, 0, 0, d.pop_0_4 from sa2_demand d
  where not exists (select 1 from sa2_access a where a.sa2_code = d.sa2_code)`);

// 5) Bands: national tertiles among SA2s with >=100 kids (relative access), plus explicit no-service state.
await pool.query(`with base as (
    select score_30 from sa2_access where pop_0_4 >= 100 and score_30 > 0
  ), cut as (
    select percentile_cont(0.3333) within group (order by score_30) as p33,
           percentile_cont(0.6667) within group (order by score_30) as p67
    from base
  )
  update sa2_access a set band = case
    when a.score_30 is null or a.score_30 <= 0 then 'no-service'
    when a.score_30 < (select p33 from cut) then 'desert'
    when a.score_30 < (select p67 from cut) then 'constrained'
    else 'adequate' end,
  ratio_vs_median = a.score_30`);
const cut = await pool.query(`select
  percentile_cont(0.5) within group (order by score_30) as median,
  percentile_cont(0.3333) within group (order by score_30) as p33,
  percentile_cont(0.6667) within group (order by score_30) as p67
  from sa2_access where pop_0_4 >= 100 and score_30 > 0`);
log.info('tertile cutoffs', cut.rows[0] as Record<string, unknown>);

// 6) Sanity: correlation vs the crude LDC places-per-100 ratio.
const corr = await pool.query(`select round(corr(a.score_30, s.places_per_100)::numeric, 3) as pearson,
  count(*) as n
  from sa2_access a join sa2_supply s on s.sa2_code = a.sa2_code
  where a.pop_0_4 >= 100 and a.score_30 is not null and s.places_per_100 is not null`);
log.info('corr(score_30, places_per_100)', corr.rows[0] as Record<string, unknown>);

const bands = await pool.query(`select band, count(*) as sa2, coalesce(sum(pop_0_4),0) as kids
  from sa2_access group by 1 order by 3 desc`);
log.info('bands', { rows: bands.rows });

const top = await pool.query(`select a.sa2_code, d.sa2_name, d.state, a.services_30min, d.pop_0_4,
    round(a.score_30::numeric, 1) as score_30,
    (select round(dv_pct::numeric,1) from aedc_sa2 e where e.sa2_code = a.sa2_code and e.collection_year = 2024) as aedc_dv_pct,
    (select irsad_decile from seifa_sa2 f where f.sa2_code = a.sa2_code) as irsad_decile,
    (select kids_added_5y from sa2_growth_summary g where g.sa2_code = a.sa2_code) as kids_added_5y
  from sa2_access a join sa2_demand d on d.sa2_code = a.sa2_code
  where a.band = 'desert' and d.pop_0_4 >= 100 order by a.score_30 asc limit 25`);

mkdirSync('dashboard', { recursive: true });
writeFileSync('dashboard/sa2-access.json', JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  method: '2SFCA v1 (stepped decay; 15min w=1, 15-30min w=0.5; distance proxy crow x1.35 @40km/h)',
  cutoffs: cut.rows[0],
  bands: bands.rows,
  top_access_gaps: top.rows,
  note: 'Advisory: v1 distance proxy. B2 upgrades decay to Mapbox travel-time isochrones. Bands are national tertiles among SA2s with >=100 kids 0-4.',
}, null, 1));
log.info('wrote dashboard/sa2-access.json');
await log.close();
await pool.end();
console.log('SA2 ACCESS DONE');
