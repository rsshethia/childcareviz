// End-to-end proof: loads first 200 fee rows (services + fees) into Neon, then verifies.
// Usage: npx tsx scripts/db-load-sample.mts
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { pool } from '../src/db/pool.js';

const rl = createInterface({ input: createReadStream('fees-2026-10-16.jsonl'), crlfDelay: Infinity });
const svcSeen = new Set<string>();
let feeRows = 0, svcRows = 0, lineNo = 0;
for await (const line of rl) {
  if (!line.trim()) continue;
  if (++lineNo > 400) break; // first 400 lines ~= ~100 services
  const r = JSON.parse(line);
  if (!r.service_approval_no) continue;
  if (!svcSeen.has(r.service_approval_no)) {
    svcSeen.add(r.service_approval_no);
    if (r.provider_approval_no) {
      await pool.query(
        `insert into providers (provider_approval_no, legal_name, source_file)
         values ($1,$2,'fees-2026-10-16.jsonl')
         on conflict (provider_approval_no) do nothing`,
        [r.provider_approval_no, r.provider_name || r.provider_approval_no]
      );
    }
    await pool.query(
      `insert into services (service_approval_no, provider_approval_no, service_name, provider_legal_name, startingblocks_ulid, startingblocks_url, source_file)
       values ($1,$2,$3,$4,$5,$6,'fees-2026-10-16.jsonl')
       on conflict (service_approval_no) do nothing`,
      [r.service_approval_no, r.provider_approval_no || null, r.service_name || null, r.provider_name || null, r.startingblocks_ulid || null, r.source_url]
    );
    svcRows++;
  }
  await pool.query(
    `insert into service_fees_history (service_approval_no, startingblocks_ulid, age_group, session_type, fee, inclusions, fee_last_updated, has_vacancy, source_url)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [r.service_approval_no, r.startingblocks_ulid, r.age_group, r.session_type, r.fee,
     r.inclusions && r.inclusions.length ? r.inclusions : null,
     r.fee_last_updated ? new Date(r.fee_last_updated) : null, r.has_vacancy, r.source_url]
  );
  feeRows++;
}
const v = await pool.query(
  `select (select count(*) from services) as services,
          (select count(*) from service_fees_history) as fees,
          (select count(*) from service_fees_history where fee is not null) as with_fee,
          (select round(avg(fee)::numeric,2) from service_fees_history where session_type='FULLDY' and fee between 50 and 300) as fulldy_mean`
);
console.log(JSON.stringify({ sample_service_inserts: svcRows, sample_fee_inserts: feeRows, db: v.rows[0] }));
await pool.end();
