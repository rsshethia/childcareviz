// Backfill services extras from ACECQA CSV: service flavour flags (LDC/preschool/OSHC/FDC),
// temporarily closed, granted date, approved hours (annual / school terms / holiday care)
// plus derived fields (days_open, weekday open/close minutes) for the hours-coverage analytics.
// Idempotent: re-runnable. Usage: npx tsx scripts/db-backfill-services-extras.mts
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { pool } from '../src/db/pool.js';
import { createLogger, attachDbSink } from '../src/log.js';

attachDbSink(pool);
const log = createLogger('backfill-extras');

const yes = (v: unknown) => String(v ?? '').trim().toLowerCase() === 'yes';

// "7.45", "6.:00", "6:30" -> minutes since midnight, null if implausible/unparseable.
function toMin(v: unknown): number | null {
  let s = String(v ?? '').trim();
  if (!s) return null;
  s = s.replace(/\./g, ':').replace(/:{2,}/g, ':').replace(/^:/, '');
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
const fmt = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const DAYS: Array<[string, string]> = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
  ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
];

// Header names carry typos ("Session1 Wednesday", "Session2 Thursday"). Normalise both sides.
const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
function buildNormIndex(r: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(r)) m.set(normKey(k), v);
  return m;
}
function readSchedule(idx: Map<string, string>, prefix: string): Record<string, { s: string; e: string }> {
  const out: Record<string, { s: string; e: string }> = {};
  for (const [key, day] of DAYS) {
    const s = toMin(idx.get(normKey(`${prefix} ${day} Start Time`)) ?? '');
    const e = toMin(idx.get(normKey(`${prefix} ${day} End Time`)) ?? '');
    if (s !== null || e !== null) {
      const rec: { s: string; e: string } = { s: '', e: '' };
      if (s !== null) rec.s = fmt(s);
      if (e !== null) rec.e = fmt(e);
      out[key] = rec;
    }
  }
  return out;
}

function parseGranted(v: unknown): string | null {
  const m = String(v ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2027) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCDate() !== d || dt.getUTCMonth() !== mo - 1) return null;
  return dt.toISOString().slice(0, 10);
}

interface UpdRow {
  se: string;
  is_ldc: boolean; is_preschool: boolean; is_oshc: boolean; is_fdc: boolean; is_other: boolean;
  temporarily_closed: boolean; granted_date: string | null;
  hours: string | null; days_open: number | null; weekday_open_min: number | null; weekday_close_min: number | null;
}

log.info('reading ACECQA services CSV');
const rows: Array<Record<string, string>> = parse(readFileSync('Education-services-au-export.csv', 'utf8'), {
  columns: true, relax_quotes: true, skip_empty_lines: true, relax_column_count: true,
});
log.info('csv parsed', { n: rows.length });

const upd: UpdRow[] = [];
let hoursFilled = 0, closeAfter18 = 0, closedFlags = 0;
for (const r of rows) {
  const se = (r['ServiceApprovalNumber'] || '').trim();
  if (!se) continue;
  const idx = buildNormIndex(r);
  const schedule: Record<string, unknown> = {};
  const annual = readSchedule(idx, 'Annual');
  const terms1 = readSchedule(idx, 'School Terms Only Session 1');
  const terms2 = readSchedule(idx, 'School Terms Only Session 2');
  const holiday = readSchedule(idx, 'Holiday Care');
  if (Object.keys(annual).length) schedule.annual = annual;
  if (Object.keys(terms1).length) schedule.school_terms_1 = terms1;
  if (Object.keys(terms2).length) schedule.school_terms_2 = terms2;
  if (Object.keys(holiday).length) schedule.holiday_care = holiday;

  let daysOpen: number | null = null;
  let openMin: number | null = null;
  let closeMin: number | null = null;
  if (Object.keys(annual).length) {
    daysOpen = Object.keys(annual).length;
    for (const [k] of DAYS) {
      const d = annual[k];
      const s = d?.s ? toMin(d.s) : null;
      const e = d?.e ? toMin(d.e) : null;
      if (k !== 'sat' && k !== 'sun') {
        if (s !== null && s >= 240 && (openMin === null || s < openMin)) openMin = s;
        if (e !== null && e >= 300) closeMin = Math.max(closeMin ?? 0, e);
      }
    }
  }

  const rec: UpdRow = {
    se,
    is_ldc: yes(r['Long Day Care']),
    is_preschool: yes(r['Preschool/Kindergarten - Part of a School']) || yes(r['Preschool/Kindergarten - Stand alone']),
    is_oshc: yes(r['Outside school Hours Care - After School']) || yes(r['Outside school Hours Care - Before School']) || yes(r['Outside school Hours Care - Vacation Care']),
    is_fdc: String(r['ServiceType'] || '').trim() === 'Family Day Care',
    is_other: yes(r['Other']),
    temporarily_closed: yes(r['Temporarily Closed']),
    granted_date: parseGranted(r['ServiceApprovalGrantedDate']),
    hours: Object.keys(schedule).length ? JSON.stringify(schedule) : null,
    days_open: daysOpen,
    weekday_open_min: openMin,
    weekday_close_min: closeMin,
  };
  if (rec.hours) hoursFilled++;
  if (rec.weekday_close_min !== null && rec.weekday_close_min >= 18 * 60) closeAfter18++;
  if (rec.temporarily_closed) closedFlags++;
  upd.push(rec);
}
log.info('rows prepared', { upd: upd.length, hoursFilled, closeAfter18, closedFlags });

