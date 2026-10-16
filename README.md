# ChildCareViz 🇦🇺

**How much does childcare cost near you — and who runs it?**

ChildCareViz is an open national data platform for Australian early childhood education and care. It joins the official ACECQA registers (~30k services, ~10k providers) with per-service fees and vacancies from StartingBlocks, so parents, policymakers and planners can search, map and compare.

## Who is it for?

- **Parents** – find nearby centres, compare daily fees out-of-pocket (after Child Care Subsidy), check NQS quality ratings, hours and vacancies.
- **Policymakers** – see for-profit vs not-for-profit vs council-run share, fee vs quality patterns, and childcare deserts by SA2.
- **Planners / researchers** – site selection, supply-per-child analytics, bulk data + API.

## Where does the data come from?

Every row keeps its `source_url + fetched_at`:

| Data | Source |
|---|---|
| Providers + services, ratings, places, hours | [ACECQA national registers](https://www.acecqa.gov.au/resources/national-registers) |
| Fees, vacancies, inclusions per service | [StartingBlocks Find Child Care](https://startingblocks.gov.au/find-child-care) (service pages, server-rendered) |
| Large providers (66 with 25+ services) + financials | [StartingBlocks large providers](https://startingblocks.gov.au/large-providers) |
| Subsidy benchmarks + hourly caps | [Dept of Education CCS reports](https://www.education.gov.au/early-childhood/about/data-and-reports/quarterly-reports) |
| Demand + boundaries (next) | ABS Census SA2, SEIFA, ASGS, AEDC |

Current snapshot (verified): FULLDY median ~$172/day, OSHC before-school ~$24 / after-school ~$33. ~57% of service pages report fees; the rest say "contact the service".

## Status

- [x] StartingBlocks fee scraper (LDC + OSHC session types, polite crawl, resumable)
- [x] Neon Postgres schema (`providers`, `services`, `service_fees_history`)
- [ ] Full 18.5k-page crawl → fee history load
- [ ] Provider-type classification (for-profit / not-for-profit / council-run via ABR + ACNC + Jev)
- [ ] Mapbox search + dashboard, Render deploy

## Quick start

```bash
npm install

# 1. List all service pages (no DB needed)
npm run scrape:sitemap

# 2. Scrape 5 pages to test
npm run scrape:fees:sample

# 3. Scrape a batch (resumable)
npx tsx src/scraper/run.ts --limit 200 --offset 0

# 4. Full crawl (~18.5k pages, ~1h at 8 workers)
npm run scrape:fees

# 5. Load into Neon Postgres
psql $DATABASE_URL -f db/schema.sql
```

Copy `.env.example` to `.env` and set `DATABASE_URL` (Neon), `TYPESAFE_API_KEY` (Jev classification), `MAPBOX_TOKEN` (maps).

## How scraping works

- Sitemap `startingblocks.gov.au/sitemap.xml` → ~18.5k `/find-child-care/<ULID>/<slug>` URLs (swap the `localhost:3000` host in `<loc>`).
- Each page embeds `vacanciesAndFees` JSON (age groups `0012MN…DAYVAC` × sessions `FULLDY/HALFDY/HOURLY/BEFSCH/AFTSCH`) with `fee`, `inclusions`, `lastUpdated` + vacancy flags.
- `serviceId` looks like `SE-00004567<base64>` — join to ACECQA on the `SE-000XXXXX` prefix (verified 198/198 in test batch).
- Polite by design: 5–8 workers, jitter, follows 308 slug redirects, respects the 5-min page cache. `robots.txt` allows service pages.

## Project layout

```
src/scraper/   sitemap + service-page parser + runner (JSONL output)
db/schema.sql  Neon/PostGIS tables
render.yaml    Render web + scraper worker
```

## Contributing

PRs welcome — especially geocoding, ABS SA2 joins, and dashboard work. Please keep source attribution (`source_url`, `fetched_at`) on every new dataset.

## Licence / provenance

Code: MIT. Data stays with its owners (ACECQA / StartingBlocks / ABS / Dept of Education) — this repo stores fetch scripts and derived aggregates with links back to source, not redistributed bulk dumps.
