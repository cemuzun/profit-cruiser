ALTER TABLE public.scrape_filters
  ADD COLUMN IF NOT EXISTS min_trips integer,
  ADD COLUMN IF NOT EXISTS min_rating numeric,
  ADD COLUMN IF NOT EXISTS fuel_types text[] NOT NULL DEFAULT ARRAY[]::text[];