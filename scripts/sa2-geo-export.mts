// Export simplified SA2 boundaries for the dashboard choropleth -> dashboard/sa2-geo.json
// Shapes only (metrics live in dashboard/sa2.json, joined client-side by code).
// Usage: npx tsx scripts/sa2-geo-export.mts [toleranceDeg=0.01] [precision=3]
import { writeFileSync, mkdirSync } from 'node:fs';
import { pool } from '../src/db/pool.js';

const tolerance = Number(process.argv[2] ?? 0.01);
const precision = Number(process.argv[3] ?? 3);

const r = await pool.query(
  `select sa2_code, sa2_name, state,
     ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, $1), $2) as gj
   from sa2_boundary`,
  [tolerance, precision]
);

const features = r.rows.map((f) => ({
  type: 'Feature' as const,
  properties: { code: f.sa2_code, name: f.sa2_name, state: f.state },
  geometry: JSON.parse(f.gj),
}));

mkdirSync('dashboard', { recursive: true });
const out = { generated: new Date().toISOString().slice(0, 10), tolerance, precision, count: features.length, features };
writeFileSync('dashboard/sa2-geo.json', JSON.stringify(out));
const bytes = JSON.stringify(out).length;
console.log(`dashboard/sa2-geo.json: ${features.length} features, ${(bytes / 1024 / 1024).toFixed(2)} MB (tolerance=${tolerance}, precision=${precision})`);
await pool.end();
