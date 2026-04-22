// Turo scraper edge function — uses Apify actor `backhoe/turo-daily-pricing-parser`
// as the PRIMARY (and only) data source.
//
// Run mode: sync (run-sync-get-dataset-items) — we wait for the actor to finish
// and consume the dataset items in a single HTTP call.
//
// Trigger:
//   POST /scrape-turo                          → all active cities
//   POST /scrape-turo  body { city: "los-angeles" }  → one city
//   POST /scrape-turo  body { all: true }      → all active cities (cron)
//   POST /scrape-turo  body { test_proxy: true } → quick connectivity test (now: Apify token check)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const APIFY_API_TOKEN = Deno.env.get("APIFY_API_TOKEN");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Apify actor ID — using the generic Web Scraper (apify/web-scraper).
// Actor ID `moJRLRc85AitArpNN` is the public ID for apify/web-scraper.
const APIFY_ACTOR = "moJRLRc85AitArpNN";

// Page function executed inside the headless browser for each Turo search URL.
// It scans __NEXT_DATA__, the streaming __next_f chunks, and raw HTML for
// vehicle-shaped JSON objects and pushes a flat array of normalised vehicles.
const PAGE_FUNCTION = `
async function pageFunction(context) {
  const { request, page, log } = context;
  // Wait briefly for hydration / streaming chunks to arrive
  try { await page.waitForSelector('script', { timeout: 8000 }); } catch (e) {}
  await new Promise(r => setTimeout(r, 2500));

  const html = await page.content();

  function normaliseVehicle(node) {
    if (!node || typeof node !== 'object') return null;
    const id = node.id || node.vehicleId || (node.vehicle && node.vehicle.id);
    const rawPrice = node.avgDailyPrice || node.dailyPrice || node.dailyPriceWithCurrency
      || (node.dailyPricing && node.dailyPricing.dailyPrice) || node.price;
    const price = rawPrice && typeof rawPrice === 'object' ? rawPrice.amount : rawPrice;
    const make = node.make || (node.vehicle && node.vehicle.make) || node.makeName;
    const model = node.model || (node.vehicle && node.vehicle.model) || node.modelName;
    if (!id || price == null || (!make && !model)) return null;
    return {
      vehicle_id: String(id),
      make: make || null,
      model: model || null,
      year: Number(node.year || (node.vehicle && node.vehicle.year)) || null,
      trim: node.trim || (node.vehicle && node.vehicle.trim) || null,
      vehicle_type: node.type || node.seoCategory || node.vehicleType || (node.vehicle && node.vehicle.type) || null,
      fuel_type: node.fuelType || (node.vehicle && node.vehicle.fuelType) || null,
      avg_daily_price: Number(price) || null,
      completed_trips: Number(node.completedTrips || node.numberOfTrips || node.tripsTaken) || 0,
      rating: Number(node.rating || node.hostRating || node.avgRating) || null,
      is_all_star_host: Boolean(node.isAllStarHost || (node.host && node.host.isAllStarHost)),
      host_id: (node.hostId || (node.host && node.host.id)) ? String(node.hostId || node.host.id) : null,
      host_name: node.hostName || (node.host && node.host.firstName) || null,
      image_url: (node.images && (node.images[0] && (node.images[0].originalImageUrl || node.images[0].url)))
        || (node.imageUrls && node.imageUrls[0])
        || (node.image && node.image.originalImageUrl) || null,
      location_city: (node.location && node.location.city) || node.locationCity || null,
      location_state: (node.location && node.location.state) || node.locationState || null,
      latitude: Number((node.location && node.location.latitude) || node.latitude) || null,
      longitude: Number((node.location && node.location.longitude) || node.longitude) || null,
    };
  }

  function walk(v, out, seen, depth) {
    if (depth > 12 || v == null) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, out, seen, depth + 1); return; }
    if (typeof v === 'object') {
      const n = normaliseVehicle(v);
      if (n && !seen.has(n.vehicle_id)) { seen.add(n.vehicle_id); out.push(n); }
      for (const k in v) walk(v[k], out, seen, depth + 1);
    }
  }

  const out = [];
  const seen = new Set();

  // 1) __NEXT_DATA__
  const nd = html.match(/<script[^>]+id=\\"__NEXT_DATA__\\"[^>]*>([\\s\\S]*?)<\\/script>/);
  if (nd) { try { walk(JSON.parse(nd[1]), out, seen, 0); } catch (e) {} }

  // 2) streaming __next_f chunks
  const re = /self\\.__next_f\\.push\\(\\s*\\[\\s*\\d+\\s*,\\s*("(?:\\\\.|[^"\\\\])*")\\s*\\]\\s*\\)/g;
  const chunks = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    try { chunks.push(JSON.parse(m[1])); } catch (e) {}
  }
  if (chunks.length) {
    const blob = chunks.join('');
    // Look for embedded JSON vehicle objects
    const idRe = /"(?:vehicleId|id)"\\s*:\\s*"?(\\d{5,})"?/g;
    let mm;
    while ((mm = idRe.exec(blob)) !== null) {
      // walk back to find {
      let start = -1, depth = 0;
      for (let i = mm.index; i >= 0; i--) {
        const c = blob[i];
        if (c === '}') depth++;
        else if (c === '{') { if (depth === 0) { start = i; break; } depth--; }
      }
      if (start < 0) continue;
      // walk forward to matching }
      let end = -1, d = 0, inStr = false, esc = false;
      for (let i = start; i < blob.length; i++) {
        const c = blob[i];
        if (esc) { esc = false; continue; }
        if (c === '\\\\') { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') d++;
        else if (c === '}') { d--; if (d === 0) { end = i; break; } }
      }
      if (end < 0) continue;
      try {
        const obj = JSON.parse(blob.slice(start, end + 1));
        const n = normaliseVehicle(obj);
        if (n && !seen.has(n.vehicle_id)) { seen.add(n.vehicle_id); out.push(n); }
      } catch (e) {}
      idRe.lastIndex = end + 1;
    }
  }

  log.info('Extracted ' + out.length + ' vehicles from ' + request.url);
  return { url: request.url, vehicles: out };
}
`;

