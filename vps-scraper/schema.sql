-- Mirrors the Lovable Cloud tables we used previously.
create table if not exists listings_current (
  vehicle_id text primary key,
  city text not null,
  make text, model text, year int, trim text,
  vehicle_type text, fuel_type text,
  avg_daily_price numeric, currency text default 'USD',
  price_7d_avg numeric, price_14d_avg numeric, price_30d_avg numeric,
  completed_trips int default 0,
  rating numeric,
  is_all_star_host boolean default false,
  host_id text, host_name text,
  image_url text,
  location_city text, location_state text,
  latitude numeric, longitude numeric,
  last_scraped_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_listings_current_city on listings_current(city);
create index if not exists idx_listings_current_make_model on listings_current(make, model);

create table if not exists listings_snapshots (
  id uuid primary key default gen_random_uuid(),
  vehicle_id text not null,
  city text not null,
  make text, model text, year int, trim text,
  vehicle_type text, fuel_type text,
  avg_daily_price numeric, currency text default 'USD',
  price_7d_avg numeric, price_14d_avg numeric, price_30d_avg numeric,
  completed_trips int default 0,
  rating numeric,
  is_all_star_host boolean default false,
  host_id text, host_name text,
  image_url text,
  location_city text, location_state text,
  latitude numeric, longitude numeric,
  raw jsonb,
  scraped_at timestamptz default now(),
  created_at timestamptz default now()
);
create index if not exists idx_snap_vehicle on listings_snapshots(vehicle_id, scraped_at);
create index if not exists idx_snap_city_time on listings_snapshots(city, scraped_at);

create table if not exists price_forecasts (
  id uuid primary key default gen_random_uuid(),
  vehicle_id text not null,
  city text not null,
  window_label text not null,
  avg_price numeric, min_price numeric, max_price numeric,
  window_start date not null,
  window_end date not null,
  scraped_at timestamptz default now(),
  created_at timestamptz default now()
);
create index if not exists idx_forecast_vehicle on price_forecasts(vehicle_id, scraped_at);
create index if not exists idx_forecast_city_time on price_forecasts(city, scraped_at);

create table if not exists scrape_runs (
  id uuid primary key default gen_random_uuid(),
  city text not null,
  status text not null,
  vehicles_count int default 0,
  segments_run int default 0,
  error_message text,
  started_at timestamptz default now(),
  finished_at timestamptz
);
create index if not exists idx_runs_started on scrape_runs(started_at desc);
