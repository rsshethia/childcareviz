# ETL Pipeline — ChildCareViz

How raw government CSVs + scraped fees become queryable tables in Neon. Run top to bottom; every step is idempotent except the crawl output (date-stamped).

## Overview

```mermaid
flowchart LR
    A[ACECQA providers CSV<br/>~10k rows] --> J[JOIN on PR- / SE-]
    B[ACECQA services CSV<br/>~18k rows] --> J
    C[StartingBlocks sitemap<br/>18,492 URLs] --> D[Fee scraper<br/>direct HTTP + escaped-JSON parse]
    D --> E[fees-YYYY-MM-DD.jsonl<br/>~77k rows]
    E --> J
    J --> F[Quarantine + stale flags<br/>+ heuristic provider-type]
    F --> G[Neon Postgres<br/>providers / services /<br/>service_fees_history]
    G --> H[Dashboard / API<br/>Mapbox + Jev next]
```

## Step 1 — Scrape fee pages

```mermaid
flowchart TD
    S[sitemap.xml<br/>swap localhost host] --> L[18,492 slugged URLs]
    L --> P[GET page<br/>8 workers + jitter<br/>follow 308 manually]
    P --> X{status?}
    X -->|200| N[normalize escaped JSON<br/>parse service block +<br/>ageGroup x session fees]
    X -->|404| F1[delisted - drop]
    X -->|308 no Location| F2[stale slug - drop]
    N --> R[FeeRow JSONL<br/>SE- prefix join key]
```

Commands:

```bash
npm run scrape:sitemap          # list URLs only
npm run scrape:fees:sample      # 5-page smoke test
npx tsx src/scraper/run.ts --limit 200 --offset 0   # pilot batch
npm run scrape:fees             # full crawl (~1h)
```

Key facts:

- Pages are ISR server-rendered — plain HTTP GET, no Playwright needed.
- `serviceId` is `SE-000XXXXX` + base64 suffix (NQF) or pure base64 (non-NQF preschools, no ACECQA join).
- 2026-10-16 result: **18,419 ok / 73 failed / 56.8% of pages report fees**. See `docs/crawl-2026-10-16.md`.

## Step 2 — Local ETL + aggregates

```mermaid
flowchart TD
    V[services CSV<br/>csv-parse multiline-safe] --> M[classifyProvider<br/>govt / nfp / for-profit / unknown]
    W[fees JSONL] --> Q[quarantineFee + isStale]
    M --> O[services_enriched.csv]
    Q --> O
    O --> AGG[agg_state_x_providertype.csv<br/>committed]
```

```bash
npm run etl:build
```

Rules (`src/etl/rules.ts`, shared with the DB loader):

| Check | Rule |
|---|---|
| `no-fee-reported` | fee is null (service never reported — show "contact service") |
| `fulldy-out-of-range` | FULLDY < $50 or > $300 (weekly-as-daily misfiles, e.g. $796, $16,100) |
| `hourly-suspect-daily-rate` | HOURLY > $30 (median raw was $121 — daily rates misfiled) |
| `oshc/halfdy-out-of-range` | BEFSCH/AFTSCH > $100, HALFDY outside $20–200 |
| `stale` | `fee_last_updated` older than 2 years (range in data: 2018 → 2026) |

Provider heuristic: council/shire/department → `govt` (0.9); Inc/association/church/community/YMCA/Goodstart → `nfp` (0.75); Pty Ltd/Trust → `for-profit` (0.8); bare `Ltd` → `nfp` (0.55). Residual `unknown` (~10%) is the Jev upgrade target.

## Step 3 — Neon load

```mermaid
flowchart TD
    T[TRUNCATE fees, services, providers<br/>CASCADE] --> PR[providers CSV<br/>batched 500]
    PR --> SV[services CSV<br/>row-by-row + PR stub backfill<br/>+ classification]
    SV --> FE[fees JSONL<br/>batched 500 + quarantine/stale<br/>skip non-NQF SEs]
    FE --> VFY[counts vs ETL benchmarks]
    VFY --> LOG[crawl_log entry]
```

```bash
npm run db:probe        # connection check (no secrets printed)
npm run db:migrate       # schema + idempotent ALTERs
npx tsx scripts/db-load-full.mts
```

Benchmarks the load must hit: **10,070 providers / 18,183 services / 76,083 fee rows** (from 77,354 crawl rows: 1,199 SE-less occasional-care + 72 non-NQF rows excluded) **/ 99.9% SE-join**. Tables: `providers`, `services`, `service_fees_history`, `crawl_log` (+ PostGIS `spatial_ref_sys`).

Wiring: `src/db/pool.ts` reads `DATABASE_URL` or dashboard-style `PGHOST/PGDATABASE/PGUSER/PGPASSWORD` from `.env` (gitignored). `pg` driver suits the current Node batch architecture and the future API alike.

## Failure log (kept honest)

1. Fee parser missed everything — page JSON is backslash-escaped (`\"service\"`). Fixed with normalize-first.
2. Full-load #1: providers batch had 5 target cols / 4 placeholders. #2: literal appended outside row parens. #3: gap numbering on skipped rows. All fixed with sequential `$n` builder.
3. `services_provider_approval_no_fkey` on empty providers — loader now upserts provider stubs first.
4. Missing `services.provider_type` columns — added to `schema.sql` + idempotent `ALTER`s in migrate.

## Next upgrades

- Jev `Choice(provider_type)` to resolve the ~1,861 `unknown`s with confidence scores.
- Mapbox forward-geocode → `services.lat/lon` cache → cluster map.
- Stream crawl output to disk + progress log every 500 pages (current runner buffers in memory).
