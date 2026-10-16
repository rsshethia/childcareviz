import 'dotenv/config';
import { Pool } from 'pg';

// Never throws at import: pg reads PGHOST/PGDATABASE/PGUSER/PGPASSWORD natively,
// so a Pool can always be constructed. If no DB config exists at all, API routes
// fail per-request (caught → 500 JSON) while /healthz and static stay up.
function buildPool(): Pool {
  if (process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
  }
  if (!process.env.PGHOST && !process.env.PGHOME) {
    console.error('[db] no DATABASE_URL or PG* env — API routes will 500 until configured');
  }
  return new Pool({ ssl: { rejectUnauthorized: false }, max: 5 });
}

export const pool = buildPool();
