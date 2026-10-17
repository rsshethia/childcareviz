// Fails loudly if any geocoded point falls outside Australia bbox.
// Bbox covers mainland + Tasmania + Torres Strait (to -9) + external territories
// (Christmas ~105.6, Cocos ~96.8, Norfolk ~167.9, Lord Howe ~159.1) — an earlier
// mainland box first tripped on Tagai island kindergartens (Mabuiag/Mer, lat -9.9)
// and then on Lord Howe Island Community Preschool (lon 159.1).
import { pool } from '../src/db/pool.js';
const r = await pool.query(`select service_approval_no, suburb, state, lat, lon from services where lat is not null limit 10`);
for (const s of r.rows) console.log(s.service_approval_no, s.suburb, s.state, s.lat, s.lon);
const b = await pool.query(`select count(*) as n,
  count(*) filter (where lat between -46 and -9 and lon between 96 and 168) as in_au from services where lat is not null`);
console.log('bbox check:', JSON.stringify(b.rows[0]));
if (Number(b.rows[0].n) !== Number(b.rows[0].in_au)) { console.error('OUT-OF-BBOX POINTS EXIST'); process.exit(1); }
await pool.end();
