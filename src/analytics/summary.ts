// Builds dashboard/data.json from local processed files (no DB needed).
// Usage: npx tsx src/analytics/summary.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { quarantineFee } from '../etl/rules.js';

const enriched: any[] = parse(readFileSync('data/processed/services_enriched.csv', 'utf8'), { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });

function med(a: number[]): number | null {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return Math.round(s[Math.floor(s.length / 2)] * 100) / 100;
}
function mean(a: number[]): number | null {
  if (!a.length) return null;
  return Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100;
}
const yes = (v: any) => String(v || '').trim().toLowerCase() === 'yes';

const byKey = new Map<string, number[]>();
const byRating: Record<string, number[]> = {};
const typeTotals: Record<string, { services: number; withFees: number; places: number; ldc: number; preschool: number; oshc: number; fdc: number }> = {};
const councilByState: Record<string, number> = {};
for (const r of enriched) {
  const t = r.provider_type || 'unknown';
  typeTotals[t] = typeTotals[t] || { services: 0, withFees: 0, places: 0, ldc: 0, preschool: 0, oshc: 0, fdc: 0 };
  const tt = typeTotals[t];
  tt.services++;
  const pl = parseInt(String(r.places).replace(/"/g, ''), 10);
  if (Number.isFinite(pl)) tt.places += pl;
  if (yes(r.ldc)) tt.ldc++;
  if (yes(r.preschool)) tt.preschool++;
  if (yes(r.oshc)) tt.oshc++;
  if ((r.service_type || '').replace(/"/g, '').trim() === 'Family Day Care') tt.fdc++;
  if (t === 'govt-local') councilByState[r.state || '(blank)'] = (councilByState[r.state || '(blank)'] || 0) + 1;
  if (r.fulldy_n_clean && Number(r.fulldy_n_clean) > 0) {
    tt.withFees++;
    const f = Number(r.fulldy_median_clean);
    const k = `${r.state}|${t}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(f);
    const rt = (r.rating || 'Unrated').replace(/"/g, '');
    (byRating[rt] = byRating[rt] || []).push(f);
  }
}

const cells = [...byKey.entries()].map(([k, v]) => {
  const [state, provider_type] = k.split('|');
  return { state, provider_type, services: v.length, median: med(v), mean: mean(v) };
});

// quarantine counts from fees JSONL
const qCounts: Record<string, number> = {};
let feeRows = 0;
const pages = new Set<string>(), feePages = new Set<string>();
const rl = createInterface({ input: createReadStream('fees-2026-10-16.jsonl'), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  feeRows++;
  if (r.source_url) pages.add(r.source_url);
  const q = quarantineFee(r.session_type, r.fee);
  if (q) qCounts[q] = (qCounts[q] || 0) + 1;
  if (r.fee != null && !q) feePages.add(r.source_url);
}

const ratingBands = Object.fromEntries(
  Object.entries(byRating).map(([k, v]) => [k, { n: v.length, median: med(v), mean: mean(v) }])
);

mkdirSync('dashboard', { recursive: true });
writeFileSync('dashboard/data.json', JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  coverage: { fee_rows: feeRows, pages: pages.size, clean_pages: feePages.size, quarantine: qCounts },
  provider_mix: typeTotals,
  council_by_state: councilByState,
  state_table: cells.sort((a, b) => a.state.localeCompare(b.state) || a.provider_type.localeCompare(b.provider_type)),
  quality_vs_fee: ratingBands,
}, null, 1));
console.log('dashboard/data.json written');
