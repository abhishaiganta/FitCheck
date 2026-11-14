-- Spec sections 6.4, 8.12, 11, 14: columns and tables the worker needs beyond 001.
create table if not exists error_log (
  id bigserial primary key, at timestamptz not null default now(),
  where_ text not null,        -- e.g. 'worker.gen.tripo', 'api.search'
  listing_id bigint, code text, message text, detail jsonb
);
create index if not exists error_log_at on error_log (at desc);

alter table assets add column if not exists orient_override text;      -- identity|x+90|x-90|z+90|z-90|x180, set from /admin
alter table assets add column if not exists yaw_override_deg numeric(5,1); -- optional spin about the up axis
alter table assets add column if not exists views_used jsonb;          -- [{photo_idx, angle}] sent to the 3D provider
alter table assets add column if not exists version int not null default 1;  -- bumps on re-export; blob path usdz/{id}-v{n}.usdz
alter table assets add column if not exists orientation_used text;
alter table assets add column if not exists file_bytes int;
alter table assets add column if not exists next_attempt_at timestamptz;   -- backoff for retries
alter table assets add column if not exists gen_state jsonb;                -- provider chain progress: tried[], started_at, raw_glb_url

alter table listing_details add column if not exists views jsonb;          -- per-photo: same_object, angle, clean
alter table listing_details add column if not exists content_hash text;    -- sha256(title+description+first photo): never tag twice
alter table listing_details add column if not exists dims_from_text boolean not null default false; -- tagger's verdict; export may downgrade dims_source but never this
alter table listings add column if not exists last_checked_at timestamptz;
alter table listings add column if not exists posted_at timestamptz;

create index if not exists listings_active on listings (is_active, scraped_at desc);
create index if not exists asset_events_at on asset_events (at desc);

-- scrape job ledger: at most 1 job per source per 30 min, and resumable polling across worker restarts
create table if not exists scrape_jobs (
  id bigserial primary key,
  source text not null,
  kind text not null default 'listings',      -- listings|baseline
  snapshot_id text,
  input jsonb,
  status text not null default 'running',     -- running|ready|ingested|failed
  records int, note text,
  triggered_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists scrape_jobs_source on scrape_jobs (source, triggered_at desc);

-- stretch: corner sets (several items composed into one USDZ)
create table if not exists sets (
  id bigserial primary key, title text not null, usdz_url text, glb_url text,
  total_usd numeric(10,2), created_at timestamptz not null default now()
);
create table if not exists set_items (
  set_id bigint references sets(id) on delete cascade,
  listing_id bigint references listings(id) on delete cascade,
  x_in numeric(6,1) not null default 0, z_in numeric(6,1) not null default 0,
  y_in numeric(6,1) not null default 0, yaw_deg numeric(5,1) not null default 0,
  primary key (set_id, listing_id)
);
