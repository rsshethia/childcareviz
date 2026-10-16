// Forward-geocode service addresses via Mapbox, cache results, write lat/lon to Neon.
// Usage: npx tsx scripts/geocode.mts [--limit N] [--offset N]
// Resumable: skips rows already geocoded + uses local cache (no re-billing).
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { pool } from '../src/db/pool.js';
import { createLogger, attachDbSink } from '../src/log.js';

const TOKEN = (process.env.MAPBOX || '').replace(/^['"]|['"]$/g, '');
if (!TOKEN) { console.error('Missing MAPBOX in .env'); process.exit(1); }

const args = process.argv.slice(2);
const li = args.indexOf('--limit');
const LIMIT = li >= 0 ? parseInt(args[li + 1], 10) : 0;
const oi = args.indexOf('--offset');
const OFFSET = oi >= 0 ? parseInt(args[oi + 1], 10) : 0;

mkdirSync('data/processed', { recursive: true });
const CACHE_FILE = 'data/processed/geocode-cache.json';
const cache: Record<string, { lat: number; lon: number }> = existsSync(CACHE_FILE)
  ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {};
let cacheDirty = false;

attachDbSink(pool);
const log = createLogger('geocode');

async function geocode(query: string): Promise<{ lat: number; lon: number } | null> {
  if (cache[query]) return cache[query];
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${TOKEN}&country=AU&limit=1`;
  const res = await fetch(url);
  if (res.status === 429) {
    log.warn('rate limited, backing off 10s', { query });
    await new Promise((r) => setTimeout(r, 10000));
    return geocode(query);
  }
  if (!res.ok) throw new Error(`mapbox ${res.status} ${query}`);
  const j: any = await res.json();
  const f = j.features?.[0];
  if (!f) return null;
  const r = { lon: f.center[0], lat: f.center[1] };
  cache[query] = r;
  cacheDirty = true;
  return r;
}

const base = `select service_approval_no, address, suburb, state, postcode from services
  where lat is null order by service_approval_no`;
const rows = (await pool.query(LIMIT > 0 ? `${base} limit $1 offset $2` : base, LIMIT > 0 ? [LIMIT, OFFSET] : [])).rows;
log.info('geocode batch started', { n: rows.length, offset: OFFSET });

let ok = 0, miss = 0, done = 0;
for (const s of rows) {
  const q = [s.address, s.suburb, s.state, s.postcode, 'Australia'].filter(Boolean).join(', ');
  if (cache[q]) {
    // Warm cache: DB write only, no delay, no re-billing.
    const g = cache[q];
    await pool.query(`update services set lat=$2, lon=$3, geocode_source='mapbox-cache' where service_approval_no=$1`,
      [s.service_approval_no, g.lat, g.lon]);
    ok++;
  } else {
    try {
      const g = await geocode(q);
      if (g) {
        await pool.query(`update services set lat=$2, lon=$3, geocode_source='mapbox' where service_approval_no=$1`,
          [s.service_approval_no, g.lat, g.lon]);
        ok++;
      } else {
        miss++;
        log.warn('no result', { se: s.service_approval_no, q });
      }
    } catch (e) {
      miss++;
      log.warn('geocode failed', { se: s.service_approval_no, error: (e as Error).message });
    }
    await new Promise((r) => setTimeout(r, 220)); // rate-limit live calls only
  }
  done++;
  if (done % 500 === 0) log.info('progress', { done, total: rows.length, ok, miss });
}
if (cacheDirty) writeFileSync(CACHE_FILE, JSON.stringify(cache));
log.info('geocode batch finished', { done, ok, miss, cacheSize: Object.keys(cache).length });
await log.close();
await pool.end();
