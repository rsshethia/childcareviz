// ETL: fees JSONL + ACECQA services/providers CSVs -> processed aggregates.
// Applies crawl-review quarantine rules; heuristic provider-type (Jev upgrade later).
import { createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from 'csv-parse';
import { createInterface } from 'node:readline';
import { classifyProvider, quarantineFee, STALE_CUTOFF } from './rules.js';

async function loadFees() {
  const byService = new Map<string, any[]>();
  const rl = createInterface({ input: createReadStream('fees-2026-10-16.jsonl'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (!r.service_approval_no) continue;
    const q = quarantineFee(r.session_type, r.fee);
    const stale = r.fee_last_updated ? new Date(r.fee_last_updated) < STALE_CUTOFF : null;
    const row = { ...r, quarantine: q, stale };
    if (!byService.has(r.service_approval_no)) byService.set(r.service_approval_no, []);
    byService.get(r.service_approval_no)!.push(row);
  }
  return byService;
}

function loadCsv(path: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const rows: any[] = [];
    createReadStream(path)
      .pipe(parse({ columns: true, relax_quotes: true, skip_empty_lines: true }))
      .on('data', (r) => rows.push(r))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

function median(a: number[]): number | null {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function mean(a: number[]): number | null {
  if (!a.length) return null;
  return a.reduce((x, y) => x + y, 0) / a.length;
}

const services = await loadCsv('Education-services-au-export.csv');
const providers = await loadCsv('Approved-providers-au-export.csv');
const fees = await loadFees();

const provNameByNo = new Map<string, string>();
for (const p of providers) {
  const no = p['Provider Approval Number']?.trim();
  if (no && !provNameByNo.has(no)) provNameByNo.set(no, (p['Legal Name'] || '').trim());
}

// Join + classify
let joined = 0, feeMatched = 0;
const serviceRows: any[] = [];
const qCounts: Record<string, number> = {};
for (const s of services) {
  const se = (s['ServiceApprovalNumber'] || '').trim();
  if (!se) continue;
  const prNo = (s['Provider Approval Number'] || '').trim();
  const legal = (s['ProviderLegalName'] || '').trim() || provNameByNo.get(prNo) || '';
  const { t, conf } = classifyProvider(legal);
  const feeRows = fees.get(se) || [];
  const cleanFulldy = feeRows
    .filter((f) => f.session_type === 'FULLDY' && f.fee != null && !f.quarantine)
    .map((f) => f.fee);
  for (const f of feeRows) if (f.quarantine) qCounts[f.quarantine] = (qCounts[f.quarantine] || 0) + 1;
  if (feeRows.length) feeMatched++;
  joined++;
  serviceRows.push({
    se, prNo, service: (s['ServiceName'] || '').trim(), legal,
    provider_type: t, provider_type_conf: conf,
    state: (s['State'] || '').trim(), postcode: (s['Postcode'] || '').trim(),
    service_type: (s['ServiceType'] || '').trim(), places: s['NumberOfApprovedPlaces'] || '',
    rating: (s['OverallRating'] || '').trim(),
    ldc: s['Long Day Care'] || '', preschool: [s['Preschool/Kindergarten - Part of a School'], s['Preschool/Kindergarten - Stand alone']].some((v) => (v || '').trim().toLowerCase() === 'yes') ? 'Yes' : 'No',
    oshc: [s['Outside school Hours Care - After School'], s['Outside school Hours Care - Before School'], s['Outside school Hours Care - Vacation Care']].some((v) => (v || '').trim().toLowerCase() === 'yes') ? 'Yes' : 'No',
    fee_rows: feeRows.length,
    fulldy_median_clean: median(cleanFulldy) ?? '',
    fulldy_n_clean: cleanFulldy.length,
  });
}

// Aggregates: state x provider_type -> services, clean FULLDY median
const agg = new Map<string, { services: number; withFees: number; fees: number[] }>();
for (const r of serviceRows) {
  const k = `${r.state}|${r.provider_type}`;
  if (!agg.has(k)) agg.set(k, { services: 0, withFees: 0, fees: [] });
  const a = agg.get(k)!;
  a.services++;
  if (r.fulldy_n_clean > 0) {
    a.withFees++;
    a.fees.push(Number(r.fulldy_median_clean));
  }
}

mkdirSync('data/processed', { recursive: true });
const aggRows = [...agg.entries()].map(([k, v]) => {
  const [state, provider_type] = k.split('|');
  return { state, provider_type, services: v.services, with_clean_fulldy: v.withFees, fulldy_median: median(v.fees) ?? '', fulldy_mean: mean(v.fees)?.toFixed(2) ?? '' };
});
writeFileSync('data/processed/services_enriched.csv',
  'se,prNo,service,legal,provider_type,provider_type_conf,state,postcode,service_type,places,rating,ldc,preschool,oshc,fee_rows,fulldy_median_clean,fulldy_n_clean\n' +
  serviceRows.map((r) => [r.se, r.prNo, JSON.stringify(r.service), JSON.stringify(r.legal), r.provider_type, r.provider_type_conf, r.state, r.postcode, JSON.stringify(r.service_type), r.places, JSON.stringify(r.rating), r.ldc, r.preschool, r.oshc, r.fee_rows, r.fulldy_median_clean, r.fulldy_n_clean].join(',')).join('\n'));
writeFileSync('data/processed/agg_state_x_providertype.csv',
  'state,provider_type,services,with_clean_fulldy,fulldy_median,fulldy_mean\n' +
  aggRows.map((r) => [r.state, r.provider_type, r.services, r.with_clean_fulldy, r.fulldy_median, r.fulldy_mean].join(',')).join('\n'));

const typeCounts: Record<string, number> = {};
for (const r of serviceRows) typeCounts[r.provider_type] = (typeCounts[r.provider_type] || 0) + 1;
console.log(JSON.stringify({
  services_parsed: services.length, providers_parsed: providers.length,
  services_joined: joined, services_with_fee_rows: feeMatched,
  provider_type_counts: typeCounts, quarantine_counts: qCounts,
  agg: aggRows,
}, null, 1));
