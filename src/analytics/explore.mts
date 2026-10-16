// Analyst exploration cuts: places share, age premium, chain consistency,
// vacancies, inclusions, staleness, places-vs-fee correlation. Local files only.
// Usage: npx tsx src/analytics/explore.mts
import { readFileSync, createReadStream } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { createInterface } from 'node:readline';

const enriched: any[] = parse(readFileSync('data/processed/services_enriched.csv', 'utf8'),
  { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });
const strip = (v: any) => String(v || '').replace(/"/g, '').trim();
const med = (a: number[]) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sdev = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a)!; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };

const places: Record<string, number> = {}, svcN: Record<string, number> = {};
for (const r of enriched) {
  const t = strip(r.provider_type) || 'unknown';
  svcN[t] = (svcN[t] || 0) + 1;
  const p = parseInt(strip(r.places), 10);
  if (Number.isFinite(p)) places[t] = (places[t] || 0) + p;
}
console.log('A. PLACES vs SERVICES share:', JSON.stringify({ places, services: svcN }));

const byR: Record<string, number[]> = {};
for (const r of enriched) {
  if (r.fulldy_n_clean && Number(r.fulldy_n_clean) > 0) {
    const k = strip(r.rating) || 'Unrated';
    (byR[k] = byR[k] || []).push(Number(r.fulldy_median_clean));
  }
}
console.log('F. RATING vs FEE:', JSON.stringify(Object.fromEntries(Object.entries(byR).map(([k, v]) => [k, { n: v.length, med: med(v), mean: mean(v)!.toFixed(1) }]))));

const ops: Record<string, { n: number; fees: number[] }> = {};
for (const r of enriched) {
  const k = strip(r.legal);
  if (!k) continue;
  ops[k] = ops[k] || { n: 0, fees: [] };
  ops[k].n++;
  if (Number(r.fulldy_n_clean) > 0) ops[k].fees.push(Number(r.fulldy_median_clean));
}
console.log('E. CHAIN CONSISTENCY (services, with-fees, med, sd):');
for (const [k, v] of Object.entries(ops).sort((a, b) => b[1].n - a[1].n).slice(0, 12))
  console.log('  ', v.n, v.fees.length, med(v.fees), 'sd=' + sdev(v.fees).toFixed(1), '|', k.slice(0, 60));

const xy = enriched.filter((r) => Number(r.fulldy_n_clean) > 0)
  .map((r) => [parseInt(strip(r.places), 10), Number(r.fulldy_median_clean)] as const)
  .filter(([p]) => Number.isFinite(p) && p > 0);
const mx = mean(xy.map(([p]) => p))!, my = mean(xy.map(([, f]) => f))!;
const cov = xy.reduce((s, [p, f]) => s + (p - mx) * (f - my), 0);
const vx = Math.sqrt(xy.reduce((s, [p]) => s + (p - mx) ** 2, 0));
const vy = Math.sqrt(xy.reduce((s, [, f]) => s + (f - my) ** 2, 0));
console.log('I. places-vs-fee Pearson r =', (cov / (vx * vy)).toFixed(3), 'n =', xy.length);

const ageFee: Record<string, number[]> = {}, sessFee: Record<string, number[]> = {};
const incl: Record<string, number> = {}, vacSvc = new Set<string>(), allSvc = new Set<string>();
const updY: Record<string, number> = {}, staleBy: Record<string, number> = {};
const rl = createInterface({ input: createReadStream('fees-2026-10-16.jsonl'), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  allSvc.add(r.source_url);
  if (r.has_vacancy) vacSvc.add(r.source_url);
  if (r.fee == null) continue;
  if (r.session_type === 'FULLDY' && (r.fee < 50 || r.fee > 300)) continue;
  if (r.session_type === 'HOURLY' && r.fee > 30) continue;
  (ageFee[r.age_group] = ageFee[r.age_group] || []).push(r.fee);
  (sessFee[r.session_type] = sessFee[r.session_type] || []).push(r.fee);
  for (const i of (r.inclusions || [])) incl[i] = (incl[i] || 0) + 1;
  if (r.fee_last_updated) {
    const y = String(r.fee_last_updated).slice(0, 4);
    updY[y] = (updY[y] || 0) + 1;
    if (new Date(r.fee_last_updated) < new Date('2024-10-16')) staleBy[r.session_type] = (staleBy[r.session_type] || 0) + 1;
  }
}
console.log('B. AGE-GROUP clean FULLDY medians:', JSON.stringify(Object.fromEntries(Object.entries(ageFee).map(([k, v]) => [k, { n: v.length, med: med(v) }]))));
console.log('C. SESSION clean medians:', JSON.stringify(Object.fromEntries(Object.entries(sessFee).map(([k, v]) => [k, { n: v.length, med: med(v), mean: mean(v)!.toFixed(1) }]))));
console.log('D. VACANCY: services with any vacancy', vacSvc.size, '/', allSvc.size, '=', (100 * vacSvc.size / allSvc.size).toFixed(1) + '%');
console.log('G. TOP INCLUSIONS:', JSON.stringify(Object.entries(incl).sort((a, b) => b[1] - a[1]).slice(0, 10)));
console.log('H. fee_last_updated by year:', JSON.stringify(updY), 'stale by session:', JSON.stringify(staleBy));
