# Turo scraper — VPS edition

Self-contained Docker stack: **Postgres + Playwright scraper + Caddy** running on your Hostinger VPS (`187.124.69.23`). Scrapes Turo (LA / Miami / Honolulu) every 12h, dumps JSON to disk, Caddy serves it over HTTPS via `sslip.io` (auto-cert, no domain needed). The React app fetches that JSON.

## What it does

- Cron at **08:00 and 20:00 UTC** runs `scraper.mjs`
- Headless Chromium opens Turo search pages for each city × price-segment × vehicle-type × date-window (now / +7d / +14d / +30d), extracts vehicles from the embedded `__NEXT_DATA__` / `apolloState` JSON
- Writes to local Postgres (`listings_current`, `listings_snapshots`, `price_forecasts`, `scrape_runs`)
- Then dumps `listings.json`, `forecasts.json`, `runs.json` into `./data/` (mounted to Caddy's web root)
- Caddy serves `https://187-124-69-23.sslip.io/data/*.json` with permissive CORS

## One-time setup on the VPS

```bash
# SSH in
ssh root@187.124.69.23

# Install Docker if not already (Hostinger Ubuntu 24.04 + Docker template usually has it)
docker --version || curl -fsSL https://get.docker.com | sh

# Get the code (option A: scp from your machine; option B: git)
mkdir -p /opt/turo-scraper && cd /opt/turo-scraper
# scp -r vps-scraper/* root@187.124.69.23:/opt/turo-scraper/

# First boot: build images + start containers
docker compose up -d --build

# Verify Caddy got a cert (takes ~30s on first start)
docker compose logs caddy | grep -i "certificate obtained"

# Run an immediate scrape to populate data
docker compose run --rm scraper node scraper.mjs

# Verify JSON files exist and are reachable
ls -lh data/
curl -sI https://187-124-69-23.sslip.io/data/listings.json | head -3
```

## Cron

Cron lives **inside the scraper container** (`crond` runs in the foreground). Schedule is baked into `crontab` — see that file. To change it, edit, then `docker compose restart scraper`.

To run an ad-hoc scrape:
```bash
docker compose exec scraper node scraper.mjs
```

## Logs

```bash
docker compose logs -f scraper      # scraper output
docker compose logs -f caddy        # web server
docker compose exec postgres psql -U turo -d turo -c "select id, city, status, vehicles_count, started_at from scrape_runs order by started_at desc limit 10;"
```

## Frontend

Set `VITE_DATA_BASE_URL` in your Lovable project to:
```
https://187-124-69-23.sslip.io
```
(no trailing slash). The frontend fetches `${VITE_DATA_BASE_URL}/data/listings.json` etc.

## Firewall

Open ports **80** and **443** in the Hostinger panel:
```bash
ufw allow 80
ufw allow 443
```

## Files

- `docker-compose.yml` — postgres, scraper, caddy
- `Dockerfile.scraper` — Node 20 + Playwright + cron
- `Caddyfile` — auto-HTTPS via sslip.io, CORS, serves `/data/`
- `schema.sql` — Postgres tables (mirrors what was in Lovable Cloud)
- `scraper.mjs` — Playwright scraper, dumps JSON at the end
- `crontab` — `0 8,20 * * *` runs scraper.mjs
- `.env.example` — copy to `.env`, set `POSTGRES_PASSWORD`
