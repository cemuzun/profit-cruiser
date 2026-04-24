CREATE TABLE public.price_anomalies (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  vehicle_id text NOT NULL,
  city text,
  make text,
  model text,
  year integer,
  attempted_price numeric,
  previous_price numeric,
  kept_price numeric,
  reason text NOT NULL,
  source text,
  listing_url text,
  detected_at timestamp with time zone NOT NULL DEFAULT now(),
  reviewed boolean NOT NULL DEFAULT false,
  reviewed_at timestamp with time zone
);

CREATE INDEX idx_price_anomalies_detected_at ON public.price_anomalies (detected_at DESC);
CREATE INDEX idx_price_anomalies_vehicle ON public.price_anomalies (vehicle_id);
CREATE INDEX idx_price_anomalies_reviewed ON public.price_anomalies (reviewed);

ALTER TABLE public.price_anomalies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read price_anomalies" ON public.price_anomalies FOR SELECT USING (true);
CREATE POLICY "public write price_anomalies" ON public.price_anomalies FOR ALL USING (true) WITH CHECK (true);