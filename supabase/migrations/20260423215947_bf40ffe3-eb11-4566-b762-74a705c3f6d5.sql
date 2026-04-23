UPDATE public.scrape_runs
SET status = 'timeout',
    finished_at = now(),
    error_message = COALESCE(error_message, 'abandoned (stuck running)')
WHERE status = 'running'
  AND started_at < now() - interval '10 minutes';