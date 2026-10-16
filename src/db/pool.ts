import 'dotenv/config';
import { Pool } from 'pg';

// Accepts either DATABASE_URL or Neon-dashboard PG* parts in .env
function connectionString(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const { PGHOST, PGDATABASE, PGUSER, PGPASSWORD } = process.env;
  if (PGHOST && PGDATABASE && PGUSER && PGPASSWORD) {
    const sslmode = process.env.PGSSLMODE || 'require';
    return `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}/${PGDATABASE}?sslmode=${sslmode}`;
  }
  return undefined;
}

const connectionStringValue = connectionString();
if (!connectionStringValue) {
  throw new Error('No database config: set DATABASE_URL or PGHOST/PGDATABASE/PGUSER/PGPASSWORD in .env');
}

export const pool = new Pool({
  connectionString: connectionStringValue,
  ssl: { rejectUnauthorized: false },
  max: 5,
});
