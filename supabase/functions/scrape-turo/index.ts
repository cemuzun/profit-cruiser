// Turo scraper — runs entirely in this edge function using Zyte API.
// Zyte's "browserHtml" endpoint handles Cloudflare/anti-bot transparently.
//
// Trigger:
//   POST /scrape-turo                           → all active cities
//   POST /scrape-turo  body { city: "miami" }   → one city
//   POST /scrape-turo  body { test_proxy: true} → connectivity check

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ZYTE_API_KEY = Deno.env.get("ZYTE_API_KEY")!;

const ZYTE_ENDPOINT = "https://api.zyte.com/v1/extract";

// --- City catalog (mirrors the VPS scraper) ---
const CITIES: Record<string, {
  country: string; name: string; lat: number; lng: number;
  region: string; placeId: string;
}> = {
  "los-angeles": { country: "US", name: "Los Angeles", lat: 34.0549076, lng: -118.242643, region: "CA", placeId: "ChIJE9on3F3HwoAR9AhGJW_fL-I" },
  "miami":       { country: "US", name: "Miami",       lat: 25.7616798, lng: -80.1917902,  region: "FL", placeId: "ChIJEcHIDqKw2YgRZU-t3XHylv8" },
  "honolulu":    { country: "US", name: "Honolulu",    lat: 21.3098845, lng: -157.8581401, region: "HI", placeId: "ChIJTUbU9o9rAHwR_lMnUydM3qg" },
};

// Slim segments for edge function (60s wall-clock budget per call).
const PRICE_SEGMENTS: [number, number][] = [
  [0, 60], [60, 100], [100, 150], [150, 250], [250, 1000],
];
const WINDOWS = [
  { key: "now", offsetDays: 1,  spanDays: 3, label: "Now" },
  { key: "7d",  offsetDays: 7,  spanDays: 3, label: "+7d" },
  { key: "14d", offsetDays: 14, spanDays: 3, label: "+14d" },
  { key: "30d", offsetDays: 30, spanDays: 3, label: "+30d" },
];

function isoDate(d: Date) { return d.toISOString().slice(0, 10); }

function buildSearchUrl(city: typeof CITIES[string], win: typeof WINDOWS[0], minP: number, maxP: number) {
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
    minDailyPriceUSD: String(minP),
    maxDailyPriceUSD: String(maxP),
  });
  return `https://turo.com/us/en/search?${params.toString()}`;
}

