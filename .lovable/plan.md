

## Pivot: Stop fighting Docker, run discovery directly on the VPS host

The current loop is stuck because `discover-xhr.mjs` keeps not landing inside the container image (Docker build cache, wrong host path, or file never `scp`'d). We've burned many turns on this. Let's bypass Docker entirely for the discovery step, and at the same time prepare two parallel fallback strategies so we're not blocked on any single approach.

## Three parallel tracks

### Track A — Run discovery on the VPS host (no Docker)
Discovery is a one-shot diagnostic, not a recurring job. It does not need to live in the container.

1. Install Node + Playwright directly on the VPS in a temp dir.
2. Write `discover-xhr.mjs` directly on the VPS via heredoc (no `scp`, no Docker copy, no build cache).
3. Run it against Turo through the ScraperAPI proxy already configured.
4. Capture the artifact JSON to `/opt/turo-scraper/artifacts-host/`.

This eliminates every failure mode we've hit (missing file in image, build cache, copy path errors).

### Track B — Capture real Turo traffic from a regular browser (most reliable)
If Playwright on the VPS also gets challenged, we capture the API shape from a real human session:

1. User opens Turo search in Chrome on their own laptop.
2. DevTools → Network → filter `api` → right-click → "Save all as HAR".
3. Upload the HAR file; we parse it to extract: endpoint URL, method, headers (especially `x-csrf-token`, cookies, `apikey`-style headers), and request/response shape.
4. Rewrite `scraper.mjs` to replay that exact request through ScraperAPI.

This is how production-grade scrapers are typically built and it sidesteps Cloudflare entirely for the discovery phase.

### Track C — Switch scraping strategy if Turo's API is locked behind session tokens
If the captured request requires short-lived session tokens (CSRF, signed cookies), shift the scraper from "headless API call" to one of:

- **ScraperAPI with `render=true` + `premium=true`** — lets ScraperAPI handle Cloudflare and return rendered HTML; we parse the embedded `__NEXT_DATA__` / SSR JSON instead of calling the API.
- **Public sitemap + vehicle detail pages** — Turo exposes vehicle pages at stable URLs; scrape listings via `/sitemap.xml` then fetch each vehicle page (lower volume, lower block rate).
- **Third-party data source** — e.g. RVshare-style aggregators or unofficial Turo data APIs on RapidAPI as a stopgap.

## Execution order (once you approve)

1. **Track A first (10 min):** install Node on host, run discovery, see what comes back.
2. **If Track A is blocked by Cloudflare:** ask you to capture a HAR from your browser (Track B).
3. **Based on the HAR contents, pick Track C variant** and rewrite `scraper.mjs` accordingly.
4. **Re-bake the working scraper into Docker** as the final step (only after we know what works).

## Technical details

- VPS host commands will use `apt install -y nodejs npm && npm i -g playwright && npx playwright install --with-deps chromium`, then a self-contained `discover-xhr.mjs` written via heredoc to `/opt/turo-scraper/discover-xhr.mjs` and run with `node discover-xhr.mjs --auto-headless --proxy "$SCRAPER_PROXY"`.
- Output written to `/opt/turo-scraper/artifacts-host/turo-xhr-*.json`; you'll `cat` and paste it.
- HAR parsing (Track B) will be done with a small Node script that filters entries where `request.url` matches `turo.com/api/` and emits a curl-equivalent + a Playwright `request.post` snippet.
- Final scraper rewrite will live in `vps-scraper/scraper.mjs`; Dockerfile already has `COPY *.mjs ./` so subsequent rebuilds will pick it up.

## What I need from you

Reply with which track to start with — my recommendation is **Track A now, Track B in parallel** (you can start capturing the HAR while I prep the host install script). If Track A succeeds we may not need B at all.

