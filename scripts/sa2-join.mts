// Spatial join: services (lat/lon) -> SA2 via point-in-polygon, then desert metrics.
// Writes service_sa2 + sa2_supply in Neon and dashboard/sa2.json.
// Usage: npx tsx scripts/sa2-join.mts
import * as shapefile from 'shapefile';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pool } from '../src/db/pool.js';
import { createLogger, attachDbSink } from '../src/log.js';

attachDbSink(pool);
const log = createLogger('sa2-join');

interface Poly { code: string; name: string; state: string; rings: number[][][]; bbox: number[] }
function ringBbox(r: number[][]): number[] {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const [x, y] of r) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}
function inRing(x: number, y: number, r: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

log.info('reading SA2 polygons');
const src = await shapefile.open('data/abs/sa2_shp/SA2_2021_AUST_GDA2020.shp', 'data/abs/sa2_shp/SA2_2021_AUST_GDA2020.dbf');
const polys: Poly[] = [];
let rec = await src.read();
let skippedNull = 0;
while (!rec.done) {
  const g = rec.value.geometry, p = rec.value.properties;
  if (!g) { skippedNull++; rec = await src.read(); continue; }
  const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((pp: number[][][]) => pp[0]);
  const bbs = rings.map(ringBbox);
  polys.push({
    code: p.SA2_CODE21, name: p.SA2_NAME21, state: p.STE_NAME21, rings,
    bbox: [Math.min(...bbs.map((b) => b[0])), Math.min(...bbs.map((b) => b[1])), Math.max(...bbs.map((b) => b[2])), Math.max(...bbs.map((b) => b[3]))],
  });
  rec = await src.read();
}
log.info('polygons loaded', { n: polys.length, skippedNull });

const svc = (await pool.query(`select service_approval_no as se, approved_places as places, provider_type as t, lat, lon
  from services where lat is not null`)).rows;
log.info('geocoded services', { n: svc.length });

await pool.query(`create table if not exists service_sa2 (
  service_approval_no text primary key references services(service_approval_no),
  sa2_code text, method text default 'point-in-polygon', created_at timestamptz default now())`);

let assigned = 0, missed = 0;
const supply: Record<string, { places: number; n: number; byType: Record<string, number> }> = {};
const assignments: [string, string][] = [];
for (const s of svc) {
  const x = Number(s.lon), y = Number(s.lat);
  let hit: Poly | null = null;
  for (const p of polys) {
    const b = p.bbox;
    if (x < b[0] || y < b[1] || x > b[2] || y > b[3]) continue;
    if (p.rings.some((r) => inRing(x, y, r))) { hit = p; break; }
  }
  if (!hit) { missed++; continue; }
  assignments.push([s.se, hit.code]);
  assigned++;
  const a = supply[hit.code] = supply[hit.code] || { places: 0, n: 0, byType: {} };
  a.places += Number(s.places) || 0;
  a.n++;
  a.byType[s.t || 'unknown'] = (a.byType[s.t || 'unknown'] || 0) + 1;
  if (assigned % 2000 === 0) log.info('join progress', { assigned, missed });
}
log.info('join computed, bulk inserting', { assigned, missed });
for (let i = 0; i < assignments.length; i += 500) {
  const b = assignments.slice(i, i + 500);
  const vals: unknown[] = [];
  const ph = b.map(([se, code], j) => { vals.push(se, code); return `($${j * 2 + 1},$${j * 2 + 2})`; });
  await pool.query(`insert into service_sa2 (service_approval_no, sa2_code) values ${ph.join(',')}
    on conflict (service_approval_no) do update set sa2_code=excluded.sa2_code`, vals);
}
log.info('join done', { assigned, missed });

// Desert metrics: LDC places per 100 kids 0-4. Thresholds provisional:
// desert <30, constrained 30-60, adequate 60+ (national mean 82).
await pool.query(`create table if not exists sa2_supply (
  sa2_code text primary key, services_n int, ldc_places int, pop_0_4 int,
  places_per_100 double precision, band text)`);
const supEntries = Object.entries(supply);
for (let i = 0; i < supEntries.length; i += 500) {
  const b = supEntries.slice(i, i + 500);
  const vals: unknown[] = [];
  const ph = b.map(([code, a], j) => { vals.push(code, a.n, a.places); return `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`; });
  await pool.query(`insert into sa2_supply (sa2_code, services_n, ldc_places)
    values ${ph.join(',')} on conflict (sa2_code) do update set services_n=excluded.services_n, ldc_places=excluded.ldc_places`, vals);
}
await pool.query(`update sa2_supply s set pop_0_4 = d.pop_0_4 from sa2_demand d where d.sa2_code = s.sa2_code`);
await pool.query(`update sa2_supply set places_per_100 = case when pop_0_4 > 0 then 100.0*ldc_places/pop_0_4 end,
  band = case when pop_0_4 is null or pop_0_4 = 0 then 'no-demand-data'
    when 100.0*ldc_places/pop_0_4 < 30 then 'desert'
    when 100.0*ldc_places/pop_0_4 < 60 then 'constrained' else 'adequate' end`);

const v = await pool.query(`select band, count(*) as sa2, sum(pop_0_4) as kids from sa2_supply group by 1 order by 2 desc`);
log.info('bands', v.rows as Record<string, unknown>[]);
const deserts = await pool.query(`select s.sa2_code, d.sa2_name, d.state, s.services_n, s.ldc_places, d.pop_0_4,
  round(s.places_per_100::numeric,1) as pp100 from sa2_supply s join sa2_demand d on d.sa2_code=s.sa2_code
  where s.band='desert' and d.pop_0_4 >= 100 order by s.places_per_100 asc limit 25`);
mkdirSync('dashboard', { recursive: true });
writeFileSync('dashboard/sa2.json', JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  bands: v.rows, top_deserts: deserts.rows,
  note: 'Provisional bands: desert <30, constrained 30-60, adequate 60+ LDC places per 100 kids 0-4. Excludes SA2s with <100 kids.',
}, null, 1));
await log.close();
await pool.end();
console.log('SA2 JOIN DONE', JSON.stringify({ assigned, missed }));
