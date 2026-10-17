// Equity export (B1-B5 surface): merges access (2SFCA iso), SEIFA, AEDC, growth + typed supply
// into equity_sa2 + dashboard/equity.json (choropleth payload + priority lists).
// Priority flags: desert/constrained access, high vulnerability (top quartile AEDC), fast growth (>=5% CAGR or +200 kids).
// Future bands: 2030 kids projected by extending 5y CAGR with today's LDC places (scenario, not forecast).
// Usage: npx tsx scripts/equity-export.mts
import { writeFileSync, mkdirSync } from 'node:fs';
import { pool } from '../src/db/pool.js';
import { createLogger, attachDbSink } from '../src/log.js';

attachDbSink(pool);
const log = createLogger('equity-export');

await pool.query(`create table if not exists equity_sa2 (
  sa2_code text primary key, sa2_name text, state text, pop_0_4 int,
  services_n int, ldc_places int, preschool_places int, oshc_places int, fdc_places int,
  places_per_100 double precision, ratio_band text,
  score_15_iso double precision, score_30_iso double precision, access_band text,
  irsad_score double precision, irsad_decile int, irsd_decile int,
  aedc_dv_pct double precision, aedc_valid_n int,
  pop_2020 int, pop_2025 int, kids_added_5y int, cagr_5y double precision,
  kids_2030_proj int, places_per_100_2030_proj double precision, future_band text,
  priority_flags text[], updated_at timestamptz default now())`);

const p75 = await pool.query(`select percentile_cont(0.75) within group (order by dv_pct) as p75
  from aedc_sa2 where collection_year = 2024`);
const DV_HIGH = Number(p75.rows[0].p75);
log.info('thresholds', { dv_p75: DV_HIGH });

await pool.query(`truncate equity_sa2`);
await pool.query(`insert into equity_sa2 (
    sa2_code, sa2_name, state, pop_0_4,
    services_n, ldc_places, preschool_places, oshc_places, fdc_places,
    places_per_100, ratio_band, score_15_iso, score_30_iso, access_band,
    irsad_score, irsad_decile, irsd_decile,
    aedc_dv_pct, aedc_valid_n, pop_2020, pop_2025, kids_added_5y, cagr_5y,
    kids_2030_proj, places_per_100_2030_proj, future_band, priority_flags)
  select d.sa2_code, d.sa2_name, d.state, d.pop_0_4,
    s.services_n, s.ldc_places, s.preschool_places, s.oshc_places, s.fdc_places,
    s.places_per_100, s.band, a.score_15_iso, a.score_30_iso, coalesce(a.band_iso, a.band),
    f.irsad_score, f.irsad_decile, f.irsd_decile,
    e.dv_pct, e.valid_n, g.pop_2020, g.pop_2025, g.kids_added_5y, g.cagr_5y,
    case when g.pop_2025 is not null and g.cagr_5y is not null
      then round(g.pop_2025 * power(1 + g.cagr_5y, 5))::int end,
    case when g.pop_2025 is not null and g.cagr_5y is not null and round(g.pop_2025 * power(1 + g.cagr_5y, 5)) > 0
      then round(100.0 * coalesce(s.ldc_places,0) / (g.pop_2025 * power(1 + g.cagr_5y, 5)), 1) end,
    case
      when g.pop_2025 is null or g.cagr_5y is null or g.pop_2025 * power(1 + g.cagr_5y, 5) <= 0 then null
      when 100.0 * coalesce(s.ldc_places,0) / (g.pop_2025 * power(1 + g.cagr_5y, 5)) < 30 then 'desert-2030'
      when 100.0 * coalesce(s.ldc_places,0) / (g.pop_2025 * power(1 + g.cagr_5y, 5)) < 60 then 'constrained-2030'
      else 'adequate-2030' end,
    array_remove(array[
      case when coalesce(a.band_iso, a.band) in ('desert', 'no-service') then 'desert-access' end,
      case when coalesce(a.band_iso, a.band) = 'constrained' then 'constrained-access' end,
      case when e.dv_pct >= $1 then 'high-vulnerability' end,
      case when g.kids_added_5y >= 200 or g.cagr_5y >= 0.05 then 'fast-growth' end
    ], null)
  from sa2_demand d
  left join sa2_supply s on s.sa2_code = d.sa2_code
  left join sa2_access a on a.sa2_code = d.sa2_code
  left join seifa_sa2 f on f.sa2_code = d.sa2_code
  left join aedc_sa2 e on e.sa2_code = d.sa2_code and e.collection_year = 2024
  left join sa2_growth_summary g on g.sa2_code = d.sa2_code`, [DV_HIGH]);

