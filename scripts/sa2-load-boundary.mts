// Load SA2 2021 polygons (GDA2020 shapefile) into PostGIS as sa2_boundary,
// then derive sa2_points (ST_PointOnSurface) for 2SFCA / isochrone work.
// GDA2020 ~ WGS84 to ~1.8m — stored as SRID 4326 (fine for this use).
// Usage: npx tsx scripts/sa2-load-boundary.mts
import * as shapefile from 'shapefile';
import { pool } from '../src/db/pool.js';
import { createLogger, attachDbSink } from '../src/log.js';

attachDbSink(pool);
const log = createLogger('sa2-boundary');

await pool.query(`create table if not exists sa2_boundary (
  sa2_code text primary key, sa2_name text, state text,
  geom geometry(MultiPolygon, 4326), loaded_at timestamptz default now())`);

const src = await shapefile.open(
  'data/abs/sa2_shp/SA2_2021_AUST_GDA2020.shp',
  'data/abs/sa2_shp/SA2_2021_AUST_GDA2020.dbf'
);

let batch: Array<{ code: string; name: string; state: string; gj: string }> = [];
let loaded = 0, skipped = 0;

async function flush() {
  if (!batch.length) return;
  const vals: unknown[] = [];
  const ph = batch.map((r, i) => {
    const o = i * 4;
    vals.push(r.code, r.name, r.state, r.gj);
    return `($${o + 1},$${o + 2},$${o + 3}, ST_Multi(ST_GeomFromGeoJSON($${o + 4})))`;
  });
  await pool.query(
    `insert into sa2_boundary (sa2_code, sa2_name, state, geom) values ${ph.join(',')}
     on conflict (sa2_code) do update set sa2_name=excluded.sa2_name, state=excluded.state, geom=excluded.geom, loaded_at=now()`,
    vals
  );
  loaded += batch.length;
  batch = [];
  if (loaded % 1000 === 0) log.info('boundary progress', { loaded });
}

let rec = await src.read();
while (!rec.done) {
  const g = rec.value.geometry;
  const p = rec.value.properties;
  const code = String(p.SA2_CODE21 ?? '').trim();
  if (!code || !g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) { skipped++; rec = await src.read(); continue; }
  batch.push({
    code,
    name: String(p.SA2_NAME21 ?? '').trim(),
    state: String(p.STE_NAME21 ?? '').trim(),
    gj: JSON.stringify({ type: g.type, coordinates: g.coordinates }),
  });
  if (batch.length >= 100) await flush();
  rec = await src.read();
}
await flush();
log.info('boundary loaded', { loaded, skipped });

// Representative point per SA2 (guaranteed inside the polygon, unlike a naive centroid).
await pool.query(`create table if not exists sa2_points (
  sa2_code text primary key, sa2_name text, state text,
  lat double precision, lon double precision, derived_at timestamptz default now())`);
await pool.query(`truncate sa2_points`);
const ins = await pool.query(`insert into sa2_points (sa2_code, sa2_name, state, lat, lon)
  select sa2_code, sa2_name, state, ST_Y(pt), ST_X(pt) from (
    select sa2_code, sa2_name, state, ST_PointOnSurface(geom) as pt from sa2_boundary
  ) t`);
log.info('points derived', { n: ins.rowCount });

const v = await pool.query(`select
  (select count(*) from sa2_boundary) as boundary,
  (select count(*) from sa2_points) as points,
  (select count(*) from sa2_points p join sa2_demand d on d.sa2_code = p.sa2_code) as joined_demand`);
log.info('verify', v.rows[0] as Record<string, unknown>);
await log.close();
await pool.end();
console.log('SA2 BOUNDARY DONE', JSON.stringify(v.rows[0]));
