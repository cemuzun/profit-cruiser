-- Per-vehicle, per-day availability + price snapshot.
-- Captured each daily scrape; one row per (vehicle_id, day, captured_on) so we can
-- see how a given future date's status changes over time (availability flips = bookings).
CREATE TABLE IF NOT EXISTS public.listing_calendar_days (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  vehicle_id text NOT NULL,
  city text,
  day date NOT NULL,
  captured_on date NOT NULL DEFAULT (now() at time zone 'utc')::date,
  is_available boolean,
  daily_price numeric,
  currency text DEFAULT 'USD',
  source text,            -- 'api' | 'html' | 'inferred'
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, day, captured_on)
);
CREATE INDEX IF NOT EXISTS idx_calendar_vehicle_day ON public.listing_calendar_days(vehicle_id, day);
CREATE INDEX IF NOT EXISTS idx_calendar_captured ON public.listing_calendar_days(captured_on);
CREATE INDEX IF NOT EXISTS idx_calendar_city_day ON public.listing_calendar_days(city, day);

ALTER TABLE public.listing_calendar_days ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read calendar" ON public.listing_calendar_days FOR SELECT USING (true);
CREATE POLICY "public write calendar" ON public.listing_calendar_days FOR ALL USING (true) WITH CHECK (true);

-- Calendar scrape run tracker (separate from listing scrape_runs).
CREATE TABLE IF NOT EXISTS public.calendar_scrape_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  city text,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  vehicles_attempted integer DEFAULT 0,
  vehicles_ok integer DEFAULT 0,
  vehicles_failed integer DEFAULT 0,
  source_api_count integer DEFAULT 0,
  source_html_count integer DEFAULT 0,
  error_message text
);
ALTER TABLE public.calendar_scrape_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read cal_runs" ON public.calendar_scrape_runs FOR SELECT USING (true);
CREATE POLICY "public write cal_runs" ON public.calendar_scrape_runs FOR ALL USING (true) WITH CHECK (true);

-- Convenience view: daily trip-count deltas per vehicle (from existing snapshots).
-- Positive delta = trips completed since previous snapshot day.
CREATE OR REPLACE VIEW public.trip_count_daily AS
WITH daily AS (
  SELECT
    vehicle_id,
    (scraped_at at time zone 'utc')::date AS day,
    MAX(completed_trips) AS trips_eod
  FROM public.listings_snapshots
  WHERE completed_trips IS NOT NULL
  GROUP BY 1, 2
)
SELECT
  vehicle_id,
  day,
  trips_eod,
  trips_eod - LAG(trips_eod) OVER (PARTITION BY vehicle_id ORDER BY day) AS trips_delta
FROM daily;