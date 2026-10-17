// Fixes representative points that cannot reach any LDC service (v1 proxy radius R30).
// ST_PointOnSurface picks the largest sub-polygon — e.g. Fremantle's point lands on
// Rottnest Island (22 km offshore), rural surrounds land in farmland (Griffith
// Surrounds 48 km from care), remote town SA2s land in the bush (Kununurra 164 km).
// Fallback: replace with the in-SA2 point closest to the nearest LDC service — the
// location within the SA2 with maximal plausible drive-time access (conservative in
// the "no desert unless nothing is reachable" direction). Idempotent: only acts while
// the current point has no LDC within the R30 proxy; clears the isochrone cache for
// changed SA2s so the batch re-fetches contours from the fixed point.
// Usage: npx tsx scripts/sa2-fallback-points.mts  (after sa2:boundary, before isochrones)
import { rmSync } from 'node:fs';
import { pool } from '../src/db/pool.js';
import { createLogger, attachDbSink } from '../src/log.js';

attachDbSink(pool);
const log = createLogger('sa2-fallback-points');

const R30 = 14815; // same crow-flies proxy as sa2-access.mts (30 min @ 40 km/h, circuity 1.35)

const upd = await pool.query(`
  with bad as (
    select p.sa2_code
    from sa2_points p
    where not exists (
      select 1 from services s
      where s.is_ldc and s.lat is not null and s.approved_places > 0
        and ST_DWithin(
          ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)::geography,
          ST_SetSRID(ST_MakePoint(s.lon, s.lat), 4326)::geography,
          ${R30})
    )
  ), fixed as (
    select b.sa2_code,
      case when ST_Contains(pb.geom, svc.g) then svc.g else ST_ClosestPoint(pb.geom, svc.g) end as pt
    from bad b
    join sa2_boundary pb on pb.sa2_code = b.sa2_code
    join lateral (
      select ST_SetSRID(ST_MakePoint(s.lon, s.lat), 4326) as g
      from services s
      where s.is_ldc and s.lat is not null and s.approved_places > 0
      order by pb.geom <-> ST_SetSRID(ST_MakePoint(s.lon, s.lat), 4326)
      limit 1
    ) svc on true
  )
  update sa2_points p
  set lon = ST_X(f.pt), lat = ST_Y(f.pt), derived_at = now()
  from fixed f
  where f.sa2_code = p.sa2_code and (p.lon is distinct from ST_X(f.pt) or p.lat is distinct from ST_Y(f.pt))
  returning p.sa2_code`);

const codes = upd.rows.map((r) => r.sa2_code as string);
log.info('fallback points applied', { n: codes.length });

if (codes.length) {
  const del = await pool.query(`delete from isochrone_cache where sa2_code = any($1) returning sa2_code`, [codes]);
  log.info('isochrone cache cleared', { n: del.rowCount });
  for (const c of codes) {
    try { rmSync(`data/processed/isochrones/${c}.json`, { force: true }); } catch { /* disk mirror only */ }
  }
}

const remaining = await pool.query(`select count(*) as still_bad from sa2_points p
  where not exists (
    select 1 from isochrone_cache c where c.sa2_code = p.sa2_code)`);
log.info('points pending isochrone refetch', remaining.rows[0] as Record<string, unknown>);

await log.close();
await pool.end();
console.log('FALLBACK POINTS DONE', JSON.stringify({ fixed: codes.length, pendingIso: Number(remaining.rows[0].still_bad) }));
