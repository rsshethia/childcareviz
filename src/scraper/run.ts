import { writeFileSync } from 'node:fs';
import pLimit from 'p-limit';
import { fetchSitemapUrls } from './sitemap.js';
import { scrapeServicePage } from './servicePage.js';

const args = process.argv.slice(2);
const sitemapOnly = args.includes('--sitemap-only');
const sampleIdx = args.indexOf('--sample');
const sampleN = sampleIdx >= 0 ? parseInt(args[sampleIdx + 1] ?? '5', 10) : 0;

const CONCURRENCY = parseInt(process.env.SCRAPE_CONCURRENCY ?? '5', 10);
const DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS ?? '800', 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const urls = await fetchSitemapUrls();
console.log(`sitemap urls: ${urls.length}`);
writeFileSync('sitemap-urls.txt', urls.join('\n'));
if (sitemapOnly) process.exit(0);

const targets = sampleN > 0 ? urls.slice(0, sampleN) : urls;
console.log(`scraping ${targets.length} pages (concurrency=${CONCURRENCY})`);

const limit = pLimit(CONCURRENCY);
let ok = 0, feeFound = 0, failed = 0;
const out: string[] = [];
await Promise.all(targets.map((url) => limit(async () => {
  await sleep(Math.random() * DELAY_MS);
  try {
    const rows = await scrapeServicePage(url);
    ok++;
    if (rows.some((r) => r.fee != null)) feeFound++;
    for (const r of rows) out.push(JSON.stringify(r));
  } catch (e) {
    failed++;
    console.error('FAIL', url, (e as Error).message);
  }
})));

const stamp = new Date().toISOString().slice(0, 10);
const fname = sampleN > 0 ? `fees-sample-${stamp}.jsonl` : `fees-${stamp}.jsonl`;
writeFileSync(fname, out.join('\n'));
console.log(JSON.stringify({ urls_targeted: targets.length, urls_ok: ok, urls_fee_found: feeFound, urls_failed: failed, file: fname }));
