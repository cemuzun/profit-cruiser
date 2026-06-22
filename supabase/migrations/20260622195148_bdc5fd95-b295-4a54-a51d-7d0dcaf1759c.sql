DELETE FROM public.listing_calendar_days WHERE city <> 'miami';
DELETE FROM public.price_anomalies WHERE city <> 'miami';
DELETE FROM public.price_forecasts WHERE city <> 'miami';
DELETE FROM public.listings_snapshots WHERE city <> 'miami';
DELETE FROM public.listings_current WHERE city <> 'miami';