let updated = 0;
for (let i = 0; i < upd.length; i += 800) {
  const b = upd.slice(i, i + 800);
  const cols = {
    se: b.map((r) => r.se),
    is_ldc: b.map((r) => r.is_ldc),
    is_preschool: b.map((r) => r.is_preschool),
    is_oshc: b.map((r) => r.is_oshc),
    is_fdc: b.map((r) => r.is_fdc),
    is_other: b.map((r) => r.is_other),
    temporarily_closed: b.map((r) => r.temporarily_closed),
    granted_date: b.map((r) => r.granted_date),
    hours: b.map((r) => r.hours ?? ''),
    days_open: b.map((r) => r.days_open),
    weekday_open_min: b.map((r) => r.weekday_open_min),
    weekday_close_min: b.map((r) => r.weekday_close_min),
  };
  const res = await pool.query(
    `update services s set
       is_ldc = u.is_ldc, is_preschool = u.is_preschool, is_oshc = u.is_oshc, is_fdc = u.is_fdc, is_other = u.is_other,
       temporarily_closed = u.temporarily_closed, granted_date = u.granted_date,
       hours = nullif(u.hours, '')::jsonb, days_open = u.days_open,
       weekday_open_min = u.weekday_open_min, weekday_close_min = u.weekday_close_min
     from unnest(
       $1::text[], $2::bool[], $3::bool[], $4::bool[], $5::bool[], $6::bool[],
       $7::bool[], $8::date[], $9::text[], $10::int[], $11::int[], $12::int[]
     ) as u(se, is_ldc, is_preschool, is_oshc, is_fdc, is_other, temporarily_closed, granted_date, hours, days_open, weekday_open_min, weekday_close_min)
     where s.service_approval_no = u.se`,
    [cols.se, cols.is_ldc, cols.is_preschool, cols.is_oshc, cols.is_fdc, cols.is_other, cols.temporarily_closed, cols.granted_date, cols.hours, cols.days_open, cols.weekday_open_min, cols.weekday_close_min]
  );
  updated += res.rowCount ?? 0;
}
log.info('backfill update done', { updated });

const v = await pool.query(`select
  count(*) filter (where is_ldc) as ldc,
  count(*) filter (where is_preschool) as preschool,
  count(*) filter (where is_oshc) as oshc,
  count(*) filter (where is_fdc) as fdc,
  count(*) filter (where hours is not null) as with_hours,
  count(*) filter (where temporarily_closed) as closed,
  count(*) filter (where weekday_close_min >= 1080) as close_18plus,
  count(*) filter (where weekday_close_min is not null) as close_known
  from services`);
log.info('verify', v.rows[0] as Record<string, unknown>);
const spot = await pool.query(`select service_approval_no, is_ldc, days_open, weekday_open_min, weekday_close_min,
  hours->'annual'->'mon' as mon from services where service_approval_no in ('SE-00009804','SE-00009807') order by 1`);
log.info('spot check', { rows: spot.rows });
await log.close();
await pool.end();
console.log('BACKFILL EXTRAS DONE', JSON.stringify(v.rows[0]));
