-- ChildCareViz Neon (Postgres 16) schema. Run: psql $DATABASE_URL -f db/schema.sql
create extension if not exists postgis;

create table if not exists providers (
  provider_approval_no text primary key,
  legal_name text not null,
  trading_name text,
  suburb text, state text, postcode text,
  provider_type text, -- for-profit | nfp-community | nfp-other | govt-local | govt-state | unknown
  provider_type_confidence double precision,
  operator_group text,
  abn text, acnc_registered boolean,
  source_file text, ingested_at timestamptz default now()
);

create table if not exists services (
  service_approval_no text primary key, -- SE-000XXXXX (short form)
  provider_approval_no text references providers(provider_approval_no),
  service_name text not null,
  provider_legal_name text,
  service_type text, -- Centre-Based Care | Family Day Care
  address text, suburb text, state text, postcode text,
  approved_places int,
  overall_rating text,
  provider_type text, -- for-profit | nfp | govt | unknown (heuristic; Jev upgrade later)
  provider_type_confidence double precision,
  -- service flavours + operating profile (backfilled from ACECQA CSV by scripts/db-backfill-services-extras.mts)
  is_ldc boolean, is_preschool boolean, is_oshc boolean, is_fdc boolean, is_other boolean,
  temporarily_closed boolean, granted_date date,
  hours jsonb, days_open int, weekday_open_min int, weekday_close_min int,
  startingblocks_ulid text unique,
  startingblocks_url text,
  lat double precision, lon double precision, geocode_source text,
  source_file text, ingested_at timestamptz default now()
);
create index if not exists idx_services_state on services(state);
create index if not exists idx_services_provider on services(provider_approval_no);

-- Time-series: one row per service x age_group x session_type per crawl
create table if not exists service_fees_history (
  id bigserial primary key,
  service_approval_no text references services(service_approval_no),
  startingblocks_ulid text,
  age_group text not null, -- 0012MN | 1324MN | 2535MN | 36MNPR | OVPRAG | DAYVAC
  session_type text not null, -- FULLDY | HALFDY | HOURLY | BEFSCH | AFTSCH
  fee numeric, -- dollars, usual fee excl. CCS
  inclusions text[],
  fee_last_updated date,
  has_vacancy boolean,
  quarantine text, -- null = clean; else no-fee-reported | fulldy-out-of-range | hourly-suspect-daily-rate | oshc-out-of-range | halfdy-out-of-range
  stale boolean, -- fee_last_updated older than 2y
  source_url text not null,
  fetched_at timestamptz default now()
);
create index if not exists idx_fees_service on service_fees_history(service_approval_no, fetched_at desc);

create table if not exists crawl_log (
  id bigserial primary key,
  started_at timestamptz default now(),
  finished_at timestamptz,
  urls_targeted int, urls_ok int, urls_fee_found int, urls_failed int,
  notes text
);

-- Operational logging: code-run events + DB load audit trail.
create table if not exists app_log (
  id bigserial primary key,
  run_id text not null,
  stage text not null, -- scraper | etl | db-load | migrate
  level text not null, -- info | warn | error
  message text not null,
  details jsonb,
  created_at timestamptz default now()
);
create index if not exists idx_app_log_run on app_log(run_id);

create table if not exists load_runs (
  id bigserial primary key,
  run_id text not null unique,
  stage text not null,
  target text not null, -- providers | services | fees | all
  rows_ok int default 0,
  rows_failed int default 0,
  rows_skipped int default 0,
  started_at timestamptz default now(),
  finished_at timestamptz,
  notes text
);
