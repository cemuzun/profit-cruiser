-- Fix scrape cron jobs to explicitly pass all cities (LA, Miami, Honolulu)
-- and consolidate to a single 12-hour schedule.
SELECT cron.unschedule('turo-daily-scrape');
SELECT cron.unschedule('scrape-turo-every-12h');

SELECT cron.schedule(
  'scrape-turo-every-12h',
  '0 8,20 * * *',
  $$
  SELECT net.http_post(
    url := 'https://cxvcyhlkybtooxmhzqej.supabase.co/functions/v1/scrape-turo',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN4dmN5aGxreWJ0b294bWh6cWVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3MzgzNjgsImV4cCI6MjA5MjMxNDM2OH0.jdHpncg9cwetGL4IKHH4Gx0c7i2AU7b1Clx52BBxk8Y"}'::jsonb,
    body := '{"cities":["los-angeles","miami","honolulu"]}'::jsonb
  ) AS request_id;
  $$
);