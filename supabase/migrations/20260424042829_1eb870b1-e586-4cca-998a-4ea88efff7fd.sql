CREATE TABLE public.scrape_filters (
  id integer PRIMARY KEY DEFAULT 1,
  vehicle_types text[] NOT NULL DEFAULT ARRAY[]::text[],
  min_daily_price numeric,
  max_daily_price numeric,
  min_year integer,
  max_year integer,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scrape_filters_singleton CHECK (id = 1)
);

ALTER TABLE public.scrape_filters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read scrape_filters" ON public.scrape_filters FOR SELECT USING (true);
CREATE POLICY "public write scrape_filters" ON public.scrape_filters FOR ALL USING (true) WITH CHECK (true);

INSERT INTO public.scrape_filters (id) VALUES (1) ON CONFLICT (id) DO NOTHING;