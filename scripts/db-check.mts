import '../src/db/pool.js';
import { pool } from '../src/db/pool.js';
const r = await pool.query(`select session_type, (fee is null) as nofee, count(*) from service_fees_history group by 1,2 order by 1,2`);
console.log(JSON.stringify(r.rows));
await pool.end();
