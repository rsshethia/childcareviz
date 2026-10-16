// Exports geocoded services + clean median fee for the dashboard map.
// Usage: npx tsx scripts/geo-export.mts (writes dashboard/geo.json)
import { writeFileSync, mkdirSync } from 'node:fs';
import { pool } from '../src/db/pool.js';

const r = await pool.query(`select s.service_approval_no as se, s.service_name as name,
  s.provider_type, s.suburb, s.state, s.overall_rating as rating, s.lat, s.lon,
  (select round(avg(fee)::numeric,2) from service_fees_history f
    where f.service_approval_no = s.service_approval_no
      and f.session_type = 'FULLDY' and f.quarantine is null) as fulldy_mean
  from services s where s.lat is not null`);
mkdirSync('dashboard', { recursive: true });
writeFileSync('dashboard/geo.json', JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  count: r.rows.length,
  points: r.rows.map((p) => ({
    se: p.se, n: p.name, t: p.provider_type, s: p.suburb, st: p.state,
    r: p.rating, la: Number(p.lat), lo: Number(p.lon), f: p.fulldy_mean ? Number(p.fulldy_mean) : null,
  })),
}));
console.log(`dashboard/geo.json: ${r.rows.length} points`);
await pool.end();
