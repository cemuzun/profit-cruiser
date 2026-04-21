
-- Listings snapshots (historical)
CREATE TABLE public.listings_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  vehicle_id TEXT NOT NULL,
  city TEXT NOT NULL,
  make TEXT,
  model TEXT,
  year INT,
  trim TEXT,
  vehicle_type TEXT,
  fuel_type TEXT,
  avg_daily_price NUMERIC,
  currency TEXT DEFAULT 'USD',
  completed_trips INT,
  rating NUMERIC,
  is_all_star_host BOOLEAN DEFAULT FALSE,
  host_id TEXT,
  host_name TEXT,
  image_url TEXT,
  location_city TEXT,
  location_state TEXT,
  latitude NUMERIC,
  longitude NUMERIC,
  raw JSONB,
  scraped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_snapshots_vehicle ON public.listings_snapshots(vehicle_id, scraped_at DESC);
CREATE INDEX idx_snapshots_city_date ON public.listings_snapshots(city, scraped_at DESC);
CREATE INDEX idx_snapshots_make_model ON public.listings_snapshots(make, model);

-- Latest snapshot per vehicle
CREATE TABLE public.listings_current (
  vehicle_id TEXT NOT NULL PRIMARY KEY,
  city TEXT NOT NULL,
  make TEXT,
  model TEXT,
  year INT,
  trim TEXT,
  vehicle_type TEXT,
  fuel_type TEXT,
  avg_daily_price NUMERIC,
  currency TEXT DEFAULT 'USD',
  completed_trips INT,
  rating NUMERIC,
  is_all_star_host BOOLEAN DEFAULT FALSE,
  host_id TEXT,
  host_name TEXT,
  image_url TEXT,
  location_city TEXT,
  location_state TEXT,
  latitude NUMERIC,
  longitude NUMERIC,
  last_scraped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_current_city ON public.listings_current(city);
CREATE INDEX idx_current_make_model_year ON public.listings_current(make, model, year);

-- Global cost assumptions (single row)
CREATE TABLE public.cost_assumptions_global (
  id INT PRIMARY KEY DEFAULT 1,
  utilization_pct NUMERIC NOT NULL DEFAULT 60,
  turo_fee_pct NUMERIC NOT NULL DEFAULT 25,
  insurance_monthly NUMERIC NOT NULL DEFAULT 200,
  maintenance_monthly NUMERIC NOT NULL DEFAULT 150,
  cleaning_per_trip NUMERIC NOT NULL DEFAULT 25,
  depreciation_pct_annual NUMERIC NOT NULL DEFAULT 15,
  registration_monthly NUMERIC NOT NULL DEFAULT 25,
  tires_monthly NUMERIC NOT NULL DEFAULT 30,
  default_purchase_price NUMERIC NOT NULL DEFAULT 25000,
  trips_per_month_estimate NUMERIC NOT NULL DEFAULT 8,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO public.cost_assumptions_global (id) VALUES (1);

-- Per-vehicle cost overrides
CREATE TABLE public.cost_overrides (
  vehicle_id TEXT NOT NULL PRIMARY KEY,
  utilization_pct NUMERIC,
  turo_fee_pct NUMERIC,
  insurance_monthly NUMERIC,
  maintenance_monthly NUMERIC,
  cleaning_per_trip NUMERIC,
  depreciation_pct_annual NUMERIC,
  registration_monthly NUMERIC,
  tires_monthly NUMERIC,
  purchase_price NUMERIC,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Watchlist
CREATE TABLE public.watchlist (
  vehicle_id TEXT NOT NULL PRIMARY KEY,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT
);

-- Scrape runs log
CREATE TABLE public.scrape_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  city TEXT NOT NULL,
  status TEXT NOT NULL,
  vehicles_count INT DEFAULT 0,
  segments_run INT DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX idx_scrape_runs_started ON public.scrape_runs(started_at DESC);

-- Enable RLS and open policies (single-user app, no auth)
ALTER TABLE public.listings_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listings_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_assumptions_global ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scrape_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read snapshots" ON public.listings_snapshots FOR SELECT USING (true);
CREATE POLICY "public write snapshots" ON public.listings_snapshots FOR INSERT WITH CHECK (true);

CREATE POLICY "public read current" ON public.listings_current FOR SELECT USING (true);
CREATE POLICY "public write current" ON public.listings_current FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "public read costs" ON public.cost_assumptions_global FOR SELECT USING (true);
CREATE POLICY "public update costs" ON public.cost_assumptions_global FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "public all overrides" ON public.cost_overrides FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public all watchlist" ON public.watchlist FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "public read runs" ON public.scrape_runs FOR SELECT USING (true);
CREATE POLICY "public write runs" ON public.scrape_runs FOR ALL USING (true) WITH CHECK (true);

-- Enable extensions for cron
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
