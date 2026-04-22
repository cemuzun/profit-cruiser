// Turo scraper — runs inside the Docker container on the VPS.
// 1. For each city × price-segment × vehicle-type × date-window, opens a
//    Turo search URL with stealth Playwright (real Chromium + anti-detection).
// 2. Intercepts Turo's internal XHR/fetch API responses to extract vehicle JSON directly.
// 3. Aggregates per-vehicle prices across windows (now / +7d / +14d / +30d).
// 4. Writes to Postgres (listings_current / listings_snapshots / price_forecasts / scrape_runs).
// 5. Dumps listings.json, forecasts.json, runs.json into DATA_DIR for nginx/Caddy to serve.

import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import pg from "pg";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// Apply stealth plugin — patches ~20 fingerprinting vectors Turo checks
chromium.use(stealthPlugin());

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const DATA_DIR = process.env.DATA_DIR || "/data";
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

// ---------- City catalog (matches what the previous edge function used) ----------
const CITIES = {
  "los-angeles": {
    country: "US", name: "Los Angeles",
    lat: 34.0549076, lng: -118.242643,
    region: "CA", placeId: "ChIJE9on3F3HwoAR9AhGJW_fL-I",
  },
  "miami": {
    country: "US", name: "Miami",
    lat: 25.7616798, lng: -80.1917902,
    region: "FL", placeId: "ChIJEcHIDqKw2YgRZU-t3XHylv8",
  },
  "honolulu": {
    country: "US", name: "Honolulu",
    lat: 21.3098845, lng: -157.8581401,
    region: "HI", placeId: "ChIJTUbU9o9rAHwR_lMnUydM3qg",
  },
};

// Slimmer than the edge function — Playwright is slower per page so trade
// breadth for completion. Still gives ~30 segments per city.
const PRICE_SEGMENTS = [
  [0, 50], [50, 80], [80, 120], [120, 180], [180, 280], [280, 1000],
];
const VEHICLE_TYPES = [null, "CAR", "SUV", "MINIVAN", "TRUCK"];
const WINDOWS = [
  { key: "now",  offsetDays: 1,  spanDays: 3, label: "Now" },
  { key: "7d",   offsetDays: 7,  spanDays: 3, label: "+7d" },
  { key: "14d",  offsetDays: 14, spanDays: 3, label: "+14d" },
  { key: "30d",  offsetDays: 30, spanDays: 3, label: "+30d" },
];

// ---------- URL builder ----------
function isoDate(d) { return d.toISOString().slice(0, 10); }

function buildSearchUrl(city, win, minP, maxP, vehicleType) {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + win.offsetDays);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + win.spanDays);

  const params = new URLSearchParams({
    age: "30",
    country: city.country,
    defaultZoomLevel: "11",
    isMapSearch: "false",
    itemsPerPage: "200",
    latitude: String(city.lat),
    location: city.name,
    locationType: "CITY",
    longitude: String(city.lng),
    pickupType: "ALL",
    placeId: city.placeId,
    region: city.region,
    searchDurationType: "DAILY",
    sortType: "RELEVANCE",
    pickupDate: isoDate(start),
    pickupTime: "10:00",
    dropoffDate: isoDate(end),
    dropoffTime: "10:00",
  });
  if (minP !== undefined) params.set("minDailyPriceUSD", String(minP));
  if (maxP !== undefined) params.set("maxDailyPriceUSD", String(maxP));
  if (vehicleType) params.set("types", vehicleType);
  return `https://turo.com/us/en/search?${params.toString()}`;
}

