# ChildCareViz

National childcare data platform (AU). Providers + services (ACECQA) joined to per-service fees/vacancies (StartingBlocks), mapped with Mapbox, stored in Neon Postgres, hosted on Render.

## Quick start

```bash
npm install
# sitemap only
npm run scrape:sitemap
# sample 5 fee pages (no DB needed)
npm run scrape:fees:sample
# full crawl (~18.5k pages, polite ~5 conc, 800ms jitter)
npm run scrape:fees
# migrate Neon
psql $DATABASE_URL -f db/schema.sql
```

## Sources (store provenance for every row)

- ACECQA national registers: https://www.acecqa.gov.au/resources/national-registers
- StartingBlocks find child care: https://startingblocks.gov.au/find-child-care (service pages `/find-child-care/<ULID>/<slug>` hold `vacanciesAndFees` server-rendered JSON)
- Large providers: https://startingblocks.gov.au/large-providers
- CCS reports: https://www.education.gov.au/early-childhood/about/data-and-reports/quarterly-reports

See `C:\Users\Rushabh\.opencode\plan/datasets-required.md` for the full fetch list.

## Notes

- `robots.txt` allows service pages, disallows `/api/ /studio/ /cgi-bin/`. No auth needed. ISR cache 5 min — don't recrawl faster.
- Sitemap has ~18.5k service URLs vs ~30k ACECQA services: gap = Family Day Care / historical / CCS-ineligible with no fee page.
- `serviceId` in HTML is `SE-000XXXXX` + base64 suffix — join on `/^SE-\d+/` prefix.
