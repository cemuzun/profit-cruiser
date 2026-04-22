ALTER TABLE public.cost_assumptions_global
  ADD COLUMN IF NOT EXISTS default_avg_miles_per_day numeric;

ALTER TABLE public.cost_overrides
  ADD COLUMN IF NOT EXISTS avg_miles_per_day numeric;