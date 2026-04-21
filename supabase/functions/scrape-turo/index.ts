// Scrape Turo via Firecrawl across multiple date windows so we capture
// forward-looking pricing (now, next 7d, next 14d, next 30d) per vehicle.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const FIRECRAWL_V2 = "https://api.firecrawl.dev/v2";

const CITIES: Record<
  string,
  { country: string; name: string; lat: number; lng: number; region: string; placeId: string }
> = {
  "los-angeles": {
    country: "US",
    name: "Los Angeles",
    lat: 34.0549076,
    lng: -118.242643,
    region: "CA",
    placeId: "ChIJE9on3F3HwoAR9AhGJW_fL-I",
  },
  "miami": {
    country: "US",
    name: "Miami",
    lat: 25.7616798,
    lng: -80.1917902,
    region: "FL",
    placeId: "ChIJEcHIDqKw2YgRZU-t3XHylv8",
  },
};

const PRICE_SEGMENTS: Array<[number, number]> = [
  [0, 40], [40, 60], [60, 80], [80, 110],
  [110, 150], [150, 220], [220, 350], [350, 1000],
];

const VEHICLE_TYPES: Array<string | null> = [null, "CAR", "SUV", "MINIVAN", "TRUCK", "VAN"];

type WindowKey = "now" | "7d" | "14d" | "30d";

// Forward-looking windows. "now" = ~7 days out (Turo requires future dates),
// then 7d, 14d, 30d further out, each spanning 3 days for the search.
const WINDOWS: Array<{ key: WindowKey; offsetDays: number; spanDays: number; label: string }> = [
  { key: "now", offsetDays: 1, spanDays: 3, label: "Now" },
  { key: "7d", offsetDays: 7, spanDays: 3, label: "+7d" },
  { key: "14d", offsetDays: 14, spanDays: 3, label: "+14d" },
  { key: "30d", offsetDays: 30, spanDays: 3, label: "+30d" },
];

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function buildSearchUrl(
  city: typeof CITIES[string],
  win: typeof WINDOWS[number],
  minPrice?: number,
  maxPrice?: number,
  vehicleType?: string | null,
): { url: string; pickup: string; dropoff: string } {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + win.offsetDays);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + win.spanDays);
  const pickup = isoDate(start);
  const dropoff = isoDate(end);

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
    pickupDate: pickup,
    pickupTime: "10:00",
    dropoffDate: dropoff,
    dropoffTime: "10:00",
  });
  if (minPrice !== undefined) params.set("minDailyPriceUSD", String(minPrice));
  if (maxPrice !== undefined) params.set("maxDailyPriceUSD", String(maxPrice));
  if (vehicleType) params.set("types", vehicleType);
  return {
    url: `https://turo.com/us/en/search?${params.toString()}`,
    pickup,
    dropoff,
  };
}

const VEHICLE_SCHEMA = {
  type: "object",
  properties: {
    vehicles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          vehicle_id: { type: "string", description: "Turo vehicle ID (numeric or slug)" },
          make: { type: "string" },
          model: { type: "string" },
          year: { type: "number" },
          trim: { type: "string" },
          vehicle_type: { type: "string" },
          fuel_type: { type: "string" },
          avg_daily_price: { type: "number" },
          completed_trips: { type: "number" },
          rating: { type: "number" },
          is_all_star_host: { type: "boolean" },
          host_name: { type: "string" },
          image_url: { type: "string" },
          location_city: { type: "string" },
          location_state: { type: "string" },
          listing_url: { type: "string" },
        },
        required: ["make", "model", "avg_daily_price"],
      },
    },
  },
  required: ["vehicles"],
};