const v = await pool.query(`select count(*) as rows,
  count(*) filter (where access_band = 'desert') as desert,
  count(*) filter (where 'high-vulnerability' = any(priority_flags)) as high_dv,
  count(*) filter (where future_band = 'desert-2030') as future_desert,
  count(*) filter (where array_length(priority_flags,1) >= 2) as priority_2plus
  from equity_sa2`);
log.info('equity table built', v.rows[0] as Record<string, unknown>);

// Combined priority score: desert/constrained(1) + high-vulnerability(1) + fast-growth(1); weighted desert 2 when high-DV.
const PRIORITY_SQL = `
  select sa2_code, sa2_name, state, pop_0_4, access_band, score_30_iso, services_n, ldc_places,
    places_per_100, irsad_decile, round(aedc_dv_pct::numeric,1) as aedc_dv_pct,
    kids_added_5y, cagr_5y, future_band, kids_2030_proj, places_per_100_2030_proj,
    priority_flags,
    (case when 'desert-access' = any(priority_flags) then 2 when 'constrained-access' = any(priority_flags) then 1 else 0 end)
    + (case when 'high-vulnerability' = any(priority_flags) then 2 else 0 end)
    + (case when 'fast-growth' = any(priority_flags) then 1 else 0 end) as priority_score
  from equity_sa2 where pop_0_4 >= 100`;
const priority = await pool.query(`${PRIORITY_SQL} and array_length(priority_flags,1) >= 2
  order by priority_score desc, pop_0_4 desc limit 60`);
const future = await pool.query(`${PRIORITY_SQL} and future_band = 'desert-2030' and access_band <> 'desert'
  order by kids_2030_proj desc nulls last limit 60`);

// Compact per-code payload for the choropleth join.
const all = await pool.query(`select sa2_code, sa2_name, pop_0_4,
    coalesce(access_band,'no-data') as b, score_30_iso,
    irsad_decile, aedc_dv_pct, kids_added_5y, ldc_places, places_per_100, future_band
  from equity_sa2`);
const byCode: Record<string, unknown[]> = {};
for (const r of all.rows) {
  byCode[r.sa2_code] = [
    Number(r.pop_0_4) || 0,
    r.b,
    r.score_30_iso === null ? null : Math.round(Number(r.score_30_iso)),
    r.irsad_decile,
    r.aedc_dv_pct === null ? null : Math.round(Number(r.aedc_dv_pct) * 10) / 10,
    r.kids_added_5y,
    r.ldc_places,
    r.places_per_100 === null ? null : Math.round(Number(r.places_per_100) * 10) / 10,
    r.future_band,
    r.sa2_name,
  ];
}

const nat = await pool.query(`select
  sum(pop_0_4) as kids, sum(ldc_places) as ldc_places,
  count(*) filter (where access_band='desert') as desert_sa2s,
  sum(pop_0_4) filter (where access_band='desert') as kids_in_deserts,
  count(*) filter (where future_band='desert-2030') as future_desert_sa2s,
  sum(kids_2030_proj) filter (where future_band='desert-2030') as kids_2030_in_future_deserts,
  count(*) filter (where array_length(priority_flags,1) >= 2) as priority_sa2s,
  count(*) filter (where 'high-vulnerability' = any(priority_flags)) as high_dv_sa2s,
  count(*) filter (where 'fast-growth' = any(priority_flags)) as fast_growth_sa2s
  from equity_sa2`);

mkdirSync('dashboard', { recursive: true });
writeFileSync('dashboard/equity.json', JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  thresholds: { dv_top_quartile_pct: Number(DV_HIGH.toFixed(1)), fast_growth_cagr: 0.05, fast_growth_kids_added: 200 },
  national: nat.rows[0],
  priority: priority.rows,
  future_risk: future.rows,
  by_code: byCode,
  legend: {
    by_code: ['pop_0_4', 'access_band', 'score_30_iso', 'irsad_decile', 'aedc_dv_pct', 'kids_added_5y', 'ldc_places', 'places_per_100', 'future_band', 'sa2_name'],
  },
  sources: {
    access: '2SFCA v2 (Mapbox isochrones 15/30min) — LDC places vs kids 0-4',
    seifa: 'ABS SEIFA 2021 SA2 indexes (IRSAD)',
    aedc: 'AEDC 2024 SA2 public tables — vulnerable on one or more domains',
    growth: 'ABS ERP 2001-25 (DS0005) — 5y CAGR scenario to 2030',
  },
  note: 'future_band = scenario extending 5y population trend with today\'s LDC places (no supply response). Priority = desert/constrained access, high vulnerability (top-quartile AEDC), fast growth.',
}, null, 1));
log.info('wrote dashboard/equity.json', {
  priority: priority.rows.length, future_risk: future.rows.length,
  national: nat.rows[0] as Record<string, unknown>,
});
await log.close();
await pool.end();
console.log('EQUITY EXPORT DONE');
