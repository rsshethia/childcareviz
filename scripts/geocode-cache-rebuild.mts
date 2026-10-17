// Rebuild data/processed/geocode-cache.json from services.lat/lon.
// Protects against re-billing Mapbox if the cache file is lost: keys match scripts/geocode.mts exactly.
// Usage: npx tsx scripts/geocode-cache-rebuild.mts
import { writeFileSync, mkdirSync } from 'node:fs';
import { pool } from '../src/db/pool.js';

const r = await pool.query(`select address, suburb, state, postcode, lat, lon
  from services where lat is not null and lon is not null`);

const cache: Record<string, { lat: number; lon: number }> = {};
let skipped = 0;
for (const s of r.rows) {
  const key = [s.address, s.suburb, s.state, s.postcode, 'Australia'].filter(Boolean).join(', ');
  if (!key) { skipped++; continue; }
  cache[key] = { lat: Number(s.lat), lon: Number(s.lon) };
}
mkdirSync('data/processed', { recursive: true });
writeFileSync('data/processed/geocode-cache.json', JSON.stringify(cache));
console.log(`geocode-cache.json: ${Object.keys(cache).length} keys (${skipped} skipped), from ${r.rows.length} geocoded services`);
await pool.end();
