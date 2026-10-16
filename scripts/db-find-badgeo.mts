import { pool } from '../src/db/pool.js';
const r = await pool.query(`select service_approval_no, service_name, address, suburb, state, postcode, lat, lon
  from services where lat is not null and not (lat between -44 and -10 and lon between 113 and 154)`);
console.log(JSON.stringify(r.rows, null, 1));
await pool.end();
