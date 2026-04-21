

# Use ARN ISP proxies for Turo scraping

ARN sells **rotating ISP proxies** with a standard `http://user:pass@host:port` endpoint (same format as Bright Data / Smartproxy). As we discovered earlier, the Supabase Edge Runtime's `Deno.createHttpClient({ proxy })` is silently ignored — so a raw HTTP proxy can't be tunneled from inside the edge function. We need a thin **proxy-tunneling layer** between the edge function and ARN.

The cleanest fix that keeps using your ARN subscription (no new vendor): run a tiny **Cloudflare Worker** as the tunnel. The edge function `fetch`es the Worker; the Worker forwards through ARN to Turo and streams the response back. Workers fully support proxy `fetch` via a sub-request library, are free up to 100k req/day, and deploy in ~2 minutes.

## Architecture

```text
Edge Function (Supabase)
  └── fetch https://<your-worker>.workers.dev?url=<turo>
        └── Worker → ARN ISP proxy (user:pass@host:port) → turo.com
              └── JSON response streamed back
```

## Plan

### 1. Cloudflare Worker (you deploy, ~2 min)
- I'll give you a ready-to-paste `worker.js` (~40 lines) using `fetch` + `https-proxy-agent` (via `nodejs_compat`).
- It accepts `?url=<encoded turo URL>`, validates a shared secret header, forwards through `ARN_PROXY_URL`, returns the upstream JSON.
- You set 2 Worker secrets in the Cloudflare dashboard:
  - `ARN_PROXY_URL` — your ARN endpoint (`http://user:pass@gate.arnproxy.com:port`)
  - `TUNNEL_SECRET` — random string, also stored in Lovable Cloud
- Deploy via Cloudflare dashboard (copy/paste, no CLI needed). You'll get a URL like `https://turo-tunnel.<you>.workers.dev`.

### 2. Lovable Cloud secrets
Add two new runtime secrets:
- `TURO_TUNNEL_URL` — your Worker URL
- `TURO_TUNNEL_SECRET` — same random string as above

(The previously-added `TURO_PROXY_URL` becomes unused — we can leave it or remove it.)

### 3. Update `scrape-turo` edge function
- Remove the dead `Deno.createHttpClient` proxy code.
- New `fetchSegment` builds the Turo URL as before, then calls:
  `fetch(`${TUNNEL_URL}?url=${encodeURIComponent(turoUrl)}`, { headers: { 'x-tunnel-secret': SECRET, ...browserHeaders } })`
- All headers (UA, Accept, Referer, etc.) are forwarded by the Worker to Turo.
- Same parsing, same upsert logic, same background `EdgeRuntime.waitUntil`.

### 4. Sanity test
- Add a quick "Test scraper" button on `/settings` (or reuse the Dashboard one) that runs against just LA with 1 segment so you can confirm the tunnel works before the full deep scan kicks off.
- Surface the result count + any error from the latest `scrape_runs` row.

## What I need from you to start
After you approve, I'll:
1. Hand you the exact Worker code + step-by-step Cloudflare deploy instructions (5 screenshots' worth of clicks).
2. Once you paste the Worker URL + secret back, request `TURO_TUNNEL_URL` and `TURO_TUNNEL_SECRET` via the secret tool.
3. Update the edge function and trigger a test scrape.

## Why not other options
- **Direct from edge function**: already proven blocked (403) and proxy config ignored.
- **Switch to Firecrawl/ScrapingBee**: works but you'd pay twice (you already have ARN).
- **Self-host a Node proxy on Render/Fly**: works but more setup than a Worker and costs money after free tier.

## Out of scope
- Changing the scraping target/segments — same deep-scan logic.
- Touching seasonality/compare features — independent.

