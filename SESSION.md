# ChildCareViz — session handoff (17 Oct 2026)

Live: https://childcareviz.onrender.com · Repo: https://github.com/rsshethia/childcareviz (`main`)

## What this is
Open national data platform for Australian childcare: ACECQA registers (~18k services,
~10k providers) joined to StartingBlocks per-service fees/vacancies, ABS demand,
Mapbox geocoding + drive-time isochrones, Neon Postgres, Render hosting,
static dashboard (10 tabs) + D3 scrollytelling stories.

## Data inventory (local, gitignored)
- `Approved-providers-au-export.csv`, `Education-services-au-export.csv` (ACECQA, root)
- `fees-2026-10-16.jsonl` (43.6MB — 18,419 StartingBlocks pages, 77,354 fee rows)
- `data/abs/`: ERP 2025 xlsx (SA2+LGA demand + 2001–25 trends), SEIFA 2021 SA2,
  AEDC 2009–24 SA2, ASGS shapefiles (kept local, gitignored)
- `data/processed/geocode-cache.json` — ~13k Mapbox results (no re-billing on reruns)
- `data/processed/isochrones/{sa2}.json` — 2,453 cached drive-time contours
  (Neon `isochrone_cache` is the source of truth; reruns never re-bill)

## Neon state (verified)
- providers **10,070** · services **18,183** · fee rows **76,083** (clean 40,741 ·
  stale 4,567) · `sa2_demand` 2,454 (1,517,443 kids 0–4) · `lga_demand` 548
- Spatial stack: `sa2_boundary` (2,454 shapes + representative points, PostGIS) ·
  `service_sa2` (ST_Contains join) · `sa2_supply` · `sa2_access` (v1 distance 2SFCA) ·
  `sa2_access_iso` (v2 isochrone 2SFCA) · `isochrone_cache` · `seifa_sa2` (2,366) ·
  `aedc_sa2` (2009–24) · `sa2_growth` + `lga_growth` (ERP trends, 2,454 SA2s) · `equity_sa2`
- `services` grew +11 columns: is_ldc/preschool/oshc/fdc flags, temporarily_closed,
  granted_date, hours, days_open, weekday_open/close_min (backfilled from ACECQA CSV)
- Scripts: `db-verify`, `db-geocheck`, `db:backfill-extras` (all re-runnable)

## Spatial access & equity program (B1–B6 — built this session)
Method: **2SFCA v2** — for each SA2 a representative point gets 15- & 30-min driving
catchments (Mapbox Isochrone API, all 2,454 cached; reruns never re-bill). Points that
land offshore/farmland are re-pointed by `sa2:fallback` to the SA2's closest edge to
care (247 fixed — Fremantle's point was on Rottnest Island, Kununurra's 164 km out).
LDC approved places shared across reachable demand with stepped decay (w=1 ≤15 min,
w=0.5 15–30 min; symmetric-catchment approximation). Bands = national tertiles of
the access score among SA2s with ≥100 kids 0–4 (desert ≈ bottom third).

**FINAL RERUN DONE (17 Oct)** — geocoder complete (18,183 services, 0 missed),
full chain re-run and verified. Final numbers:
- Territory: 2,454 SA2s **all banded** (no no-data gap) · iso pairs 619,149 ·
  corr v1↔v2 r=0.893 (v2 authoritative)
- Bands: desert **791 SA2s / 444,087 kids (29.3%)** · constrained 770 / 573,591 ·
  adequate 769 / 497,773 · no-service 124 / 1,992 kids (remote/isolated: Palm Island,
  APY Lands, Tiwi Islands, Christmas/Norfolk/Cocos/Lord Howe; 14 have kids>0)
- LDC access nationally **48.9 places per 100 kids 0–4** (LDC-only — corrects the
  old "82/100" which wrongly summed all service types) · 741,766 LDC places
- SEIFA IRSAD overlay: all demand SA2s joined (88 lack SEIFA) — deserts worst in
  deciles 2–5 (49–52%), lowest in 9–10 (16–17%); even decile 1 (37%) isn't the worst
- AEDC 2024: national DV 23.4% ✓ matches published; high-vulnerability (top quartile
  ≥29.3%): 536 SA2s — 196 are also access deserts (overlap only partial)
- Growth scenario: Rockbank +2,650 kids (23.5% CAGR), Mickleham +2,067 · 760 SA2s /
  516,940 kids projected into desert conditions by 2030 (scenario, not forecast)
