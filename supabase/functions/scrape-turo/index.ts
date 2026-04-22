// Turo scraper edge function — uses Firecrawl to fetch search pages
// (Firecrawl handles Cloudflare + proxies for us), extracts the JSON
// Turo embeds in __NEXT_DATA__, normalises vehicle records, and writes
// them to listings_current / listings_snapshots / price_forecasts.
//
// Trigger:
//   POST /scrape-turo                          → all active cities
//   POST /scrape-turo  body { city: "los-angeles" }  → one city
//   POST /scrape-turo  body { all: true }      → all active cities (cron)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

// Recursively walk a JSON value and extract vehicle-shaped objects.
function normaliseVehicle(node: any): any | null {
  if (!node || typeof node !== "object") return null;
  const id = node.id ?? node.vehicleId ?? node.vehicle?.id;
  const rawPrice =
    node.avgDailyPrice ??
    node.dailyPrice ??
    node.dailyPriceWithCurrency ??
    node.dailyPricing?.dailyPrice ??
    node.price;
  const price =
    rawPrice && typeof rawPrice === "object" ? rawPrice.amount : rawPrice;
  const make = node.make ?? node.vehicle?.make ?? node.makeName;
  const model = node.model ?? node.vehicle?.model ?? node.modelName;
  if (!id || !price || (!make && !model)) return null;
  return {
    vehicle_id: String(id),
    make: make ?? null,
    model: model ?? null,
    year: Number(node.year ?? node.vehicle?.year) || null,
    trim: node.trim ?? node.vehicle?.trim ?? null,
    vehicle_type:
      node.type ??
      node.seoCategory ??
      node.vehicleType ??
      node.vehicle?.type ??
      null,
    fuel_type: node.fuelType ?? node.vehicle?.fuelType ?? null,
    avg_daily_price: Number(price) || null,
    completed_trips:
      Number(node.completedTrips ?? node.numberOfTrips ?? node.tripsTaken) || 0,
    rating: Number(node.rating ?? node.hostRating ?? node.avgRating) || null,
    is_all_star_host: Boolean(node.isAllStarHost ?? node.host?.isAllStarHost),
    host_id: node.hostId ?? node.host?.id ? String(node.hostId ?? node.host?.id) : null,
    host_name: node.hostName ?? node.host?.firstName ?? null,
    image_url:
      node.images?.[0]?.originalImageUrl ??
      node.images?.[0]?.url ??
      node.imageUrls?.[0] ??
      node.image?.originalImageUrl ??
      null,
    location_city: node.location?.city ?? node.locationCity ?? null,
    location_state: node.location?.state ?? node.locationState ?? null,
    latitude: Number(node.location?.latitude ?? node.latitude) || null,
    longitude: Number(node.location?.longitude ?? node.longitude) || null,
  };
}

function extractFromJson(root: any): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  function walk(v: any, depth = 0) {
    if (depth > 12 || v == null) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v === "object") {
      const n = normaliseVehicle(v);
      if (n && !seen.has(n.vehicle_id)) {
        seen.add(n.vehicle_id);
        out.push(n);
      }
      for (const k in v) walk(v[k], depth + 1);
    }
  }
  walk(root);
  return out;
}

// Try to extract __NEXT_DATA__ JSON blob from raw HTML
function extractNextData(html: string): any | null {
  const m = html.match(
    /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

async function firecrawlScrape(url: string): Promise<string | null> {
  const resp = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["rawHtml"],
      onlyMainContent: false,
      waitFor: 5000,
      location: { country: "US", languages: ["en"] },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`Firecrawl ${resp.status}: ${text.slice(0, 300)}`);
    return null;
  }
  const data = await resp.json();
  return data?.data?.rawHtml ?? data?.rawHtml ?? data?.data?.html ?? data?.html ?? null;
}

async function scrapeCity(
  supa: ReturnType<typeof createClient>,
  city: City,
): Promise<{ vehicles: number; segments: number; error?: string }> {
  // Insert run row
  const { data: runRow } = await supa
    .from("scrape_runs")
    .insert({ city: city.slug, status: "running" })
    .select("id")
    .single();
  const runId = runRow?.id as string | undefined;

  try {
    // Map vehicle_id -> { vehicle, perWindow: { now, 7d, 14d, 30d } }
    const merged = new Map<string, { v: any; windows: Record<string, number> }>();
    let segmentsRun = 0;

    for (const win of WINDOWS) {
      const url = buildSearchUrl(city, win);
      console.log(`[${city.slug}/${win.key}] ${url.slice(0, 100)}...`);
      const html = await firecrawlScrape(url);
      if (!html) continue;
      segmentsRun++;
      const next = extractNextData(html);
      const vehicles = next ? extractFromJson(next) : [];
      console.log(`  → ${vehicles.length} vehicles`);
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

    // Build records for listings_current + listings_snapshots
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

    const snapshotRows = currentRows.map((r) => ({
      ...r,
      scraped_at: now,
    }));

    if (currentRows.length > 0) {
      // Upsert into listings_current
      for (let i = 0; i < currentRows.length; i += 200) {
        const chunk = currentRows.slice(i, i + 200);
        const { error } = await supa
          .from("listings_current")
          .upsert(chunk, { onConflict: "vehicle_id" });
        if (error) console.error("upsert listings_current:", error.message);
      }
      // Insert into listings_snapshots
      for (let i = 0; i < snapshotRows.length; i += 200) {
        const chunk = snapshotRows.slice(i, i + 200);
        const { error } = await supa.from("listings_snapshots").insert(chunk);
        if (error) console.error("insert listings_snapshots:", error.message);
      }

      // Forecast rows (one per window per vehicle that has data)
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
    const msg = e instanceof Error ? e.message : String(e);
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
    return { vehicles: 0, segments: 0, error: msg };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!FIRECRAWL_API_KEY) {
    return new Response(
      JSON.stringify({ error: "FIRECRAWL_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let body: any = {};
  try { body = await req.json(); } catch {}

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Determine which cities to scrape
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
    return new Response(
      JSON.stringify({ error: "No matching active cities found" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const results: Record<string, any> = {};
  for (const city of cities) {
    results[city.slug] = await scrapeCity(supa, city);
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