type FailureReason =
  | "apify_not_configured"
  | "apify_auth_failed"
  | "apify_run_failed"
  | "apify_empty"
  | "unknown";

type ScrapeDiagnostics = {
  reason: FailureReason;
  blocked: boolean;
  sampleErrors: string[];
  emptyHtmlCount: number;
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function summarizeApifyFailure(errors: string[]): {
  message: string;
  diagnostics: ScrapeDiagnostics;
} {
  const sampleErrors = Array.from(new Set(errors)).slice(0, 3);
  const blob = sampleErrors.join(" | ");

  if (/not configured/i.test(blob)) {
    return {
      message: "Apify API token not configured.",
      diagnostics: { reason: "apify_not_configured", blocked: false, sampleErrors, emptyHtmlCount: 0 },
    };
  }
  if (/401|403|unauthor/i.test(blob)) {
    return {
      message: "Apify authentication failed. Check APIFY_API_TOKEN.",
      diagnostics: { reason: "apify_auth_failed", blocked: false, sampleErrors, emptyHtmlCount: 0 },
    };
  }
  if (/run failed|aborted|timed out|status: FAILED/i.test(blob)) {
    return {
      message: "Apify actor run failed. See logs in Apify console.",
      diagnostics: { reason: "apify_run_failed", blocked: false, sampleErrors, emptyHtmlCount: 0 },
    };
  }
  return {
    message: "Apify returned 0 vehicles for all windows.",
    diagnostics: { reason: errors.length === 0 ? "apify_empty" : "unknown", blocked: false, sampleErrors, emptyHtmlCount: 0 },
  };
}

type City = {
  slug: string;
  name: string;
  country: string;
  region: string | null;
  latitude: number;
  longitude: number;
  place_id: string | null;
};

const WINDOWS = [
  { key: "now", offsetDays: 1, spanDays: 3 },
  { key: "7d", offsetDays: 7, spanDays: 3 },
  { key: "14d", offsetDays: 14, spanDays: 3 },
  { key: "30d", offsetDays: 30, spanDays: 3 },
] as const;

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function buildSearchUrl(city: City, win: typeof WINDOWS[number]) {
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
    latitude: String(city.latitude),
    location: city.name,
    locationType: "CITY",
    longitude: String(city.longitude),
    pickupType: "ALL",
    region: city.region ?? "",
    searchDurationType: "DAILY",
    sortType: "RELEVANCE",
    pickupDate: isoDate(start),
    pickupTime: "10:00",
    dropoffDate: isoDate(end),
    dropoffTime: "10:00",
  });
  if (city.place_id) params.set("placeId", city.place_id);
  return `https://turo.com/us/en/search?${params.toString()}`;
}