// ---------- Extraction ----------
// Turo embeds search results in a script tag (Apollo state / Next data). We
// also fall back to scraping anchor cards if the JSON shape changes.
async function extractVehicles(page) {
  return await page.evaluate(() => {
    const out = [];

    function pushFromAny(node) {
      if (!node || typeof node !== "object") return;
      // Heuristic: Turo vehicle objects have id + dailyPriceWithCurrency or avgDailyPrice
      const id = node.id ?? node.vehicleId ?? node.vehicle?.id;
      // avgDailyPrice can be { amount, currency } (object) or a plain number
      const rawPrice = node.avgDailyPrice ?? node.dailyPrice ?? node.dailyPriceWithCurrency ?? node.dailyPricing?.dailyPrice ?? node.price;
      const price = (rawPrice && typeof rawPrice === "object") ? rawPrice.amount : rawPrice;
      const make = node.make ?? node.vehicle?.make ?? node.makeName;
      const model = node.model ?? node.vehicle?.model ?? node.modelName;
      if (id && price && (make || model)) {
        out.push({
          vehicle_id: String(id),
          make: make ?? null,
          model: model ?? null,
          year: Number(node.year ?? node.vehicle?.year) || null,
          trim: node.trim ?? node.vehicle?.trim ?? null,
          vehicle_type: node.type ?? node.seoCategory ?? node.vehicle?.type ?? null,
          fuel_type: node.fuelType ?? node.vehicle?.fuelType ?? null,
          avg_daily_price: Number(price) || null,
          completed_trips: Number(node.completedTrips ?? node.numberOfTrips ?? node.tripsTaken) || 0,
          rating: Number(node.rating ?? node.hostRating ?? node.avgRating) || null,
          is_all_star_host: Boolean(node.isAllStarHost ?? node.host?.isAllStarHost),
          host_name: node.hostName ?? node.host?.firstName ?? null,
          image_url:
            node.images?.[0]?.originalImageUrl ??
            node.images?.[0]?.url ??
            node.imageUrls?.[0] ??
            node.image?.originalImageUrl ??
            null,
          location_city: node.location?.city ?? node.locationCity ?? null,
          location_state: node.location?.state ?? node.locationState ?? null,
        });
      }
    }

    function walk(v, depth = 0) {
      if (depth > 8 || v == null) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      if (typeof v === "object") {
        pushFromAny(v);
        for (const k in v) walk(v[k], depth + 1);
      }
    }

    // Try Next.js data
    const nextEl = document.getElementById("__NEXT_DATA__");
    if (nextEl) {
      try { walk(JSON.parse(nextEl.textContent)); } catch (_) {}
    }
    // Try Apollo / window state
    if (window.__APOLLO_STATE__) walk(window.__APOLLO_STATE__);
    if (window.__INITIAL_STATE__) walk(window.__INITIAL_STATE__);

    // Dedup by id (we may have walked the same node twice)
    const seen = new Set();
    return out.filter(v => {
      if (seen.has(v.vehicle_id)) return false;
      seen.add(v.vehicle_id);
      return true;
    });
  });
}

// ---------- Vehicle data extractor ----------
// Normalises raw vehicle objects from Turo's API JSON into our DB shape.
// Turo's real API returns avgDailyPrice as { amount: number, currency: string }.
function normaliseVehicle(node) {
  if (!node || typeof node !== "object") return null;
  const id = node.id ?? node.vehicleId ?? node.vehicle?.id;
  // Handle nested price objects: { amount, currency } or plain numbers
  const rawPrice =
    node.avgDailyPrice ??
    node.dailyPrice ??
    node.dailyPriceWithCurrency ??
    node.dailyPricing?.dailyPrice ??
    node.price;
  const price = (rawPrice && typeof rawPrice === "object") ? rawPrice.amount : rawPrice;
  const make = node.make ?? node.vehicle?.make ?? node.makeName;
  const model = node.model ?? node.vehicle?.model ?? node.modelName;
  if (!id || !price || (!make && !model)) return null;
  return {
    vehicle_id: String(id),
    make: make ?? null,
    model: model ?? null,
    year: Number(node.year ?? node.vehicle?.year) || null,
    trim: node.trim ?? node.vehicle?.trim ?? null,
    vehicle_type: node.type ?? node.seoCategory ?? node.vehicleType ?? node.vehicle?.type ?? null,
    fuel_type: node.fuelType ?? node.vehicle?.fuelType ?? null,
    avg_daily_price: Number(price) || null,
    completed_trips: Number(node.completedTrips ?? node.numberOfTrips ?? node.tripsTaken) || 0,
    rating: Number(node.rating ?? node.hostRating ?? node.avgRating) || null,
    is_all_star_host: Boolean(node.isAllStarHost ?? node.host?.isAllStarHost),
    host_name: node.hostName ?? node.host?.firstName ?? null,
    image_url:
      node.images?.[0]?.originalImageUrl ??
      node.images?.[0]?.url ??
      node.imageUrls?.[0] ??
      node.image?.originalImageUrl ??
      null,
    location_city: node.location?.city ?? node.locationCity ?? null,
    location_state: node.location?.state ?? node.locationState ?? null,
  };
}

