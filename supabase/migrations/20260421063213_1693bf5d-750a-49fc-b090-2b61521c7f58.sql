ALTER TABLE public.cost_overrides
  ADD COLUMN IF NOT EXISTS acquisition_mode text,
  ADD COLUMN IF NOT EXISTS lease_monthly numeric,
  ADD COLUMN IF NOT EXISTS lease_down numeric,
  ADD COLUMN IF NOT EXISTS lease_term_months integer,
  ADD COLUMN IF NOT EXISTS mileage_cap_monthly integer,
  ADD COLUMN IF NOT EXISTS mileage_overage_per_mi numeric,
  ADD COLUMN IF NOT EXISTS avg_miles_per_trip numeric;

ALTER TABLE public.cost_overrides
  ADD CONSTRAINT cost_overrides_acquisition_mode_check
  CHECK (acquisition_mode IS NULL OR acquisition_mode IN ('buy','lease'));

ALTER TABLE public.cost_assumptions_global
  ADD COLUMN IF NOT EXISTS default_acquisition_mode text NOT NULL DEFAULT 'buy',
  ADD COLUMN IF NOT EXISTS default_lease_monthly numeric NOT NULL DEFAULT 450,
  ADD COLUMN IF NOT EXISTS default_lease_down numeric NOT NULL DEFAULT 3000,
  ADD COLUMN IF NOT EXISTS default_lease_term_months integer NOT NULL DEFAULT 36,
  ADD COLUMN IF NOT EXISTS default_mileage_cap_monthly integer NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS default_mileage_overage_per_mi numeric NOT NULL DEFAULT 0.25,
  ADD COLUMN IF NOT EXISTS default_avg_miles_per_trip numeric NOT NULL DEFAULT 80;

ALTER TABLE public.cost_assumptions_global
  ADD CONSTRAINT cost_assumptions_global_default_mode_check
  CHECK (default_acquisition_mode IN ('buy','lease'));