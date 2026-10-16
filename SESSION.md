# ChildCareViz — session handoff (16 Oct 2026)

Live: https://childcareviz.onrender.com · Repo: https://github.com/rsshethia/childcareviz (`main`)

## What this is
Open national data platform for Australian childcare: ACECQA registers (~18k services,
~10k providers) joined to StartingBlocks per-service fees/vacancies, ABS demand,
Mapbox geocoding, Neon Postgres, Render hosting, static dashboard + D3 stories.

## Data inventory (local, gitignored)
- `Approved-providers-au-export.csv`, `Education-services-au-export.csv` (ACECQA, root)
- `fees-2026-10-16.jsonl` (43.6MB — 18,419 StartingBlocks pages, 77,354 fee rows)
- `data/abs/`: 6× ERP 2025 xlsx (SA2+LGA demand + trends) + `asgs_SA2_2021_shp.zip`,
  `POA_2021_AUST_GDA2020_SHP.zip` (kept local, gitignored)
- `data/processed/geocode-cache.json` — ~13k Mapbox results (no re-billing on reruns)

## Neon state (verified)
- providers **10,070** · services **18,183** (6-class taxonomy) · fee rows **76,083**
  (clean 40,741 · stale 4,567) · `sa2_demand` 2,454 (1,517,443 kids 0–4) ·
  `lga_demand` 548 · `service_sa2` 8,040 · `sa2_supply` with desert bands
- Tables: providers, services, service_fees_history, sa2_demand, lga_demand,
  service_sa2, sa2_supply, crawl_log, app_log, load_runs (+ PostGIS)
- Scripts: `db-verify`, `db-geocheck` (bbox −46…−9, 113…154 — Torres Strait included)

## Key findings (all verified)
- For-profit 10,363 services / 53% of 1.25M places; council-run 557 services, 2.4% of places
- Clean FULLDY median ~$162/day; for-profit premium (NSW $161 vs council $130);
  baby premium ~$9; NQS premium ~4%; places-vs-fee r=0.03 (no scale economies)
- Chains price nationally (Goodstart 609 svc, sd $12.4); OSHC giants report sessions not days
- 82 LDC places per 100 kids nationally; 658 provisional desert SA2s (521k kids) —
  growth corridors (Mickleham, Rockbank, Schofields). PARTIAL: only 8k geocoded so far
- Fee coverage 56.8%; HOURLY polluted (quarantine >$30); 57% fees from 2026

## Taxonomy (src/etl/rules.ts — for-profit checked BEFORE NFP keywords)
for-profit · nfp-community · nfp-other · govt-local (council-run) · govt-state · unknown.
Guardian/G8/Affinity/Camp/TheirCare → for-profit; Goodstart → nfp-other. 1,144 unknown left (Jev job).

## Quarantine rules
no-fee-reported · fulldy-out-of-range (<50/>300) · hourly-suspect (>30) ·
oshc-out-of-range (>100) · halfdy (<20/>200) · stale >2y. Stored per-row, never deleted.

## Running / pending when session paused
- Geocode worker (background): ~13.3k/18.2k done, 0 misses. On completion:
  `npm run geo:export` → `npm run db:geocheck` → re-run `sa2-join` → push
  (map goes 8,389 → ~18k points; desert bands go full-coverage).
- Render 503 at last check — likely mid-deploy or missing env. Check Events tab;
  set DATABASE_URL (or PGHOST set) + MAPBOX_TOKEN. Code already boots without DB.

## Next up (in order)
1. Confirm Render live; add URL badges.
2. Full-coverage sa2 rerun → desert panel in Supply tab → story nº 2 (deserts).
3. Jev (`TYPESAFE_API_KEY`): 1,144 unknowns + operator-name dedup.
4. SEIFA IRSAD by SA2 (equity overlay); DS0005/DS0006 trend ingest.
5. `npm run build`/`start` verified locally; map token via `/api/config` (no manual paste when MAPBOX_TOKEN set).

## Credentials (in local .env, NEVER committed)
PGHOST/PGDATABASE/PGUSER/PGPASSWORD (Neon) · MAPBOX (Mapbox) · needed: TYPESAFE_API_KEY.
Render needs the same as env vars. Public Mapbox token should be URL-locked to onrender.com.

## Reproduce from scratch
`npm ci` → `npm run scrape:fees:sample` → `npm run etl:build` → `db:migrate` →
`db-load-full` → `db-load-fees` (readFileSync, gated) → `db:verify` → `geocode` →
`geo:export` → `sa2-join`. Full pipeline: `docs/etl.md`. Datasets: `.opencode/plan/datasets-required.md`.