- Priority SA2s (2+ flags of access × vulnerability × growth): **464** (top: Mickleham,
  Armadale–Wungong–Brookdale, Sunbury)
- Known quirk: Fremantle-type hubs (67 places/100 locally, 219 LDCs within 30 min)
  sit bottom-third on the competition-adjusted score — not in the priority list (no
  vulnerability/growth flags); keep in mind when reading the choropleth
- B6 "6pm cliff": 20.1% of services close before 18:00 (LDC: NT 51.9% worst,
  VIC 4.4% best); only 201 services with weekend hours; late-closing LDC median
  full-day fee $165 vs $143 early closers (+$22 flexibility tax); 61% of close
  times parseable (approved hours ≠ walk-in reality)

## Equity surfaces (new)
- **Equity tab** (`dashboard/index.html`): choropleth switcher (access band · IRSAD
  decile · AEDC vulnerability · 5-yr growth · 2030 scenario) with hover popups;
  priority table; 2030 growth-risk table; 6pm cliff table; **address checker**
  (client-side geocode + isochrones + counts/median fee over `geo.json` — zero
  per-search server cost, token from `/api/config` or localStorage); methodology block.
  Deep links: `/#equity` etc. open a tab.
- **Payloads**: `equity.json` (by_code compact arrays + priority + future_risk +
  national), `sa2-access.json` (v2 detail + QC), `sa2.json` (supply), `hours.json`,
  `sa2-geo.json` (2,454 simplified shapes, 1.66 MB), `geo.json` (~17k points with
  type flags/places/close time for the checker)
- **API**: `/api/equity?band=&state=&min_kids=&limit=` · `/api/sa2/:code` ·
  existing `/api/config|stats|pricing|services|geo`
- **Story nº 2 "Where the deserts are"** (`dashboard/story/deserts/`): 7-step scrolly —
  the number, the method, growth corridors (11 of top-12 desert/constrained),
  IRSAD gradient, need×access matrix (196 both), 6pm cliff, takeaways. Story index updated.
  All in-story numbers are computed from equity.json/hours.json at load — no stale copy.

## Taxonomy / quarantine (unchanged)
for-profit · nfp-community · nfp-other · govt-local · govt-state · unknown (rules in
`src/etl/rules.ts`). Quarantine flags per row, never deleted (docs/etl.md Step 2).

## Caveats to keep honest
- 2030 figures = scenario extending 5-yr trend with today's places (no supply response)
- Isochrones = typical driving; no PT, no peak traffic, no part-time usage patterns
- Approved hours ≠ actual operating hours (ACECQA register field)
- AEDC attribution required (© AEDC, Data Guidelines); ABS/SEIFA/ERP attribution
- LGA rollup deferred — no offline SA2→LGA allocation table (note as limitation)
- Mapbox public token must stay URL-locked to onrender.com

## Running / pending when session paused
- Nothing committed yet this session — all changes local and verified. Next: `npm run build`,
  commit, push to `main` → Render auto-deploys (start `npm start` = `node dist/src/server.js`).
- Optional follow-ups: story nº 3, LGA rollup, PT catchments, address-checker check
  against the live domain's restricted token.

## Next up (in order)
1. Final pipeline rerun + spot checks (Mickleham, Rockbank, Schofields, NT desert).
2. Commit + push (feature: spatial access & equity) → verify Render deploy.
3. Jev (`TYPESAFE_API_KEY`): residual unknowns + operator-name dedup.
4. LGA rollup for council planners (needs SA2→LGA allocation table).
5. Story nº 3 "Out of pocket, really" (CCS modelling).

## Credentials (in local .env, NEVER committed)
PGHOST/PGDATABASE/PGUSER/PGPASSWORD (Neon) · MAPBOX (Mapbox) · needed: TYPESAFE_API_KEY.
Render needs the same as env vars; build `npm ci && npm run build`, start `npm start`.

## Reproduce from scratch
`npm ci` → `npm run scrape:fees:sample` → `etl:build` → `db:migrate` → `db-load-full`
→ `db-load-fees` → `db:backfill-extras` → `db:verify` → `geocode` → `geo:export` →
`sa2:boundary` → `sa2:join` → `sa2:geo` → `sa2:access` → `isochrones` → `sa2:access:iso`
→ `seifa:load` → `aedc:load` → `abs:trends` → `equity:export` → `hours:stats`.
Full pipeline: `docs/etl.md`. Committed aggregates: `dashboard/*.json`.
