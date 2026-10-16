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
const seType = new Map<string, string>();
const ops: Record<string, { n: number; fees: number[]; types: Record<string, number> }> = {};
for (const r of enriched) {
  const t = r.provider_type || 'unknown';
  seType.set(r.se, t);
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
  const legal = String(r.legal || '').replace(/"/g, '');
  if (legal) {
    ops[legal] = ops[legal] || { n: 0, fees: [] as number[], types: {} as Record<string, number> };
    ops[legal].n++;
    ops[legal].types[t] = (ops[legal].types[t] || 0) + 1;
  }
  if (r.fulldy_n_clean && Number(r.fulldy_n_clean) > 0) {
    tt.withFees++;
    const f = Number(r.fulldy_median_clean);
    const k = `${r.state}|${t}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(f);
    const rt = (r.rating || 'Unrated').replace(/"/g, '');
    (byRating[rt] = byRating[rt] || []).push(f);
    if (legal && ops[legal]) ops[legal].fees.push(f);
  }
}

const cells = [...byKey.entries()].map(([k, v]) => {
  const [state, provider_type] = k.split('|');
  return { state, provider_type, services: v.length, median: med(v), mean: mean(v) };
});

// quarantine counts + age premium + inclusions + vacancy, from fees JSONL
const qCounts: Record<string, number> = {};
const ageFee: Record<string, number[]> = {};
const incl: Record<string, number> = {};
const vacAll = new Set<string>(), allSvc = new Set<string>(), feePages = new Set<string>();
const vacByType: Record<string, Set<string>> = {}, svcByType: Record<string, Set<string>> = {};
let feeRows = 0;
const rl = createInterface({ input: createReadStream('fees-2026-10-16.jsonl'), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  feeRows++;
  const se = r.service_approval_no || r.source_url;
  allSvc.add(se);
  const t = seType.get(r.service_approval_no);
  if (t) {
    (svcByType[t] = svcByType[t] || new Set()).add(se);
    if (r.has_vacancy) {
      vacAll.add(se);
      (vacByType[t] = vacByType[t] || new Set()).add(se);
    }
  } else if (r.has_vacancy) vacAll.add(se);
  const q = quarantineFee(r.session_type, r.fee);
  if (q) qCounts[q] = (qCounts[q] || 0) + 1;
  if (r.fee != null && !q) feePages.add(r.source_url);
  if (r.session_type === 'FULLDY' && r.fee != null && !q) {
    (ageFee[r.age_group] = ageFee[r.age_group] || []).push(r.fee);
  }
  if (r.fee != null && !q) for (const i of (r.inclusions || [])) incl[i] = (incl[i] || 0) + 1;
}

const ratingBands = Object.fromEntries(
  Object.entries(byRating).map(([k, v]) => {
    const s = v.slice().sort((x, y) => x - y);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    return [k, { n: v.length, min: s[0], q1: q(0.25), median: med(v), q3: q(0.75), max: s[s.length - 1], mean: mean(v) }];
  })
);
// Distribution bins ($10) of clean per-service FULLDY medians, by provider type (story beeswarm/histogram).
const dist: Record<string, { bin: number; n: number }[]> = {};
{
  const buckets: Record<string, Record<number, number>> = {};
  for (const r of enriched) {
    if (r.fulldy_n_clean && Number(r.fulldy_n_clean) > 0) {
      const t = r.provider_type || 'unknown';
      const b = Math.floor(Number(r.fulldy_median_clean) / 10) * 10;
      buckets[t] = buckets[t] || {};
      buckets[t][b] = (buckets[t][b] || 0) + 1;
    }
  }
  for (const [t, m] of Object.entries(buckets))
    dist[t] = Object.entries(m).map(([bin, n]) => ({ bin: Number(bin), n })).sort((a, b) => a.bin - b.bin);
}

const sdev = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a)!; return Math.round(Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) * 100) / 100; };
const operators = Object.entries(ops).sort((a, b) => b[1].n - a[1].n).slice(0, 20).map(([name, v]) => ({
  name, services: v.n, with_fees: v.fees.length,
  type: Object.entries(v.types).sort((a, b) => b[1] - a[1])[0][0],
  median: med(v.fees), sd: sdev(v.fees),
}));
const ageLabels: Record<string, string> = { '0012MN': '0–12 months', '1324MN': '13–24 months', '2535MN': '25–35 months', '36MNPR': '36 months to preschool', OVPRAG: 'Outside school hours', DAYVAC: 'Vacation care' };
const agePremium = Object.entries(ageFee).map(([k, v]) => ({ age: ageLabels[k] || k, n: v.length, median: med(v) }))
  .sort((a, b) => (b.median || 0) - (a.median || 0));
const inclusions = Object.entries(incl).sort((a, b) => b[1] - a[1]).slice(0, 10)
  .map(([name, n]) => ({ name, n }));
const vacancy = {
  overall: allSvc.size ? Math.round((100 * vacAll.size) / allSvc.size * 10) / 10 : null,
  services: allSvc.size, with_vacancy: vacAll.size,
  by_type: Object.fromEntries(Object.entries(svcByType).map(([t, s]) => [t, {
    services: s.size, with_vacancy: vacByType[t]?.size || 0,
    rate: Math.round(((vacByType[t]?.size || 0) / s.size) * 1000) / 10,
  }])),
};

mkdirSync('dashboard', { recursive: true });
writeFileSync('dashboard/data.json', JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  coverage: { fee_rows: feeRows, pages: allSvc.size, clean_pages: feePages.size, quarantine: qCounts },
  provider_mix: typeTotals,
  council_by_state: councilByState,
  state_table: cells.sort((a, b) => a.state.localeCompare(b.state) || a.provider_type.localeCompare(b.provider_type)),
  quality_vs_fee: ratingBands, dist,
  operators, age_premium: agePremium, inclusions, vacancy,
}, null, 1));
console.log('dashboard/data.json written');