// Walk a JSON tree and collect all vehicle-shaped nodes.
function extractFromJson(root) {
  const out = [];
  const seen = new Set();
  function walk(v, depth = 0) {
    if (depth > 10 || v == null) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === "object") {
      const n = normaliseVehicle(v);
      if (n && !seen.has(n.vehicle_id)) { seen.add(n.vehicle_id); out.push(n); }
      for (const k in v) walk(v[k], depth + 1);
    }
  }
  walk(root);
  return out;
}

// ---------- Browser launch args ----------
const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
];

// ---------- Proxy pool ----------

// Format: HOST:PORT:USERNAME:PASSWORD  (comma-separated)
// Primary = direct VPS IP (no proxy). Proxies are fallback only.
const PROXIES = (process.env.PROXY_LIST || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(entry => {
    const [host, port, username, password] = entry.split(":");
    return { server: `http://${host}:${port}`, username, password };
  });

if (PROXIES.length > 0) {
  console.log(`Proxy pool: ${PROXIES.length} residential proxies loaded as fallback.`);
}

let proxyIndex = 0; // round-robin counter

// ---------- Core page fetch (one attempt with a given proxy config) ----------
// Strategy (hybrid):
//   1. Navigate to the Turo search page and intercept all API responses.
//   2. Turo's React fires /api/v2/search → Cloudflare often 403s it.
//   3. CF challenge scripts run & solve automatically (~5-10s).
//   4. If no successful search XHR was intercepted after the challenge,
//      we manually retry the API call from the page context — now the
//      CF cookies/tokens are valid so it succeeds.
async function fetchWithContext(browser, url, proxyConfig) {
  const ctxOptions = { viewport: { width: 1280, height: 800 } };
  if (proxyConfig) ctxOptions.proxy = proxyConfig;
  const ctx = await browser.newContext(ctxOptions);
  const page = await ctx.newPage();
  try {
    const t0 = Date.now();
    const via = proxyConfig ? `proxy ${proxyConfig.server}` : "direct";

    // Track both successful interceptions and the search API URL that Turo uses
    let interceptedData = null;
    let interceptedUrl = null;
    let searchApiUrl = null;       // the URL Turo's JS tried (even if 403)
    let challengeSolved = false;   // CF challenge completed

    page.on("response", async (resp) => {
      const rUrl = resp.url();
      const status = resp.status();
      const ct = resp.headers()["content-type"] || "";

      // Detect the search API URL Turo's JS fires (even if 403)
      if (rUrl.includes("turo.com/api") && rUrl.includes("search") && !rUrl.includes("/makes") && !rUrl.includes("/filters")) {
        if (!searchApiUrl) searchApiUrl = rUrl;
      }

      // Detect Cloudflare challenge completion (oneshot response)
      if (rUrl.includes("challenge-platform") && rUrl.includes("oneshot") && status === 200) {
        challengeSolved = true;
      }

      // Catch successful search JSON responses
      if (
        rUrl.includes("turo.com/api") &&
        rUrl.includes("search") &&
        status === 200 &&
        ct.includes("json")
      ) {
        try {
          const json = await resp.json();
          if (json?.vehicles && !interceptedData) {
            interceptedData = json;
            interceptedUrl = rUrl;
          }
        } catch (_) {}
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Phase 1: Wait up to 15s for a natural successful search XHR
    const pollStart = Date.now();
    while (!interceptedData && Date.now() - pollStart < 15_000) {
      await page.waitForTimeout(500);
    }

    // Phase 2: If no data yet but CF challenge solved, manually retry the API
    if (!interceptedData && challengeSolved) {
      // Build the API URL — use what Turo's JS tried, or construct from the page URL
      const apiEndpoint = searchApiUrl || `https://turo.com/api/v2/search${new URL(url).search}`;
      console.log(`    [${Date.now() - t0}ms] via ${via}: CF challenge solved, retrying API manually...`);

      const result = await page.evaluate(async (endpoint) => {
        try {
          const resp = await fetch(endpoint, {
            credentials: "include",
            headers: {
              "Accept": "application/json, text/plain, */*",
              "Accept-Language": "en-US,en;q=0.9",
            },
          });
          if (!resp.ok) return { status: resp.status, data: null };
          return { status: resp.status, data: await resp.json() };
        } catch (e) {
          return { status: 0, data: null, error: e.message };
        }
      }, apiEndpoint);

      if (result.data?.vehicles) {
        interceptedData = result.data;
        interceptedUrl = apiEndpoint + " (manual retry)";
      }
    }

    // Phase 3: If still no data and challenge not yet solved, wait a bit more
    if (!interceptedData && !challengeSolved) {
      // Wait up to 15 more seconds for challenge to complete
      const cfWaitStart = Date.now();
      while (!challengeSolved && !interceptedData && Date.now() - cfWaitStart < 15_000) {
        await page.waitForTimeout(500);
      }
      // If challenge just solved, retry
      if (!interceptedData && challengeSolved) {
        const apiEndpoint = searchApiUrl || `https://turo.com/api/v2/search${new URL(url).search}`;
        console.log(`    [${Date.now() - t0}ms] via ${via}: late CF solve, retrying API...`);

        const result = await page.evaluate(async (endpoint) => {
          try {
            const resp = await fetch(endpoint, {
              credentials: "include",
              headers: {
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
              },
            });
            if (!resp.ok) return { status: resp.status, data: null };
            return { status: resp.status, data: await resp.json() };
          } catch (e) {
            return { status: 0, data: null, error: e.message };
          }
        }, apiEndpoint);

        if (result.data?.vehicles) {
          interceptedData = result.data;
          interceptedUrl = apiEndpoint + " (late retry)";
        }
      }
    }

    const elapsed = Date.now() - t0;

    if (!interceptedData) {
      console.log(`    [${elapsed}ms] via ${via}: no vehicles obtained (challenge=${challengeSolved}, apiUrl=${searchApiUrl?.split("?")[0] ?? "none"}) → blocked`);
      return { vehicles: [], interceptedCount: 0 };
    }

    // Extract vehicles from the intercepted JSON (top-level `vehicles` array)
    const arr = interceptedData.vehicles ?? interceptedData.list ?? interceptedData.results ?? null;
    let vehicles = Array.isArray(arr) ? extractFromJson(arr) : extractFromJson(interceptedData);

    // Dedup
    const seen = new Set();
    vehicles = vehicles.filter(v => { if (seen.has(v.vehicle_id)) return false; seen.add(v.vehicle_id); return true; });

    console.log(`    [${elapsed}ms] via ${via}: ${vehicles.length} vehicles (totalHits: ${interceptedData.totalHits}) from ${interceptedUrl?.split("?")[0]}`);
    return { vehicles, interceptedCount: 1 };
  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }
}


// ---------- Stealth Playwright fetch with proxy fallback ----------
// 1st try: direct VPS IP (free, fast).
// Proxy fallback only fires when the page is BLOCKED (0 API blobs intercepted),
// NOT when the segment is legitimately empty (API responded but 0 vehicles matched).
async function stealthFetch(browser, url) {
  // Always try direct first
  let directBlocked = false;
  try {
    const { vehicles, interceptedCount } = await fetchWithContext(browser, url, null);
    if (interceptedCount > 0) {
      // API responded — return result whether vehicles is 0 or not.
      // A legitimate empty segment (e.g. $0-50) won't waste proxy requests.
      return vehicles;
    }
    // interceptedCount === 0 means no API calls reached us → IP is blocked
    directBlocked = true;
    console.log(`    Direct blocked (no API intercepted) — trying proxy fallback...`);
  } catch (e) {
    directBlocked = true;
    console.warn(`    Direct attempt failed (${e.message}) — trying proxy fallback...`);
  }

  if (!directBlocked) return [];

  // Proxy fallback — try each proxy once in round-robin
  if (PROXIES.length === 0) {
    console.warn(`    No proxies configured. Returning empty.`);
    return [];
  }

  for (let i = 0; i < PROXIES.length; i++) {
    const proxy = PROXIES[proxyIndex % PROXIES.length];
    proxyIndex = (proxyIndex + 1) % PROXIES.length;
    try {
      const { vehicles, interceptedCount } = await fetchWithContext(browser, url, proxy);
      if (interceptedCount > 0) return vehicles; // proxy worked (even if 0 vehicles)
    } catch (e) {
      console.warn(`    Proxy ${proxy.server} failed: ${e.message}`);
    }
  }

  return [];
}

// ---------- Per-segment scrape ----------
async function scrapeSegment(browser, citySlug, win, minP, maxP, vt) {
  const url = buildSearchUrl(CITIES[citySlug], win, minP, maxP, vt);
  const label = `${citySlug}/${win.key}/${vt ?? "ALL"}/$${minP}-${maxP}`;
  try {
    const vehicles = await stealthFetch(browser, url);
    console.log(`  ${label}: ${vehicles.length} vehicles`);
    return vehicles;
  } catch (e) {
    console.error(`  ${label} FAILED: ${e.message}`);
    return [];
  }
}

// ---------- Per-city orchestration ----------
async function scrapeCity(browser, citySlug) {
  const runIns = await pool.query(
    "insert into scrape_runs (city, status) values ($1, 'running') returning id",
    [citySlug],
  );
  const runId = runIns.rows[0].id;
  console.log(`▶ ${citySlug} (run ${runId})`);

  const vehicles = new Map(); // id -> { base, windows: { key: { sum, count, min, max } } }
  let segmentsOk = 0;
  const errors = [];

  // Limited parallelism to keep memory under 1 GB on KVM 2.
  const tasks = [];
  for (const win of WINDOWS) {
    for (const [minP, maxP] of PRICE_SEGMENTS) {
      for (const vt of VEHICLE_TYPES) {
        tasks.push({ win, minP, maxP, vt });
      }
    }
  }

  // Keep concurrency at 1 — each browser tab uses ~200 MB RAM
  const CONCURRENCY = 1;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < tasks.length) {
        const t = tasks[cursor++];
        try {
          const list = await scrapeSegment(browser, citySlug, t.win, t.minP, t.maxP, t.vt);
          segmentsOk++;
          for (const raw of list) {
            const id = raw.vehicle_id;
            const price = Number(raw.avg_daily_price);
            if (!Number.isFinite(price) || price <= 0) continue;
            let entry = vehicles.get(id);
            if (!entry) {
              entry = {
                base: { ...raw, city: citySlug, currency: "USD" },
                raw,
                windows: {
                  now:  { sum: 0, count: 0, min: Infinity, max: -Infinity },
                  "7d":  { sum: 0, count: 0, min: Infinity, max: -Infinity },
                  "14d": { sum: 0, count: 0, min: Infinity, max: -Infinity },
                  "30d": { sum: 0, count: 0, min: Infinity, max: -Infinity },
                },
              };
              vehicles.set(id, entry);
            }
            const a = entry.windows[t.win.key];
            a.sum += price; a.count += 1;
            if (price < a.min) a.min = price;
            if (price > a.max) a.max = price;
          }
        } catch (e) {
          errors.push(e.message);
        }
      }
    }),
  );

  // Build rows
  const scrapedAt = new Date();
  const currentRows = [], snapshotRows = [], forecastRows = [];
  const avg = a => (a.count ? a.sum / a.count : null);

  for (const entry of vehicles.values()) {
    const w = entry.windows;
    const priceNow = avg(w.now);
    const price7  = avg(w["7d"]);
    const price14 = avg(w["14d"]);
    const price30 = avg(w["30d"]);
    const headline = priceNow ?? price7 ?? price14 ?? price30;

    const common = {
      vehicle_id: entry.base.vehicle_id,
      city: citySlug,
      make: entry.base.make, model: entry.base.model, year: entry.base.year, trim: entry.base.trim,
      vehicle_type: entry.base.vehicle_type, fuel_type: entry.base.fuel_type,
      avg_daily_price: headline,
      currency: "USD",
      price_7d_avg: price7, price_14d_avg: price14, price_30d_avg: price30,
      completed_trips: entry.base.completed_trips ?? 0,
      rating: entry.base.rating,
      is_all_star_host: entry.base.is_all_star_host ?? false,
      host_id: entry.base.host_id ?? null,
      host_name: entry.base.host_name ?? null,
      image_url: entry.base.image_url ?? null,
      location_city: entry.base.location_city ?? null,
      location_state: entry.base.location_state ?? null,
      latitude: null, longitude: null,
    };
    currentRows.push({ ...common, last_scraped_at: scrapedAt, updated_at: scrapedAt });
    snapshotRows.push({ ...common, raw: entry.raw, scraped_at: scrapedAt });

    for (const win of WINDOWS) {
      if (win.key === "now") continue;
      const a = w[win.key];
      if (!a.count) continue;
      const ws = new Date(); ws.setUTCDate(ws.getUTCDate() + win.offsetDays);
      const we = new Date(ws); we.setUTCDate(we.getUTCDate() + win.spanDays);
      forecastRows.push({
        vehicle_id: entry.base.vehicle_id,
        city: citySlug,
        window_label: win.key,
        avg_price: a.sum / a.count,
        min_price: Number.isFinite(a.min) ? a.min : null,
        max_price: Number.isFinite(a.max) ? a.max : null,
        window_start: isoDate(ws),
        window_end: isoDate(we),
        scraped_at: scrapedAt,
      });
    }
  }

  console.log(`${citySlug}: ${currentRows.length} vehicles · ${forecastRows.length} forecast rows · ${segmentsOk}/${tasks.length} segments`);

  await writeBatch(currentRows, snapshotRows, forecastRows);

  await pool.query(
    `update scrape_runs set status=$2, vehicles_count=$3, segments_run=$4, error_message=$5, finished_at=now() where id=$1`,
    [
      runId,
      currentRows.length > 0 ? "success" : (errors.length ? "failed" : "empty"),
      currentRows.length,
      segmentsOk,
      errors.length ? errors.slice(0, 3).join(" | ") : null,
    ],
  );

  return { city: citySlug, vehicles: currentRows.length, forecasts: forecastRows.length };
}

