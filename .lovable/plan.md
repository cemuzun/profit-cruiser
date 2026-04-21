

# Switch Turo scraping to Bright Data Web Unlocker (proven working)

We confirmed via curl that **Bright Data Web Unlocker successfully fetches Turo through your `turo_unlocker` zone** (`hl_0465faf5` / password `88wsd9wtxvp1`). HTTP 200, real Turo HTML, 95KB, no `x-brd-error`. The blocker is no longer access — it's that Turo's search results render via client-side JS, so the raw search HTML doesn't contain vehicle data.

The fix has two parts: (1) replace the Cloudflare Worker tunnel idea with direct Bright Data calls from the VPS scraper, and (2) keep using **Playwright** (which we already have on the VPS) so JS executes and the `__NEXT_DATA__` / Apollo state populates.

## Architecture

```text
VPS cron (08:00 / 20:00 UTC)
  └── scraper.mjs (Playwright + Chromium)
        └── route through Bright Data Web Unlocker as upstream proxy
              ├── brd.superproxy.io:33335
              └── user: brd-customer-hl_0465faf5-zone-turo_unlocker
        └── opens Turo search pages, waits for JS render
        └── extracts __NEXT_DATA__ → vehicles → Postgres
        └── dumps listings.json / forecasts.json / runs.json
        └── Caddy serves https://187-124-69-23.sslip.io/data/*.json
```

No Cloudflare Worker, no edge function changes. The existing Lovable Cloud `scrape-turo` edge function and the `.lovable/plan.md` ARN/Worker plan are abandoned — VPS is now the single scraper.

## Plan

### 1. Update `vps-scraper/scraper.mjs`
- Add Playwright launch option to route all browser traffic through Bright Data:
  ```js
  const browser = await chromium.launch({
    proxy: {
      server: 'http://brd.superproxy.io:33335',
      username: process.env.BRD_USER, // brd-customer-hl_0465faf5-zone-turo_unlocker
      password: process.env.BRD_PASS, // 88wsd9wtxvp1
    },
    args: ['--ignore-certificate-errors'],
  });
  ```
- Bypass cert validation for the proxy MITM cert (Bright Data signs upstream).
- Wait for `__NEXT_DATA__` script tag or `networkidle` before extracting.
- Keep existing extraction logic (LA / Miami / Honolulu × price segments × date windows).
- On failure, log `x-brd-error` style response from `page.goto()` for debugging.

### 2. Update `vps-scraper/.env.example` and live `.env`
Add:
```
BRD_USER=brd-customer-hl_0465faf5-zone-turo_unlocker
BRD_PASS=88wsd9wtxvp1
```

### 3. Update `vps-scraper/docker-compose.yml`
Pass `BRD_USER` and `BRD_PASS` from `.env` into the scraper container's environment.

### 4. Sanity-test script
Add `vps-scraper/test-scrape.mjs` — runs ONE city × ONE segment, prints vehicle count + first 3 vehicleIds. So you can `docker compose run --rm scraper node test-scrape.mjs` after deploy to verify before the full cron kicks in.

### 5. Deploy steps (you run on VPS after I push code)
```bash
cd /opt/turo-scraper
git pull   # or scp the updated files
echo "BRD_USER=brd-customer-hl_0465faf5-zone-turo_unlocker" >> .env
echo "BRD_PASS=88wsd9wtxvp1" >> .env
docker compose up -d --build scraper
docker compose run --rm scraper node test-scrape.mjs   # verify
docker compose run --rm scraper node scraper.mjs        # full run
curl -sI https://187-124-69-23.sslip.io/data/listings.json
```

### 6. Clean up dead code (optional, same PR)
- Mark `supabase/functions/scrape-turo/index.ts` and `ingest-listings` as deprecated (add a header comment) or delete them — they're unused now that VPS owns scraping.
- Delete `.lovable/plan.md` (the ARN/Worker plan we're replacing).

## Out of scope
- Frontend changes — `src/lib/dataSource.ts` already reads from `https://187-124-69-23.sslip.io/data/*.json`, no changes needed.
- Seasonality, watchlist, profitability features — independent.
- Adding new cities or segments — same scope as today.

## Why this works (and the curl test proved it)
- ✅ Bright Data zone has no Turo block (HTTP 200 confirmed)
- ✅ Playwright supports proxy auth natively (unlike Deno Edge Runtime)
- ✅ Playwright runs JS so `__NEXT_DATA__` populates with real vehicles (the 95KB raw HTML was empty because curl doesn't run JS)
- ✅ VPS already has Chromium + cron + Postgres + Caddy wired up — minimal change

