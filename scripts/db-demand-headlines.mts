import { pool } from '../src/db/pool.js';
const nat = await pool.query(`select sum(approved_places) filter (where service_type='Centre-Based Care') as ldc_places,
  sum(approved_places) as all_places,
  (select sum(pop_0_4) from sa2_demand) as kids_0_4 from services`);
console.log('national:', JSON.stringify(nat.rows[0]));
const top = await pool.query(`select sa2_code, sa2_name, state, pop_0_4,
  round(100.0*pop_0_4/pop_total,1) as pct_kids from sa2_demand order by pop_0_4 desc limit 15`);
console.log('top demand SA2:'); top.rows.forEach((r) => console.log(' ', r.pop_0_4, r.pct_kids + '%', r.sa2_name, r.state));
const low = await pool.query(`select count(*) as sa2_under_100 from sa2_demand where pop_0_4 < 100`);
console.log('SA2 with <100 kids 0-4:', low.rows[0].sa2_under_100);
await pool.end();
