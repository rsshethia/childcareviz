// Export simplified SA2 boundaries for the dashboard choropleth -> dashboard/sa2-geo.json
// Shapes only (metrics live in dashboard/sa2.json, joined client-side by code).
// Output must be a valid GeoJSON FeatureCollection with right-hand-rule rings,
// or Mapbox GL silently drops the source and the choropleth renders nothing.
// Usage: npx tsx scripts/sa2-geo-export.mts [toleranceDeg=0.01] [precision=3]
import { writeFileSync, mkdirSync } from 'node:fs';
import { pool } from '../src/db/pool.js';

const tolerance = Number(process.argv[2] ?? 0.01);
const precision = Number(process.argv[3] ?? 3);

// ST_ForcePolygonCCW: GeoJSON needs right-hand-rule rings (outer CCW). ABS
// shapefiles carry CW outer rings and Mapbox GL renders CW outers as holes —
// the whole choropleth turns invisible. Forced here at export.
// The CASE guards small features: built-up SA2s under ~1 km² would otherwise
// be simplified to invisible slivers, so they keep their full geometry.
const r = await pool.query(
  `select sa2_code, sa2_name, state,
     ST_AsGeoJSON(
       ST_ForcePolygonCCW(
         case when ST_Area(ST_SimplifyPreserveTopology(geom, $1)) > 0.0001
              then ST_SimplifyPreserveTopology(geom, $1) else geom end
       ), $2) as gj
   from sa2_boundary`,
  [tolerance, precision]
);

const features = r.rows.map((f) => ({
  type: 'Feature' as const,
  properties: { code: f.sa2_code, name: f.sa2_name, state: f.state },
  geometry: JSON.parse(f.gj),
}));

mkdirSync('dashboard', { recursive: true });
const out = { type: 'FeatureCollection' as const, generated: new Date().toISOString().slice(0, 10), tolerance, precision, count: features.length, features };
writeFileSync('dashboard/sa2-geo.json', JSON.stringify(out));
const bytes = JSON.stringify(out).length;
console.log(`dashboard/sa2-geo.json: ${features.length} features, ${(bytes / 1024 / 1024).toFixed(2)} MB (tolerance=${tolerance}, precision=${precision})`);
await pool.end();
