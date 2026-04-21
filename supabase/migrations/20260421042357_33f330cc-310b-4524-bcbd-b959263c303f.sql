
SELECT cron.schedule(
  'turo-daily-scrape',
  '0 9 * * *',
  $$
  SELECT net.http_post(
    url := 'https://cxvcyhlkybtooxmhzqej.supabase.co/functions/v1/scrape-turo',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"cities": ["los-angeles", "miami"]}'::jsonb
  ) AS request_id;
  $$
);
