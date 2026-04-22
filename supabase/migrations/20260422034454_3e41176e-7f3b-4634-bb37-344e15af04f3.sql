-- Cities table
create table if not exists public.cities (
  slug text primary key,
  name text not null,
  country text not null default 'US',
  region text,
  latitude numeric not null,
  longitude numeric not null,
  place_id text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.cities enable row level security;

create policy "public read cities" on public.cities for select using (true);
create policy "public write cities" on public.cities for all using (true) with check (true);

insert into public.cities (slug, name, country, region, latitude, longitude, place_id) values
  ('los-angeles', 'Los Angeles', 'US', 'CA', 34.0549076, -118.242643, 'ChIJE9on3F3HwoAR9AhGJW_fL-I'),
  ('miami', 'Miami', 'US', 'FL', 25.7616798, -80.1917902, 'ChIJEcHIDqKw2YgRZU-t3XHylv8'),
  ('honolulu', 'Honolulu', 'US', 'HI', 21.3098845, -157.8581401, 'ChIJTUbU9o9rAHwR_lMnUydM3qg')
on conflict (slug) do nothing;

-- Cron: daily scrape of every active city at 09:00 UTC
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Drop existing job if re-running
do $$
begin
  if exists (select 1 from cron.job where jobname = 'turo-daily-scrape') then
    perform cron.unschedule('turo-daily-scrape');
  end if;
end $$;

select cron.schedule(
  'turo-daily-scrape',
  '0 9 * * *',
  $$
  select net.http_post(
    url := 'https://cxvcyhlkybtooxmhzqej.supabase.co/functions/v1/scrape-turo',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('all', true)
  );
  $$
);