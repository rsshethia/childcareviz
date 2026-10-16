// ETL: fees JSONL + ACECQA services/providers CSVs -> processed aggregates.
// Applies crawl-review quarantine rules; heuristic provider-type (Jev upgrade later).
import { createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from 'csv-parse';
import { createInterface } from 'node:readline';

const DAY_CUTOFF = new Date('2024-10-16T00:00:00Z'); // stale if fee_last_updated older

export type ProviderType = 'for-profit' | 'nfp' | 'govt' | 'unknown';

export function classifyProvider(legalName: string): { t: ProviderType; conf: number } {
  const n = (legalName || '').toLowerCase();
  if (!n) return { t: 'unknown', conf: 0 };
  if (/city council|shire council|shire of|municipal|city of |district council|borough council|council of |department for education|department of education|education directorate|director-general/.test(n))
    return { t: 'govt', conf: 0.9 };
  if (/\binc\b|incorporated|association|community|church|catholic|uniting|ymca|ywca|lutheran|anglican|baptist|presbyterian|goodstart|ku children|thrive group|communities@work|crest|mission|salvation|st vincent|benevolent|charity/.test(n))
    return { t: 'nfp', conf: 0.75 };
  if (/pty ltd|pty\.|pty limited|\btrust\b|enterprises|holdings|investments|childcare.*pty|early learning.*pty/.test(n))
    return { t: 'for-profit', conf: 0.8 };
  if (/\bltd\b(?!.*pty)/.test(n)) return { t: 'nfp', conf: 0.55 }; // public company limited by guarantee
  return { t: 'unknown', conf: 0 };
}

export function quarantineFee(session: string, fee: number | null): string | null {
  if (fee == null) return 'no-fee-reported';
  if (session === 'FULLDY' && (fee < 50 || fee > 300)) return 'fulldy-out-of-range';
  if (session === 'HOURLY' && fee > 30) return 'hourly-suspect-daily-rate';
  if ((session === 'BEFSCH' || session === 'AFTSCH') && fee > 100) return 'oshc-out-of-range';
  if (session === 'HALFDY' && (fee < 20 || fee > 200)) return 'halfdy-out-of-range';
  return null;
}

async function loadFees() {
  const byService = new Map<string, any[]>();
  const rl = createInterface({ input: createReadStream('fees-2026-10-16.jsonl'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (!r.service_approval_no) continue;
    const q = quarantineFee(r.session_type, r.fee);
    const stale = r.fee_last_updated ? new Date(r.fee_last_updated) < DAY_CUTOFF : null;
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
  'se,prNo,service,legal,provider_type,provider_type_conf,state,postcode,service_type,places,rating,fee_rows,fulldy_median_clean,fulldy_n_clean\n' +
  serviceRows.map((r) => [r.se, r.prNo, JSON.stringify(r.service), JSON.stringify(r.legal), r.provider_type, r.provider_type_conf, r.state, r.postcode, JSON.stringify(r.service_type), r.places, JSON.stringify(r.rating), r.fee_rows, r.fulldy_median_clean, r.fulldy_n_clean].join(',')).join('\n'));
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
