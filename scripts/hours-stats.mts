// B6: hours-coverage analytics ("6pm cliff") -> dashboard/hours.json
// Approved hours per ACECQA (annual / school terms / holiday care) + derived weekday close times.
// Caveat: approved hours, not verified walk-in reality. Usage: npx tsx scripts/hours-stats.mts
import { writeFileSync, mkdirSync } from 'node:fs';
import { pool } from '../src/db/pool.js';
import { createLogger, attachDbSink } from '../src/log.js';

attachDbSink(pool);
const log = createLogger('hours-stats');

const fmtMin = (m: number | null | undefined) => (m === null || m === undefined ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// 1) Coverage + closing-time distribution (all services with a known weekday close).
const cov = await pool.query(`select count(*) as services_total,
  count(*) filter (where hours is not null) as with_hours,
  count(*) filter (where weekday_close_min is not null) as close_known,
  count(*) filter (where temporarily_closed) as temporarily_closed from services`);

const buckets = await pool.query(`select
  case
    when weekday_close_min < 960 then 'before 16:00'
    when weekday_close_min < 1020 then '16:00-16:59'
    when weekday_close_min < 1080 then '17:00-17:59'
    when weekday_close_min < 1110 then '18:00-18:29'
    else '18:30+' end as bucket,
  count(*) as n,
  min(weekday_close_min) as lo
  from services where weekday_close_min is not null group by 1 order by lo`);
const closeKnown = Number(cov.rows[0].close_known);
const closeDistribution = buckets.rows.map((r) => ({
  bucket: r.bucket, n: Number(r.n),
  pct: closeKnown ? Math.round((1000 * Number(r.n)) / closeKnown) / 10 : null,
}));
const before18 = await pool.query(`select count(*) as n from services where weekday_close_min is not null and weekday_close_min < 1080`);

// 2) Close/open by provider type (all services) and by state (LDC only — parent-facing comparison).
const byType = await pool.query(`select coalesce(provider_type,'unknown') as provider_type,
  count(*) filter (where weekday_close_min is not null) as n_known,
  round(100.0 * count(*) filter (where weekday_close_min is not null and weekday_close_min < 1080)
    / nullif(count(*) filter (where weekday_close_min is not null), 0), 1) as pct_before_18,
  round(percentile_cont(0.5) within group (order by weekday_close_min)::numeric, 0) as median_close_min,
  round(percentile_cont(0.5) within group (order by weekday_open_min)::numeric, 0) as median_open_min
  from services where weekday_close_min is not null group by 1 order by n_known desc`);

const byStateLdc = await pool.query(`select state,
  count(*) as n,
  round(100.0 * count(*) filter (where weekday_close_min < 1080) / count(*), 1) as pct_before_18,
  round(percentile_cont(0.5) within group (order by weekday_close_min)::numeric, 0) as median_close_min
  from services where is_ldc and weekday_close_min is not null group by 1 order by 1`);

// 3) Days open + weekend coverage (any Sat/Sun hours in annual schedule).
const days = await pool.query(`select days_open, count(*) as n from services where days_open is not null group by 1 order by 1`);
const weekend = await pool.query(`select count(*) as n from services
  where hours->'annual' ?| array['sat','sun']`);

// 4) Vacation care (holiday-care schedule) by OSHC vs not.
const vac = await pool.query(`select
  count(*) filter (where is_oshc) as oshc_total,
  count(*) filter (where is_oshc and hours ? 'holiday_care') as oshc_with_holiday,
  count(*) filter (where not coalesce(is_oshc,false) and hours ? 'holiday_care') as other_with_holiday
  from services`);

// 5) Late-care premium: LDC clean FULLDY median fee, closes before vs at/after 18:00 (latest clean fee per service).
const lateFee = await pool.query(`with latest as (
    select distinct on (service_approval_no) service_approval_no, fee
    from service_fees_history where session_type='FULLDY' and quarantine is null
    order by service_approval_no, fetched_at desc)
  select
    (weekday_close_min < 1080) as closes_before_18,
    count(*) as n,
    round(percentile_cont(0.5) within group (order by fee)::numeric, 2) as median_fee
  from services s join latest l on l.service_approval_no = s.service_approval_no
  where s.is_ldc and s.weekday_close_min is not null group by 1 order by 1`);

mkdirSync('dashboard', { recursive: true });
const out = {
  generated: new Date().toISOString().slice(0, 10),
  coverage: {
    services_total: Number(cov.rows[0].services_total),
    with_hours: Number(cov.rows[0].with_hours),
    close_known: closeKnown,
    temporarily_closed: Number(cov.rows[0].temporarily_closed),
    pct_close_known: Math.round((1000 * closeKnown) / Number(cov.rows[0].services_total)) / 10,
  },
  six_pm_cliff: {
    closes_before_18: Number(before18.rows[0].n),
    pct_closes_before_18: closeKnown ? Math.round((1000 * Number(before18.rows[0].n)) / closeKnown) / 10 : null,
  },
  close_distribution: closeDistribution,
  close_by_provider_type: byType.rows.map((r) => ({
    provider_type: r.provider_type, n_known: Number(r.n_known), pct_before_18: r.pct_before_18 === null ? null : Number(r.pct_before_18),
    median_close: fmtMin(num(r.median_close_min)), median_open: fmtMin(num(r.median_open_min)),
  })),
  close_by_state_ldc: byStateLdc.rows.map((r) => ({
    state: r.state, n: Number(r.n), pct_before_18: Number(r.pct_before_18), median_close: fmtMin(num(r.median_close_min)),
  })),
  days_open: {
    dist: days.rows.map((r) => ({ days: Number(r.days_open), n: Number(r.n) })),
    weekend_any: Number(weekend.rows[0].n),
  },
  vacation_care: {
    oshc_total: Number(vac.rows[0].oshc_total),
    oshc_with_holiday: Number(vac.rows[0].oshc_with_holiday),
    other_with_holiday: Number(vac.rows[0].other_with_holiday),
  },
  late_fee_ldc: lateFee.rows.map((r) => ({
    closes_before_18: r.closes_before_18 === true, n: Number(r.n),
    median_fulldy_fee: r.median_fee === null ? null : Number(r.median_fee),
  })),
  note: 'Approved hours per ACECQA register (not verified operating hours). Weekday close = latest Mon-Fri end time. "Before 18:00" = closes at or before 17:59.',
};
writeFileSync('dashboard/hours.json', JSON.stringify(out, null, 1));
log.info('wrote dashboard/hours.json', {
  close_known: closeKnown,
  pct_before_18: out.six_pm_cliff.pct_closes_before_18,
  weekend_any: out.days_open.weekend_any,
});
log.info('close_by_state_ldc', { rows: out.close_by_state_ldc });
log.info('late_fee_ldc', { rows: out.late_fee_ldc });
await log.close();
await pool.end();
console.log('HOURS STATS DONE');
