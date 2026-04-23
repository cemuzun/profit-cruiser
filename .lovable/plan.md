

## Reset: delete all scraping code, start clean

You're right — let's wipe the slate. Here's exactly what gets removed and what remains.

### Delete

**Edge functions** (removed from codebase + undeployed from Lovable Cloud):
- `supabase/functions/scrape-turo/`
- `supabase/functions/turo-pricing/`
- `supabase/functions/cargurus-price/`

**VPS scraper folder** (entire directory):
- `vps-scraper/` — Dockerfile, scraper.mjs, queue-worker.mjs, discover-xhr.mjs, schema.sql, Caddyfile, all debug/test scripts, README

**Stale plan file**:
- `.lovable/plan.md` (the Track A/B/C VPS pivot doc)

### Keep

- All database tables (`listings_current`, `listings_snapshots`, `price_forecasts`, `scrape_runs`, `watchlist`, `cities`, cost tables) — schema stays so we can repopulate later
- All frontend pages (`Dashboard`, `Analyzer`, `Compare`, `CarDetail`, `Watchlist`, `Seasonality`, `Settings`) — they read from the DB and keep working with whatever data is there
- `src/lib/dataSource.ts`, `profitability.ts`, `seasonality.ts` and the hooks — these are pure read/calc logic, not scrapers
- Secrets in Lovable Cloud (`ZYTE_API_KEY`, `APIFY_API_TOKEN`, `TURO_PROXY_URL`, `GEONIX_PROXY_URL`, `FIRECRAWL_API_KEY`) — left in place; you can prune later from Connectors if you want

### Frontend cleanup

Any "Scrape now" button or call to `supabase.functions.invoke('scrape-turo' | 'turo-pricing' | 'cargurus-price')` will be removed or stubbed so the UI doesn't 404. I'll grep for invocations and clean them up in the same pass.

### After this

You'll have a clean app with empty/stale data tables, zero scraping code, and zero deployed scraping functions. From there we design the new ingestion approach from scratch — no assumptions carried over.

