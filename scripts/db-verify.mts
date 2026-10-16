import { pool } from '../src/db/pool.js';
const r = await pool.query(`select (select count(*) from providers) as providers,
  (select count(*) from services) as services,
  (select count(*) from service_fees_history) as fees,
  (select count(*) from service_fees_history where quarantine is null) as clean,
  (select count(distinct service_approval_no) from service_fees_history where fee is not null) as services_with_fee,
  (select count(*) from service_fees_history where stale) as stale_fees`);
console.log(JSON.stringify(r.rows[0]));
const q = await pool.query(`select coalesce(quarantine,'clean') as q, count(*) from service_fees_history group by 1 order by 2 desc`);
console.log(JSON.stringify(q.rows));
const t = await pool.query(`select provider_type, count(*) from services group by 1 order by 2 desc`);
console.log(JSON.stringify(t.rows));
await pool.end();
