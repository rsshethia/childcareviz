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
