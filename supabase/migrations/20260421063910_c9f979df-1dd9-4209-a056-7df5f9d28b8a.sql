ALTER TABLE public.listings_current
  ADD COLUMN IF NOT EXISTS price_7d_avg numeric,
  ADD COLUMN IF NOT EXISTS price_14d_avg numeric,
  ADD COLUMN IF NOT EXISTS price_30d_avg numeric;

ALTER TABLE public.listings_snapshots
  ADD COLUMN IF NOT EXISTS price_7d_avg numeric,
  ADD COLUMN IF NOT EXISTS price_14d_avg numeric,
  ADD COLUMN IF NOT EXISTS price_30d_avg numeric;

CREATE TABLE IF NOT EXISTS public.price_forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id text NOT NULL,
  city text NOT NULL,
  window_label text NOT NULL CHECK (window_label IN ('7d','14d','30d')),
  avg_price numeric,
  min_price numeric,
  max_price numeric,
  window_start date NOT NULL,
  window_end date NOT NULL,
  scraped_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_forecasts_vehicle ON public.price_forecasts(vehicle_id, scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_forecasts_city_window ON public.price_forecasts(city, window_label, scraped_at DESC);

ALTER TABLE public.price_forecasts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read forecasts" ON public.price_forecasts FOR SELECT USING (true);
CREATE POLICY "public write forecasts" ON public.price_forecasts FOR INSERT WITH CHECK (true);