// Map a single Apify dataset item to our internal vehicle shape.
// The actor returns one record per vehicle for the given search URL,
// so the daily price reflects the search window we requested.
function normaliseApifyItem(item: any): any | null {
  if (!item || typeof item !== "object") return null;
  // Pre-normalised by our pageFunction? Pass-through.
  if (item.vehicle_id && (item.make || item.model)) {
    return {
      vehicle_id: String(item.vehicle_id),
      make: item.make ?? null,
      model: item.model ?? null,
      year: item.year ?? null,
      trim: item.trim ?? null,
      vehicle_type: item.vehicle_type ?? null,
      fuel_type: item.fuel_type ?? null,
      avg_daily_price: item.avg_daily_price ?? null,
      completed_trips: item.completed_trips ?? 0,
      rating: item.rating ?? null,
      is_all_star_host: Boolean(item.is_all_star_host),
      host_id: item.host_id ?? null,
      host_name: item.host_name ?? null,
      image_url: item.image_url ?? null,
      location_city: item.location_city ?? null,
      location_state: item.location_state ?? null,
      latitude: item.latitude ?? null,
      longitude: item.longitude ?? null,
    };
  }
  const id =
    item.vehicleId ?? item.id ?? item.vehicle?.id ?? item.listingId;
  const rawPrice =
    item.avgDailyPrice ??
    item.dailyPrice ??
    item.dailyPricing?.dailyPrice ??
    item.price ??
    item.pricing?.dailyPrice;
  const price =
    rawPrice && typeof rawPrice === "object" ? rawPrice.amount : rawPrice;
  const make = item.make ?? item.vehicle?.make ?? item.makeName;
  const model = item.model ?? item.vehicle?.model ?? item.modelName;
  if (!id || price == null || (!make && !model)) return null;
  return {
    vehicle_id: String(id),
    make: make ?? null,
    model: model ?? null,
    year: Number(item.year ?? item.vehicle?.year) || null,
    trim: item.trim ?? item.vehicle?.trim ?? null,
    vehicle_type:
      item.type ?? item.seoCategory ?? item.vehicleType ?? item.vehicle?.type ?? null,
    fuel_type: item.fuelType ?? item.vehicle?.fuelType ?? null,
    avg_daily_price: Number(price) || null,
    completed_trips:
      Number(item.completedTrips ?? item.numberOfTrips ?? item.tripsTaken) || 0,
    rating: Number(item.rating ?? item.hostRating ?? item.avgRating) || null,
    is_all_star_host: Boolean(item.isAllStarHost ?? item.host?.isAllStarHost),
    host_id:
      item.hostId ?? item.host?.id ? String(item.hostId ?? item.host?.id) : null,
    host_name: item.hostName ?? item.host?.firstName ?? null,
    image_url:
      item.images?.[0]?.originalImageUrl ??
      item.images?.[0]?.url ??
      item.imageUrls?.[0] ??
      item.image?.originalImageUrl ??
      item.imageUrl ??
      null,
    location_city: item.location?.city ?? item.locationCity ?? null,
    location_state: item.location?.state ?? item.locationState ?? null,
    latitude: Number(item.location?.latitude ?? item.latitude) || null,
    longitude: Number(item.location?.longitude ?? item.longitude) || null,
  };
}