// ---------- DB writes ----------
async function writeBatch(currentRows, snapshotRows, forecastRows) {
  if (snapshotRows.length) {
    for (const r of snapshotRows) {
      await pool.query(
        `insert into listings_snapshots
          (vehicle_id, city, make, model, year, trim, vehicle_type, fuel_type,
           avg_daily_price, currency, price_7d_avg, price_14d_avg, price_30d_avg,
           completed_trips, rating, is_all_star_host, host_id, host_name,
           image_url, location_city, location_state, latitude, longitude, raw, scraped_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
        [
          r.vehicle_id, r.city, r.make, r.model, r.year, r.trim, r.vehicle_type, r.fuel_type,
          r.avg_daily_price, r.currency, r.price_7d_avg, r.price_14d_avg, r.price_30d_avg,
          r.completed_trips, r.rating, r.is_all_star_host, r.host_id, r.host_name,
          r.image_url, r.location_city, r.location_state, r.latitude, r.longitude,
          JSON.stringify(r.raw ?? null), r.scraped_at,
        ],
      );
    }
  }

  if (currentRows.length) {
    for (const r of currentRows) {
      await pool.query(
        `insert into listings_current
          (vehicle_id, city, make, model, year, trim, vehicle_type, fuel_type,
           avg_daily_price, currency, price_7d_avg, price_14d_avg, price_30d_avg,
           completed_trips, rating, is_all_star_host, host_id, host_name,
           image_url, location_city, location_state, latitude, longitude,
           last_scraped_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
         on conflict (vehicle_id) do update set
           city=excluded.city, make=excluded.make, model=excluded.model, year=excluded.year, trim=excluded.trim,
           vehicle_type=excluded.vehicle_type, fuel_type=excluded.fuel_type,
           avg_daily_price=excluded.avg_daily_price, currency=excluded.currency,
           price_7d_avg=excluded.price_7d_avg, price_14d_avg=excluded.price_14d_avg, price_30d_avg=excluded.price_30d_avg,
           completed_trips=excluded.completed_trips, rating=excluded.rating, is_all_star_host=excluded.is_all_star_host,
           host_id=excluded.host_id, host_name=excluded.host_name,
           image_url=excluded.image_url, location_city=excluded.location_city, location_state=excluded.location_state,
           latitude=excluded.latitude, longitude=excluded.longitude,
           last_scraped_at=excluded.last_scraped_at, updated_at=excluded.updated_at`,
        [
          r.vehicle_id, r.city, r.make, r.model, r.year, r.trim, r.vehicle_type, r.fuel_type,
          r.avg_daily_price, r.currency, r.price_7d_avg, r.price_14d_avg, r.price_30d_avg,
          r.completed_trips, r.rating, r.is_all_star_host, r.host_id, r.host_name,
          r.image_url, r.location_city, r.location_state, r.latitude, r.longitude,
          r.last_scraped_at, r.updated_at,
        ],
      );
    }
  }

  if (forecastRows.length) {
    for (const r of forecastRows) {
      await pool.query(
        `insert into price_forecasts
          (vehicle_id, city, window_label, avg_price, min_price, max_price, window_start, window_end, scraped_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [r.vehicle_id, r.city, r.window_label, r.avg_price, r.min_price, r.max_price, r.window_start, r.window_end, r.scraped_at],
      );
    }
  }
}

// ---------- Dump JSON for the frontend ----------
async function dumpJson() {
  await mkdir(DATA_DIR, { recursive: true });

  const listings = (await pool.query(
    `select * from listings_current order by avg_daily_price desc nulls last`,
  )).rows;

  // Forecasts: keep last 90 days so the per-car detail chart can render trends.
  const forecasts = (await pool.query(
    `select vehicle_id, city, window_label, avg_price, min_price, max_price,
            window_start, window_end, scraped_at
       from price_forecasts
      where scraped_at > now() - interval '90 days'
      order by scraped_at`,
  )).rows;

  // Snapshots: last 60 days, slim columns, for trend charts + seasonality.
  const snapshots = (await pool.query(
    `select vehicle_id, city, make, model, year, vehicle_type, fuel_type,
            avg_daily_price, completed_trips, scraped_at
       from listings_snapshots
      where scraped_at > now() - interval '60 days'
      order by scraped_at`,
  )).rows;

  const runs = (await pool.query(
    `select id, city, status, vehicles_count, segments_run, error_message,
            started_at, finished_at
       from scrape_runs
      order by started_at desc
      limit 50`,
  )).rows;

  const meta = {
    generated_at: new Date().toISOString(),
    listings_count: listings.length,
    forecasts_count: forecasts.length,
    snapshots_count: snapshots.length,
  };

  await writeFile(path.join(DATA_DIR, "listings.json"), JSON.stringify(listings));
  await writeFile(path.join(DATA_DIR, "forecasts.json"), JSON.stringify(forecasts));
  await writeFile(path.join(DATA_DIR, "snapshots.json"), JSON.stringify(snapshots));
  await writeFile(path.join(DATA_DIR, "runs.json"), JSON.stringify(runs));
  await writeFile(path.join(DATA_DIR, "meta.json"), JSON.stringify(meta));
  console.log("Dumped:", meta);
}

// ---------- Exports for test-scrape.mjs ----------
export async function launchBrowser() {
  return chromium.launch({ headless: true, args: BROWSER_ARGS });
}
export { scrapeCity, scrapeSegment, CITIES, WINDOWS, PRICE_SEGMENTS, VEHICLE_TYPES, pool };

// ---------- Main ----------
async function main() {
  const cities = process.argv.slice(2).filter(Boolean);
  const targets = cities.length ? cities : Object.keys(CITIES);

  // One shared browser instance for the whole run — avoids the overhead of
  // launching Chromium per segment while keeping a single clean process.
  const browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
  try {
    for (const c of targets) {
      try { await scrapeCity(browser, c); }
      catch (e) { console.error(`City ${c} crashed:`, e); }
    }
    await dumpJson();
  } finally {
    await browser.close().catch(() => {});
    await pool.end();
  }
}

// Only run main when invoked directly (not when imported by test-scrape.mjs).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

