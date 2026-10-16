//Fails loudly if any geocoded point falls outside Australia bbox.
import { pool } from '../src/db/pool.js';
const r = await pool.query(`select service_approval_no, suburb, state, lat, lon from services where lat is not null limit 10`);
for (const s of r.rows) console.log(s.service_approval_no, s.suburb, s.state, s.lat, s.lon);
const b = await pool.query(`select count(*) as n,
  count(*) filter (where lat between -44 and -10 and lon between 113 and 154) as in_au from services where lat is not null`);
console.log('bbox check:', JSON.stringify(b.rows[0]));
if (Number(b.rows[0].n) !== Number(b.rows[0].in_au)) { console.error('OUT-OF-BBOX POINTS EXIST'); process.exit(1); }
await pool.end();
