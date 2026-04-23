ALTER TABLE public.listings_current ADD COLUMN IF NOT EXISTS listing_url text;
ALTER TABLE public.listings_snapshots ADD COLUMN IF NOT EXISTS listing_url text;