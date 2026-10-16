import { fetchText, ulidFromUrl } from './sitemap.js';
import type { FeeRow } from './types.js';

// serviceId in page looks like SE-00004567<base64>. Short SE number = /^SE-\d+/ prefix.
function shortSe(raw: string): string {
  const m = raw.match(/SE-\d+/);
  return m ? m[0] : raw;
}

function unescapeJson(s: string): string {
  return s.replace(/\\u0026/g, '&').replace(/\\"/g, '"');
}

export async function scrapeServicePage(url: string): Promise<FeeRow[]> {
  const htmlRaw = await fetchText(url);
  // StartingBlocks embeds record as escaped JSON inside Flight payload: \"service\":... — normalize first
  const html = htmlRaw.replace(/\\"/g, '"').replace(/\\u0026/g, '&');
  const ulid = ulidFromUrl(url);
  const fetchedAt = new Date().toISOString();
  const rows: FeeRow[] = [];

  // service block: "service":{"objectID":"...","serviceId":"SE-...","providerName":"...","providerId":"PR-...","name":"..."}
  const svcMatch = html.match(/"service":\{"objectID":"[^"]+","serviceId":"([^"]+)","providerName":"((?:[^"\\]|\\.)*)","publicId":"[^"]*","temporarilyClosed":(?:true|false),"providerId":"([^"]+)","name":"((?:[^"\\]|\\.)*)"/);
  const rawSe = svcMatch?.[1] ?? '';
  const providerName = svcMatch ? unescapeJson(svcMatch[2]) : '';
  const providerId = svcMatch?.[3] ?? '';
  const serviceName = svcMatch ? unescapeJson(svcMatch[4]) : '';
  const se = shortSe(rawSe);

  // Robust: split by ageGroup markers, parse each window (avoids nested-brace regex issues)
  const sessions = ['BEFSCH', 'AFTSCH', 'FULLDY', 'HOURLY', 'HALFDY'] as const;
  const ageRe = /"ageGroup":"([^"]+)"/g;
  const markers: Array<{ age: string; idx: number }> = [];
  let am: RegExpExecArray | null;
  while ((am = ageRe.exec(html))) markers.push({ age: am[1], idx: am.index });
  for (let i = 0; i < markers.length; i++) {
    const ageGroup = markers[i].age;
    const win = html.slice(markers[i].idx, markers[i + 1]?.idx ?? markers[i].idx + 6000);
    const hasVacancy = /"casual":true|"permanent":true/.test(win.slice(0, 3000));
    let emitted = false;
    for (const s of sessions) {
      const sm = win.match(new RegExp('"' + s + '":\\{"fee":([\\d.]+),"inclusions":\\[([^\\]]*)\\],"lastUpdated":"([^"]*)"\\}'));
      if (!sm) continue;
      emitted = true;
      const inclusions = (sm[2] ?? '').match(/"([^"]+)"/g)?.map((x) => x.replace(/"/g, '')) ?? [];
      rows.push({
        service_approval_no: se, startingblocks_ulid: ulid, service_name: serviceName,
        provider_approval_no: providerId, provider_name: providerName,
        age_group: ageGroup, session_type: s, fee: parseFloat(sm[1]),
        inclusions, fee_last_updated: sm[3] ?? null, has_vacancy: hasVacancy,
        source_url: url, fetched_at: fetchedAt,
      });
    }
    if (!emitted) {
      rows.push({
        service_approval_no: se, startingblocks_ulid: ulid, service_name: serviceName,
        provider_approval_no: providerId, provider_name: providerName,
        age_group: ageGroup, session_type: 'FULLDY', fee: null,
        inclusions: [], fee_last_updated: null, has_vacancy: hasVacancy,
        source_url: url, fetched_at: fetchedAt,
      });
    }
  }

  // Fallback: page has no parseable fees (service didn't report) — still emit one row so coverage is auditable
  if (rows.length === 0) {
    rows.push({
      service_approval_no: se, startingblocks_ulid: ulid, service_name: serviceName,
      provider_approval_no: providerId, provider_name: providerName,
      age_group: 'unknown', session_type: 'FULLDY', fee: null,
      inclusions: [], fee_last_updated: null, has_vacancy: false,
      source_url: url, fetched_at: fetchedAt,
    });
  }
  return rows;
}
