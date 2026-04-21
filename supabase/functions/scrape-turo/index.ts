// Scrape Turo via Firecrawl. Firecrawl renders the search page with a real
// browser, bypassing Cloudflare, and we extract the listing JSON either from
// the page's __NEXT_DATA__ / hydration script or via Firecrawl's JSON-extract.

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

// Price segments cover the full Turo range; narrow segments give better extraction recall
// since Firecrawl's JSON extractor sees more of the listings on each page.
const PRICE_SEGMENTS: Array<[number, number]> = [
  [0, 40],
  [40, 60],
  [60, 80],
  [80, 110],
  [110, 150],
  [150, 220],
  [220, 350],
  [350, 1000],
];

const VEHICLE_TYPES: Array<string | null> = [null, "CAR", "SUV", "MINIVAN", "TRUCK", "VAN"];

function buildSearchUrl(
  city: typeof CITIES[string],
  minPrice?: number,
  maxPrice?: number,
  vehicleType?: string | null,
): string {
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
  });
  if (minPrice !== undefined) params.set("minDailyPriceUSD", String(minPrice));
  if (maxPrice !== undefined) params.set("maxDailyPriceUSD", String(maxPrice));
  if (vehicleType) params.set("types", vehicleType);
  return `https://turo.com/us/en/search?${params.toString()}`;
}

// Firecrawl JSON extraction schema for Turo listings on the search page.
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
          vehicle_type: { type: "string", description: "CAR, SUV, TRUCK, etc." },
          fuel_type: { type: "string" },
          avg_daily_price: { type: "number", description: "Daily price in USD" },
          completed_trips: { type: "number" },
          rating: { type: "number" },
          is_all_star_host: { type: "boolean" },
          host_name: { type: "string" },
          image_url: { type: "string" },
          location_city: { type: "string" },
          location_state: { type: "string" },
          listing_url: { type: "string", description: "Absolute URL to the car detail page" },
        },
        required: ["make", "model", "avg_daily_price"],
      },
    },
  },
  required: ["vehicles"],
};

async function scrapeSegment(
  citySlug: string,
  minPrice: number,
  maxPrice: number,
  vehicleType: string | null,
) {
  const apiKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not configured");
  const city = CITIES[citySlug];
  if (!city) throw new Error(`Unknown city ${citySlug}`);

  const url = buildSearchUrl(city, minPrice, maxPrice, vehicleType);
  const label = `${citySlug}/${vehicleType ?? "ALL"}/$${minPrice}-${maxPrice}`;
  console.log(`Firecrawl scrape: ${label}`);

  const res = await fetch(`${FIRECRAWL_V2}/scrape`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: [
        {
          type: "json",
          schema: VEHICLE_SCHEMA,
          prompt:
            "Extract EVERY car listing visible on this Turo search results page — do not skip any. For each vehicle return: vehicle_id (numeric ID from listing URL), make, model, year, daily price in USD, completed trips count, host rating, host name, image URL, and the absolute listing URL.",
        },
      ],
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

function normalize(raw: any, citySlug: string) {
  // Derive vehicle_id from listing_url if missing (URL contains /car-rental/.../<id>/).
  let id: string | null = raw?.vehicle_id ? String(raw.vehicle_id) : null;
  if (!id && typeof raw?.listing_url === "string") {
    const m = raw.listing_url.match(/\/(\d+)(?:\/?$|\?)/);
    if (m) id = m[1];
  }
  if (!id) {
    // Last resort: deterministic hash-ish from make+model+year+price+host
    const seed = `${raw?.make}-${raw?.model}-${raw?.year}-${raw?.avg_daily_price}-${raw?.host_name}`;
    id = `synth-${citySlug}-${btoa(seed).replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
  }

  return {
    vehicle_id: id,
    city: citySlug,
    make: raw?.make ?? null,
    model: raw?.model ?? null,
    year: Number(raw?.year) || null,
    trim: raw?.trim ?? null,
    vehicle_type: raw?.vehicle_type ?? null,
    fuel_type: raw?.fuel_type ?? null,
    avg_daily_price: Number(raw?.avg_daily_price) || null,
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
    raw,
  };
}

// Concurrency limiter — Firecrawl has rate limits, keep parallel calls modest.
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

async function runScrape(cities: string[], opts: { testMode?: boolean } = {}) {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const summary: any[] = [];
  const segs = opts.testMode ? [PRICE_SEGMENTS[2]] : PRICE_SEGMENTS;
  const types = opts.testMode ? [null] : VEHICLE_TYPES;

  for (const citySlug of cities) {
    const { data: runRow } = await supabase
      .from("scrape_runs")
      .insert({ city: citySlug, status: "running" })
      .select()
      .single();
    const runId = runRow?.id;

    const seen = new Map<string, any>();
    const errors: string[] = [];
    let segmentsOk = 0;

    const tasks: Array<() => Promise<void>> = [];
    for (const [minP, maxP] of segs) {
      for (const vt of types) {
        tasks.push(async () => {
          try {
            const list = await scrapeSegment(citySlug, minP, maxP, vt);
            segmentsOk++;
            for (const raw of list) {
              const n = normalize(raw, citySlug);
              if (!seen.has(n.vehicle_id)) seen.set(n.vehicle_id, n);
            }
          } catch (e: any) {
            errors.push(e.message);
            console.error("Segment failed:", e.message);
          }
        });
      }
    }

    await pAll(tasks, 3);

    const rows = Array.from(seen.values());
    console.log(`${citySlug}: ${rows.length} unique vehicles across ${segmentsOk}/${tasks.length} segments`);

    if (rows.length > 0) {
      const chunkSize = 200;
      for (let i = 0; i < rows.length; i += chunkSize) {
        await supabase.from("listings_snapshots").insert(rows.slice(i, i + chunkSize));
      }
      const currentRows = rows.map(({ raw, ...r }) => ({
        ...r,
        last_scraped_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));
      for (let i = 0; i < currentRows.length; i += chunkSize) {
        await supabase.from("listings_current").upsert(
          currentRows.slice(i, i + chunkSize),
          { onConflict: "vehicle_id" },
        );
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

    summary.push({ city: citySlug, count: rows.length, segments: `${segmentsOk}/${tasks.length}`, error: errorMsg });
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
      const result = await runScrape(cities);
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

  // @ts-ignore - EdgeRuntime is provided by supabase edge runtime
  EdgeRuntime.waitUntil(
    runScrape(cities).catch((e) => console.error("Scrape failed:", e)),
  );

  return new Response(
    JSON.stringify({
      ok: true,
      message: `Scrape started for ${cities.join(", ")} via Firecrawl. Check back in 1-2 minutes.`,
      cities,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
