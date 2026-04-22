#!/usr/bin/env node
// Quick test: navigate to search page, handle CF challenge, get vehicle data.
// Usage: node test-direct-api.mjs [minPrice] [maxPrice]
import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(stealthPlugin());

const MIN_PRICE = Number(process.argv[2] ?? 100);
const MAX_PRICE = Number(process.argv[3] ?? 300);

const PARAMS = new URLSearchParams({
  age: 30, country: "US", defaultZoomLevel: 11, isMapSearch: false,
  itemsPerPage: 200, latitude: 34.0549076, longitude: -118.242643,
  location: "Los Angeles", locationType: "CITY", pickupType: "ALL",
  placeId: "ChIJE9on3F3HwoAR9AhGJW_fL-I", region: "CA",
  searchDurationType: "DAILY", sortType: "RELEVANCE",
  pickupDate: "2026-04-25", pickupTime: "10:00",
  dropoffDate: "2026-04-28", dropoffTime: "10:00",
  minDailyPriceUSD: MIN_PRICE, maxDailyPriceUSD: MAX_PRICE,
});

const PAGE_URL = `https://turo.com/us/en/search?${PARAMS}`;

console.log(`Testing: $${MIN_PRICE}-$${MAX_PRICE}/day (hybrid CF-challenge approach)`);

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

try {
  const t0 = Date.now();

  let interceptedData = null;
  let searchApiUrl = null;
  let challengeSolved = false;

  page.on("response", async (resp) => {
    const rUrl = resp.url();
    const status = resp.status();
    const ct = resp.headers()["content-type"] || "";

    // Track the search API URL (even 403)
    if (rUrl.includes("turo.com/api") && rUrl.includes("search") && !rUrl.includes("/makes") && !rUrl.includes("/filters")) {
      if (!searchApiUrl) searchApiUrl = rUrl;
      console.log(`  [API] ${status} ${rUrl.split("?")[0]}`);
    }

    // CF challenge solved
    if (rUrl.includes("challenge-platform") && rUrl.includes("oneshot") && status === 200) {
      challengeSolved = true;
      console.log(`  [CF] Challenge solved at ${Date.now() - t0}ms`);
    }

    // Successful search response
    if (rUrl.includes("turo.com/api") && rUrl.includes("search") && status === 200 && ct.includes("json")) {
      try {
        const json = await resp.json();
        if (json?.vehicles && !interceptedData) {
          interceptedData = json;
          console.log(`  [OK] Intercepted ${json.vehicles.length} vehicles at ${Date.now() - t0}ms`);
        }
      } catch (_) {}
    }
  });

  console.log("Loading search page...");
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // Phase 1: wait for natural XHR (15s)
  const pollStart = Date.now();
  while (!interceptedData && Date.now() - pollStart < 15_000) {
    await page.waitForTimeout(500);
  }

  // Phase 2: CF challenge solved? Manually retry the API
  if (!interceptedData && challengeSolved) {
    const apiEndpoint = searchApiUrl || `https://turo.com/api/v2/search?${PARAMS}`;
    console.log(`Retrying API post-CF (${Date.now() - t0}ms)...`);

    const result = await page.evaluate(async (endpoint) => {
      const resp = await fetch(endpoint, {
        credentials: "include",
        headers: { "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9" },
      });
      return { status: resp.status, data: resp.ok ? await resp.json() : null };
    }, apiEndpoint);

    console.log(`  Retry status: ${result.status}`);
    if (result.data?.vehicles) interceptedData = result.data;
  }

  // Phase 3: still waiting for challenge?
  if (!interceptedData && !challengeSolved) {
    console.log("Waiting for CF challenge...");
    const cfWait = Date.now();
    while (!challengeSolved && Date.now() - cfWait < 15_000) {
      await page.waitForTimeout(500);
    }
    if (challengeSolved && !interceptedData) {
      const apiEndpoint = searchApiUrl || `https://turo.com/api/v2/search?${PARAMS}`;
      console.log(`Late retry (${Date.now() - t0}ms)...`);
      const result = await page.evaluate(async (endpoint) => {
        const resp = await fetch(endpoint, {
          credentials: "include",
          headers: { "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9" },
        });
        return { status: resp.status, data: resp.ok ? await resp.json() : null };
      }, apiEndpoint);
      console.log(`  Retry status: ${result.status}`);
      if (result.data?.vehicles) interceptedData = result.data;
    }
  }

  const elapsed = Date.now() - t0;

  if (!interceptedData) {
    console.log(`\n❌ No vehicles after ${elapsed}ms (challenge=${challengeSolved})`);
    process.exit(1);
  }

  const vehicles = interceptedData.vehicles ?? [];
  console.log(`\n✅ ${vehicles.length} vehicles (totalHits: ${interceptedData.totalHits}) in ${elapsed}ms`);
  vehicles.slice(0, 5).forEach(v => {
    const price = v.avgDailyPrice?.amount ?? v.avgDailyPrice;
    console.log(`  - ${v.year} ${v.make} ${v.model}: $${price}/day`);
  });
} finally {
  await browser.close();
}
