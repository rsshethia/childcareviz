// B2: batch Mapbox isochrones for SA2 representative points (15/30-min driving), cached to Neon + disk.
// Resumable (skips cached SA2s). Polite: 3 workers, ~300ms jitter, retry/backoff on 429/5xx.
// Usage: npx tsx scripts/isochrone-batch.mts [--limit N] [--workers W]
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import pLimit from 'p-limit';
import { pool } from '../src/db/pool.js';
import { createLogger, attachDbSink } from '../src/log.js';

const TOKEN = (process.env.MAPBOX || '').replace(/^['"]|['"]$/g, '');
if (!TOKEN) { console.error('Missing MAPBOX in .env'); process.exit(1); }

const args = process.argv.slice(2);
const li = args.indexOf('--limit');
const LIMIT = li >= 0 ? parseInt(args[li + 1], 10) : 0;
const wi = args.indexOf('--workers');
const WORKERS = wi >= 0 ? Math.max(1, parseInt(args[wi + 1], 10)) : 3;

attachDbSink(pool);
const log = createLogger('isochrone-batch');

await pool.query(`create table if not exists isochrone_cache (
  sa2_code text primary key, lon double precision, lat double precision,
  contours text default '15,30', geojson jsonb,
  source text default 'mapbox-isochrone', generated_at timestamptz default now())`);

const pendingQ = `select p.sa2_code, p.lon, p.lat from sa2_points p
  where not exists (select 1 from isochrone_cache c where c.sa2_code = p.sa2_code)
  order by p.sa2_code ${LIMIT > 0 ? 'limit ' + LIMIT : ''}`;
const pending = (await pool.query(pendingQ)).rows as Array<{ sa2_code: string; lon: number; lat: number }>;
log.info('isochrone batch starting', { pending: pending.length, workers: WORKERS, limit: LIMIT });

mkdirSync('data/processed/isochrones', { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ok = 0, miss = 0;

async function fetchIso(code: string, lon: number, lat: number): Promise<void> {
  const url = `https://api.mapbox.com/isochrone/v1/mapbox/driving/${lon},${lat}?contours_minutes=15,30&polygons=true&access_token=${TOKEN}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) {
        log.warn('retrying', { code, status: res.status, attempt });
        await sleep(5000 * attempt);
        continue;
      }
      if (!res.ok) throw new Error(`mapbox ${res.status}`);
      const j: any = await res.json();
      if (!j?.features?.length) throw new Error('no features');
      await pool.query(`insert into isochrone_cache (sa2_code, lon, lat, geojson)
        values ($1,$2,$3,$4::jsonb) on conflict (sa2_code) do update set geojson=excluded.geojson, generated_at=now()`,
        [code, lon, lat, JSON.stringify(j)]);
      writeFileSync(`data/processed/isochrones/${code}.json`, JSON.stringify(j));
      ok++;
      return;
    } catch (e) {
      if (attempt === 3) {
        miss++;
        log.warn('isochrone failed', { code, error: (e as Error).message });
      } else {
        await sleep(2000 * attempt);
      }
    }
  }
}

const limit = pLimit(WORKERS);
let done = 0;
await Promise.all(pending.map((p) => limit(async () => {
  await fetchIso(p.sa2_code, Number(p.lon), Number(p.lat));
  done++;
  if (done % 100 === 0) log.info('progress', { done, total: pending.length, ok, miss });
  await sleep(250 + Math.random() * 150);
})));

const v = await pool.query(`select count(*) as cached from isochrone_cache`);
log.info('batch done', { ok, miss, cached: v.rows[0].cached });
await log.close();
await pool.end();
console.log('ISOCHRONE BATCH DONE', JSON.stringify({ ok, miss, cached: Number(v.rows[0].cached) }));
