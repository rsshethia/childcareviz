import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
const rows: any[] = parse(readFileSync('data/processed/services_enriched.csv', 'utf8'),
  { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });
const want = ['Guardian Community Early Learning Centres Pty Ltd', 'G8 Education Limited',
  'Goodstart Early Learning Ltd', 'TheirCare Pty Ltd', 'Camp Australia Pty Limited',
  'Affinity Education Group Pty Limited'];
const got: Record<string, string> = {};
for (const r of rows) {
  const l = String(r.legal || '').replace(/"/g, '');
  if (want.includes(l)) got[l] = r.provider_type;
}
console.log(got);