// Call the Apify actor in sync mode and return the dataset items.
async function runApify(
  searchUrls: string[],
  tokenOverride?: string | null,
): Promise<any[]> {
  const token = tokenOverride ?? APIFY_API_TOKEN;
  if (!token) throw new Error("APIFY_API_TOKEN not configured");

  // run-sync-get-dataset-items: starts the run, waits for it to finish, returns dataset items.
  // We pass a generous timeout (10 min). The actor's typical input is a list of search URLs.
  const url =
    `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&timeout=540&format=json`;

  // apify/web-scraper input shape
  const input = {
    startUrls: searchUrls.map((u) => ({ url: u })),
    pageFunction: PAGE_FUNCTION,
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
    useChrome: true,
    headless: true,
    waitUntil: ["networkidle2"],
    maxRequestRetries: 2,
    pageLoadTimeoutSecs: 60,
    maxPagesPerCrawl: searchUrls.length,
    injectJQuery: false,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(580_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Apify HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    // web-scraper returns one dataset item per URL: { url, vehicles: [...] }
    const out: any[] = [];
    for (const item of data) {
      if (Array.isArray(item?.vehicles)) out.push(...item.vehicles);
      else if (item && typeof item === "object") out.push(item);
    }
    return out;
  } catch {
    throw new Error(`Apify returned non-JSON response: ${text.slice(0, 200)}`);
  }
}

async function scrapeCity(
  supa: ReturnType<typeof createClient>,
  city: City,
): Promise<{ vehicles: number; segments: number; error?: string; diagnostics?: ScrapeDiagnostics }> {
  const { data: runRow } = await supa
    .from("scrape_runs")
    .insert({ city: city.slug, status: "running" })
    .select("id")
    .single();
  const runId = runRow?.id as string | undefined;
  let segmentsRun = 0;
  const windowErrors: string[] = [];

  try {
    // Map vehicle_id -> { vehicle, perWindow: { now, 7d, 14d, 30d } }
    const merged = new Map<string, { v: any; windows: Record<string, number> }>();

    // We call Apify ONCE per window so each vehicle's price reflects that window.
    for (const win of WINDOWS) {
      const searchUrl = buildSearchUrl(city, win);
      console.log(`[${city.slug}/${win.key}] apify ${searchUrl.slice(0, 110)}...`);

      let items: any[] = [];
      try {
        items = await runApify([searchUrl]);
        console.log(`  → apify returned ${items.length} raw items`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        windowErrors.push(`${win.key}: ${msg}`);
        console.log(`  → apify failed: ${msg}`);
      }

      const vehicles = items
        .map(normaliseApifyItem)
        .filter((v): v is any => v != null);
      console.log(`  → normalised ${vehicles.length} vehicles`);

      segmentsRun++;
      for (const v of vehicles) {
        const existing = merged.get(v.vehicle_id);
        if (existing) {
          existing.windows[win.key] = v.avg_daily_price;
        } else {
          merged.set(v.vehicle_id, {
            v,
            windows: { [win.key]: v.avg_daily_price },
          });
        }
      }
    }

    const all = Array.from(merged.values());
    const now = new Date().toISOString();

    const currentRows = all.map(({ v, windows }) => ({
      vehicle_id: v.vehicle_id,
      city: city.slug,
      make: v.make,
      model: v.model,
      year: v.year,
      trim: v.trim,
      vehicle_type: v.vehicle_type,
      fuel_type: v.fuel_type,
      avg_daily_price: windows.now ?? v.avg_daily_price,
      currency: "USD",
      completed_trips: v.completed_trips,
      rating: v.rating,
      is_all_star_host: v.is_all_star_host,
      host_id: v.host_id,
      host_name: v.host_name,
      image_url: v.image_url,
      location_city: v.location_city,
      location_state: v.location_state,
      latitude: v.latitude,
      longitude: v.longitude,
      price_7d_avg: windows["7d"] ?? null,
      price_14d_avg: windows["14d"] ?? null,
      price_30d_avg: windows["30d"] ?? null,
      last_scraped_at: now,
      updated_at: now,
    }));

    const snapshotRows = currentRows.map((r) => ({ ...r, scraped_at: now }));

    if (currentRows.length > 0) {
      for (let i = 0; i < currentRows.length; i += 200) {
        const chunk = currentRows.slice(i, i + 200);
        const { error } = await supa
          .from("listings_current")
          .upsert(chunk, { onConflict: "vehicle_id" });
        if (error) console.error("upsert listings_current:", error.message);
      }
      for (let i = 0; i < snapshotRows.length; i += 200) {
        const chunk = snapshotRows.slice(i, i + 200);
        const { error } = await supa.from("listings_snapshots").insert(chunk);
        if (error) console.error("insert listings_snapshots:", error.message);
      }

      const forecasts: any[] = [];
      for (const { v, windows } of all) {
        for (const w of ["7d", "14d", "30d"] as const) {
          const price = windows[w];
          if (price == null) continue;
          const win = WINDOWS.find((x) => x.key === w)!;
          const start = new Date();
          start.setUTCDate(start.getUTCDate() + win.offsetDays);
          const end = new Date(start);
          end.setUTCDate(end.getUTCDate() + win.spanDays);
          forecasts.push({
            vehicle_id: v.vehicle_id,
            city: city.slug,
            window_label: w,
            avg_price: price,
            min_price: price,
            max_price: price,
            window_start: isoDate(start),
            window_end: isoDate(end),
            scraped_at: now,
          });
        }
      }
      for (let i = 0; i < forecasts.length; i += 200) {
        const chunk = forecasts.slice(i, i + 200);
        const { error } = await supa.from("price_forecasts").insert(chunk);
        if (error) console.error("insert price_forecasts:", error.message);
      }
    }

    if (currentRows.length === 0) {
      const failure = summarizeApifyFailure(windowErrors);
      throw { message: failure.message, diagnostics: failure.diagnostics };
    }

    if (runId) {
      await supa
        .from("scrape_runs")
        .update({
          status: "success",
          vehicles_count: currentRows.length,
          segments_run: segmentsRun,
          finished_at: new Date().toISOString(),
        })
        .eq("id", runId);
    }

    return { vehicles: currentRows.length, segments: segmentsRun };
  } catch (e) {
    const msg = e instanceof Error
      ? e.message
      : typeof e === "object" && e && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e);
    const diagnostics = typeof e === "object" && e && "diagnostics" in e
      ? (e as { diagnostics?: ScrapeDiagnostics }).diagnostics
      : summarizeApifyFailure(windowErrors).diagnostics;
    console.error(`scrapeCity ${city.slug} failed:`, msg);
    if (runId) {
      await supa
        .from("scrape_runs")
        .update({
          status: "failed",
          error_message: msg,
          finished_at: new Date().toISOString(),
        })
        .eq("id", runId);
    }
    return { vehicles: 0, segments: segmentsRun, error: msg, diagnostics };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let body: any = {};
  try { body = await req.json(); } catch {}

  // Connectivity test: try a single small Apify run for Los Angeles.
  if (body.test_proxy) {
    if (!APIFY_API_TOKEN) {
      return jsonResponse({
        ok: false,
        error: "APIFY_API_TOKEN not configured.",
        fallback: true,
        diagnostics: { reason: "apify_not_configured", blocked: false, sampleErrors: [], emptyHtmlCount: 0 },
      });
    }

    const testCity: City = {
      slug: "proxy-test",
      name: "Los Angeles",
      country: "US",
      region: "CA",
      latitude: 34.0522,
      longitude: -118.2437,
      place_id: null,
    };
    const url = buildSearchUrl(testCity, WINDOWS[0]);

    try {
      const items = await runApify([url]);
      const vehicles = items.map(normaliseApifyItem).filter(Boolean);
      if (vehicles.length > 0) {
        return jsonResponse({
          ok: true,
          message: `Apify reachable. Retrieved ${vehicles.length} vehicle${vehicles.length === 1 ? "" : "s"}.`,
          vehicles: vehicles.length,
        });
      }
      return jsonResponse({
        ok: false,
        error: "Apify ran successfully but returned 0 vehicles for the test search.",
        fallback: true,
        diagnostics: { reason: "apify_empty", blocked: false, sampleErrors: [], emptyHtmlCount: 0 },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const failure = summarizeApifyFailure([msg]);
      return jsonResponse({
        ok: false,
        error: failure.message,
        fallback: true,
        diagnostics: failure.diagnostics,
      });
    }
  }

  if (!APIFY_API_TOKEN) {
    return jsonResponse({
      ok: false,
      error: "APIFY_API_TOKEN not configured. Add it in Lovable Cloud secrets.",
      fallback: true,
      diagnostics: { reason: "apify_not_configured", blocked: false, sampleErrors: [], emptyHtmlCount: 0 },
    });
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let cities: City[] = [];
  if (body.city && typeof body.city === "string") {
    const { data } = await supa
      .from("cities")
      .select("*")
      .eq("slug", body.city)
      .maybeSingle();
    if (data) cities = [data as City];
  } else {
    const { data } = await supa
      .from("cities")
      .select("*")
      .eq("active", true);
    cities = (data ?? []) as City[];
  }

  if (cities.length === 0) {
    return jsonResponse({ ok: false, error: "No matching active cities found" });
  }

  const results: Record<string, any> = {};
  for (const city of cities) {
    results[city.slug] = await scrapeCity(supa, city);
  }

  const failed = Object.entries(results).filter(([, r]: any) => r?.error);
  const allFailed = failed.length === cities.length;
  if (allFailed) {
    const firstFailed = (failed[0]?.[1] as any) ?? {};
    return jsonResponse({
      ok: false,
      error: firstFailed.error ?? "Scrape failed",
      fallback: true,
      diagnostics: firstFailed.diagnostics ?? {
        reason: "unknown",
        blocked: false,
        sampleErrors: [],
        emptyHtmlCount: 0,
      },
      results,
    });
  }

  return jsonResponse({ ok: true, results });
});