async function scrapeSegment(
  citySlug: string,
  win: typeof WINDOWS[number],
  minPrice: number,
  maxPrice: number,
  vehicleType: string | null,
) {
  const apiKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not configured");
  const city = CITIES[citySlug];
  if (!city) throw new Error(`Unknown city ${citySlug}`);

  const { url } = buildSearchUrl(city, win, minPrice, maxPrice, vehicleType);
  const label = `${citySlug}/${win.key}/${vehicleType ?? "ALL"}/$${minPrice}-${maxPrice}`;
  console.log(`Firecrawl: ${label}`);

  const res = await fetch(`${FIRECRAWL_V2}/scrape`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      formats: [{
        type: "json",
        schema: VEHICLE_SCHEMA,
        prompt: "Extract EVERY car listing visible on this Turo search results page — do not skip any. For each vehicle return: vehicle_id (numeric ID from listing URL), make, model, year, daily price in USD for the displayed dates, completed trips, host rating, host name, image URL, and the absolute listing URL.",
      }],
      onlyMainContent: false,
      waitFor: 5000,
      location: { country: "US", languages: ["en-US"] },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Firecrawl ${res.status} (${label}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  const json = data?.data?.json ?? data?.json ?? {};
  const vehicles = Array.isArray(json?.vehicles) ? json.vehicles : [];
  console.log(`  ${label}: ${vehicles.length} vehicles`);
  return vehicles;
}

function deriveId(raw: any, citySlug: string): string | null {
  let id: string | null = raw?.vehicle_id ? String(raw.vehicle_id) : null;
  if (!id && typeof raw?.listing_url === "string") {
    const m = raw.listing_url.match(/\/(\d+)(?:\/?$|\?)/);
    if (m) id = m[1];
  }
  if (!id) {
    const seed = `${raw?.make}-${raw?.model}-${raw?.year}-${raw?.host_name}`;
    id = `synth-${citySlug}-${btoa(seed).replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
  }
  return id;
}

function normalizeBase(raw: any, citySlug: string, id: string) {
  return {
    vehicle_id: id,
    city: citySlug,
    make: raw?.make ?? null,
    model: raw?.model ?? null,
    year: Number(raw?.year) || null,
    trim: raw?.trim ?? null,
    vehicle_type: raw?.vehicle_type ?? null,
    fuel_type: raw?.fuel_type ?? null,
    currency: "USD",
    completed_trips: Number(raw?.completed_trips) || 0,
    rating: Number(raw?.rating) || null,
    is_all_star_host: Boolean(raw?.is_all_star_host),
    host_id: null,
    host_name: raw?.host_name ?? null,
    image_url: typeof raw?.image_url === "string" ? raw.image_url : null,
    location_city: raw?.location_city ?? null,
    location_state: raw?.location_state ?? null,
    latitude: null,
    longitude: null,
  };
}

async function pAll<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < tasks.length) {
      const i = idx++;
      try { await tasks[i](); } catch (_) { /* per-task already handled */ }
    }
  });
  await Promise.all(workers);
}

type WindowAgg = { sum: number; count: number; min: number; max: number };

async function runScrape(cities: string[], opts: { testMode?: boolean } = {}) {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const summary: any[] = [];
  const segs = opts.testMode ? [PRICE_SEGMENTS[2]] : PRICE_SEGMENTS;
  const types = opts.testMode ? [null] : VEHICLE_TYPES;
  const windows = opts.testMode ? [WINDOWS[0], WINDOWS[1]] : WINDOWS;

  for (const citySlug of cities) {
    const { data: runRow } = await supabase
      .from("scrape_runs")
      .insert({ city: citySlug, status: "running" })
      .select()
      .single();
    const runId = runRow?.id;

    // Per-vehicle accumulator: meta + per-window price stats
    const vehicles = new Map<string, {
      base: ReturnType<typeof normalizeBase>;
      raw: any;
      windows: Record<WindowKey, WindowAgg>;
    }>();

    const errors: string[] = [];
    let segmentsOk = 0;

    const tasks: Array<() => Promise<void>> = [];
    for (const win of windows) {
      for (const [minP, maxP] of segs) {
        for (const vt of types) {
          tasks.push(async () => {
            try {
              const list = await scrapeSegment(citySlug, win, minP, maxP, vt);
              segmentsOk++;
              for (const raw of list) {
                const id = deriveId(raw, citySlug);
                if (!id) continue;
                const price = Number(raw?.avg_daily_price);
                if (!Number.isFinite(price) || price <= 0) continue;

                let entry = vehicles.get(id);
                if (!entry) {
                  entry = {
                    base: normalizeBase(raw, citySlug, id),
                    raw,
                    windows: {
                      now: { sum: 0, count: 0, min: Infinity, max: -Infinity },
                      "7d": { sum: 0, count: 0, min: Infinity, max: -Infinity },
                      "14d": { sum: 0, count: 0, min: Infinity, max: -Infinity },
                      "30d": { sum: 0, count: 0, min: Infinity, max: -Infinity },
                    },
                  };
                  vehicles.set(id, entry);
                }
                const agg = entry.windows[win.key];
                agg.sum += price;
                agg.count += 1;
                if (price < agg.min) agg.min = price;
                if (price > agg.max) agg.max = price;
              }
            } catch (e: any) {
              errors.push(e.message);
              console.error("Segment failed:", e.message);
            }
          });
        }
      }
    }

    await pAll(tasks, 3);

    const scrapedAt = new Date().toISOString();
    const rows: any[] = [];
    const currentRows: any[] = [];
    const forecastRows: any[] = [];

    for (const [, entry] of vehicles) {
      const w = entry.windows;
      const avg = (a: WindowAgg) => (a.count > 0 ? a.sum / a.count : null);
      const priceNow = avg(w.now);
      const price7 = avg(w["7d"]);
      const price14 = avg(w["14d"]);
      const price30 = avg(w["30d"]);
      // avg_daily_price: prefer "now", fall back to 7d if now empty
      const headlinePrice = priceNow ?? price7 ?? price14 ?? price30;

      const snapshot = {
        ...entry.base,
        avg_daily_price: headlinePrice,
        price_7d_avg: price7,
        price_14d_avg: price14,
        price_30d_avg: price30,
        raw: entry.raw,
      };
      rows.push(snapshot);

      const { raw: _r, ...curr } = snapshot as any;
      currentRows.push({
        ...curr,
        last_scraped_at: scrapedAt,
        updated_at: scrapedAt,
      });

      // Forecast rows — one per non-empty forward window
      for (const win of windows) {
        if (win.key === "now") continue;
        const a = w[win.key];
        if (a.count === 0) continue;
        const start = new Date();
        start.setUTCDate(start.getUTCDate() + win.offsetDays);
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + win.spanDays);
        forecastRows.push({
          vehicle_id: entry.base.vehicle_id,
          city: citySlug,
          window_label: win.key,
          avg_price: a.sum / a.count,
          min_price: Number.isFinite(a.min) ? a.min : null,
          max_price: Number.isFinite(a.max) ? a.max : null,
          window_start: isoDate(start),
          window_end: isoDate(end),
          scraped_at: scrapedAt,
        });
      }
    }

    console.log(`${citySlug}: ${rows.length} unique vehicles · ${forecastRows.length} forecast rows · ${segmentsOk}/${tasks.length} segments`);

    const chunkSize = 200;
    if (rows.length > 0) {
      for (let i = 0; i < rows.length; i += chunkSize) {
        await supabase.from("listings_snapshots").insert(rows.slice(i, i + chunkSize));
      }
      for (let i = 0; i < currentRows.length; i += chunkSize) {
        await supabase.from("listings_current").upsert(
          currentRows.slice(i, i + chunkSize),
          { onConflict: "vehicle_id" },
        );
      }
    }
    if (forecastRows.length > 0) {
      for (let i = 0; i < forecastRows.length; i += chunkSize) {
        await supabase.from("price_forecasts").insert(forecastRows.slice(i, i + chunkSize));
      }
    }

    const errorMsg = errors.length > 0 ? errors.slice(0, 3).join(" | ") : null;
    await supabase
      .from("scrape_runs")
      .update({
        status: rows.length > 0 ? "success" : (errorMsg ? "failed" : "empty"),
        vehicles_count: rows.length,
        segments_run: segmentsOk,
        error_message: errorMsg,
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);

    summary.push({
      city: citySlug,
      vehicles: rows.length,
      forecasts: forecastRows.length,
      segments: `${segmentsOk}/${tasks.length}`,
      error: errorMsg,
    });
  }

  console.log("Scrape summary:", JSON.stringify(summary));
  return summary;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: any = {};
  try { body = await req.json(); } catch (_) {}
  const cities: string[] = body.cities ?? ["los-angeles", "miami"];
  const testMode: boolean = body.test === true;

  if (testMode) {
    try {
      const result = await runScrape(cities, { testMode: true });
      return new Response(
        JSON.stringify({ ok: true, test: true, result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (e: any) {
      return new Response(
        JSON.stringify({ ok: false, error: e.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  }

  const totalSegments = PRICE_SEGMENTS.length * VEHICLE_TYPES.length * WINDOWS.length;
  // @ts-ignore - EdgeRuntime
  EdgeRuntime.waitUntil(
    runScrape(cities, { testMode: false }).catch((e) => console.error("Scrape failed:", e)),
  );

  return new Response(
    JSON.stringify({
      ok: true,
      message: `Full scrape started for ${cities.join(", ")} — ${totalSegments} segments per city across ${WINDOWS.length} date windows (now, +7d, +14d, +30d). Takes 10–20 min.`,
      cities,
      windows: WINDOWS.map((w) => w.key),
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