// --- Vehicle normaliser (walks JSON tree) ---
function normaliseVehicle(node: any) {
  if (!node || typeof node !== "object") return null;
  const id = node.id ?? node.vehicleId ?? node.vehicle?.id;
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

function extractFromJsonTree(root: any) {
  const out: any[] = [];
  const seen = new Set<string>();
  function walk(v: any, depth = 0) {
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

// --- Zyte fetch ---
async function fetchViaZyte(url: string): Promise<string> {
  const auth = btoa(`${ZYTE_API_KEY}:`);
  const res = await fetch(ZYTE_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      browserHtml: true,
      // Use US residential / datacenter — Zyte picks automatically
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zyte ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.browserHtml as string) ?? "";
}

function extractFromHtml(html: string) {
  // Pull __NEXT_DATA__ JSON blob from Turo SSR
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  try {
    const data = JSON.parse(m[1]);
    return extractFromJsonTree(data);
  } catch {
    return [];
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function scrapeCity(supa: any, citySlug: string, runId: string) {
  const city = CITIES[citySlug];
  if (!city) throw new Error(`Unknown city: ${citySlug}`);

  // vehicle_id -> { vehicle, prices: number[] per window }
  const agg = new Map<string, { vehicle: any; windows: Map<string, number[]> }>();
  let segmentsRun = 0;

  for (const win of WINDOWS) {
    for (const [minP, maxP] of PRICE_SEGMENTS) {
      const url = buildSearchUrl(city, win, minP, maxP);
      try {
        const html = await fetchViaZyte(url);
        const vehicles = extractFromHtml(html);
        segmentsRun++;
        for (const v of vehicles) {
          if (!agg.has(v.vehicle_id)) {
            agg.set(v.vehicle_id, { vehicle: v, windows: new Map() });
          }
          const entry = agg.get(v.vehicle_id)!;
          if (!entry.windows.has(win.key)) entry.windows.set(win.key, []);
          entry.windows.get(win.key)!.push(v.avg_daily_price);
        }
      } catch (e) {
        console.error(`segment ${citySlug} ${win.key} ${minP}-${maxP} failed:`, (e as Error).message);
      }
    }
  }

  const now = new Date().toISOString();
  const listings: any[] = [];
  const snapshots: any[] = [];
  const forecasts: any[] = [];

  for (const [vid, { vehicle, windows }] of agg) {
    const allPrices = [...windows.values()].flat();
    const avgAll = allPrices.length ? allPrices.reduce((a, b) => a + b, 0) / allPrices.length : null;

    const base = {
      vehicle_id: vid,
      city: citySlug,
      ...vehicle,
      avg_daily_price: avgAll,
      last_scraped_at: now,
    };
    listings.push(base);
    snapshots.push({ ...base, scraped_at: now });

    for (const win of WINDOWS) {
      const prices = windows.get(win.key) ?? [];
      if (!prices.length) continue;
      const start = new Date();
      start.setUTCDate(start.getUTCDate() + win.offsetDays);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + win.spanDays);
      forecasts.push({
        vehicle_id: vid,
        city: citySlug,
        window_label: win.label,
        avg_price: prices.reduce((a, b) => a + b, 0) / prices.length,
        min_price: Math.min(...prices),
        max_price: Math.max(...prices),
        window_start: isoDate(start),
        window_end: isoDate(end),
        scraped_at: now,
      });
    }
  }

  // Upsert listings_current; insert snapshots & forecasts
  if (listings.length) {
    await supa.from("listings_current").upsert(listings, { onConflict: "vehicle_id" });
    await supa.from("listings_snapshots").insert(snapshots);
  }
  if (forecasts.length) {
    await supa.from("price_forecasts").insert(forecasts);
  }

  await supa.from("scrape_runs").update({
    status: "succeeded",
    finished_at: now,
    vehicles_count: listings.length,
    segments_run: segmentsRun,
  }).eq("id", runId);

  return { vehicles: listings.length, segments: segmentsRun };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let body: any = {};
  try { body = await req.json(); } catch {}

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  if (body.test_proxy) {
    if (!ZYTE_API_KEY) return jsonResponse({ ok: false, error: "ZYTE_API_KEY missing" });
    try {
      const html = await fetchViaZyte("https://turo.com/us/en");
      return jsonResponse({ ok: true, message: `Zyte reachable. Got ${html.length} bytes from Turo.` });
    } catch (e) {
      return jsonResponse({ ok: false, error: (e as Error).message });
    }
  }

  // Resolve target cities
  let targetSlugs: string[] = [];
  if (body.city && typeof body.city === "string") {
    targetSlugs = [body.city];
  } else {
    const { data } = await supa.from("cities").select("slug").eq("active", true);
    targetSlugs = (data ?? []).map((c: any) => c.slug);
  }
  if (!targetSlugs.length) return jsonResponse({ ok: false, error: "No cities" });

  // Process the FIRST city synchronously (so user sees data immediately).
  // For multi-city requests, queue the remaining ones as 'pending'.
  const [firstCity, ...rest] = targetSlugs;

  const { data: runRow, error: runErr } = await supa
    .from("scrape_runs")
    .insert({ city: firstCity, status: "running" })
    .select("id")
    .single();
  if (runErr) return jsonResponse({ ok: false, error: runErr.message }, 500);

  // Queue rest
  if (rest.length) {
    await supa.from("scrape_runs").insert(rest.map((c) => ({ city: c, status: "pending" })));
  }

  try {
    const result = await scrapeCity(supa, firstCity, runRow.id);
    return jsonResponse({
      ok: true,
      city: firstCity,
      ...result,
      queued: rest,
      message: `Scraped ${result.vehicles} vehicles from ${firstCity} via Zyte. ${rest.length} city/cities queued.`,
    });
  } catch (e) {
    const msg = (e as Error).message;
    await supa.from("scrape_runs").update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error_message: msg,
    }).eq("id", runRow.id);
    return jsonResponse({ ok: false, error: msg }, 500);
  }
});
