// Turo scraper using Zyte API + SSR HTML + JSON-LD.
//
// Strategy (no auth, no browser, no Cloudflare bypass needed):
//   1. Fetch Turo's official sitemaps to discover landing-page URLs for the
//      city across all categories (car-rental, suv-rental, exotic-luxury, etc.)
//   2. Fetch each landing page (plain HTTP via Zyte) and extract Honolulu
//      vehicle URLs from the SSR HTML.
//   3. Fetch each vehicle detail page and parse the embedded JSON-LD Product
//      schema for price, rating, name, image.
//   4. Upsert into listings_current + listings_snapshots.
//
// Cost: ~$0.40/1000 requests via Zyte basic HTTP. ~$0.05 per city per run
// for ~100 vehicles.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ZYTE_API_KEY = Deno.env.get("ZYTE_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

// ---------- Zyte helpers ----------
async function zyteText(
  url: string,
  opts: { browser?: boolean } = {},
): Promise<{ status: number; body: string }> {
  const reqBody: Record<string, unknown> = { url, geolocation: "US" };
  if (opts.browser) {
    // JS-rendered page (needed for Turo /search results which load via XHR).
    reqBody.browserHtml = true;
  } else {
    reqBody.httpResponseBody = true;
  }
  const res = await fetch("https://api.zyte.com/v1/extract", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(ZYTE_API_KEY + ":"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reqBody),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Zyte ${res.status} for ${url}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const status = data.statusCode ?? 0;

  if (data.browserHtml) {
    return { status, body: data.browserHtml as string };
  }

  const raw = data.httpResponseBody as string | undefined;
  if (!raw) return { status, body: "" };

  // Decode base64
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  // Try gunzip if URL ends in .gz
  if (url.endsWith(".gz")) {
    try {
      const ds = new DecompressionStream("gzip");
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      const text = await new Response(stream).text();
      return { status, body: text };
    } catch {
      // fall through and return raw
    }
  }
  return { status, body: new TextDecoder().decode(bytes) };
}

// ---------- Discovery ----------
const CATEGORY_SLUGS = [
  "car-rental",
  "suv-rental",
  "truck-rental",
  "minivan-rental",
  "van-rental",
  "sports-rental",
  "exotic-luxury-rental",
  "convertible-rental",
  "electric-vehicle-rental",
];

// Build the Turo city slug used in URLs. e.g. Honolulu, HI -> "honolulu-hi"
function cityUrlSlug(city: { name: string; region: string | null }): string {
  const name = city.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const region = (city.region ?? "").toLowerCase();
  return region ? `${name}-${region}` : name;
}

// Price buckets ($/day). Turo's listing pages cap at ~30-40 results;
// splitting by price lets us pull many more vehicles per category.
const PRICE_BUCKETS: Array<[number, number]> = [
  [0, 50],
  [50, 80],
  [80, 120],
  [120, 180],
  [180, 280],
  [280, 450],
  [450, 800],
  [800, 5000],
];

// Generic regex that matches any Turo vehicle detail URL inside a search/landing page.
// Captures: type slug, make slug, model slug, numeric vehicle id.
const VEHICLE_URL_RE =
  /\/us\/en\/([a-z-]+-rental)\/united-states\/[a-z0-9-]+\/([a-z0-9-]+)\/([a-z0-9-]+)\/(\d{4,8})/g;

// Newer Turo detail URL: /us/en/car-details/{id}. These don't include make/model
// in the URL — we'll get those from the JSON-LD on the detail page.
const CAR_DETAILS_RE = /\/us\/en\/car-details\/(\d{4,8})/g;

type FoundVehicle = { id: string; href: string; make: string; model: string; type: string };

function harvestFromHtml(
  html: string,
  found: Map<string, FoundVehicle>,
): number {
  const before = found.size;
  VEHICLE_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VEHICLE_URL_RE.exec(html)) !== null) {
    const [whole, type, make, model, id] = m;
    if (!found.has(id)) {
      found.set(id, {
        id,
        href: `https://turo.com${whole}`,
        make: make.replace(/-/g, " "),
        model: model.replace(/-/g, " "),
        type,
      });
    }
  }
  CAR_DETAILS_RE.lastIndex = 0;
  while ((m = CAR_DETAILS_RE.exec(html)) !== null) {
    const id = m[1];
    if (!found.has(id)) {
      found.set(id, {
        id,
        href: `https://turo.com/us/en/car-details/${id}`,
        make: "",
        model: "",
        type: "car-rental",
      });
    }
  }
  return found.size - before;
}

// Build Turo /search URL for a city using its coordinates + place_id.
function buildSearchUrl(
  city: { name: string; region: string | null; latitude: number; longitude: number; place_id: string | null },
  opts: { minPrice?: number; maxPrice?: number } = {},
): string {
  const params = new URLSearchParams({
    age: "30",
    country: "US",
    defaultZoomLevel: "11",
    deliveryLocationType: "city",
    isMapSearch: "false",
    itemsPerPage: "200",
    latitude: String(city.latitude),
    longitude: String(city.longitude),
    location: `${city.name}, ${city.region ?? ""}, USA`.replace(/, ,/g, ","),
    locationType: "CITY",
    pickupType: "ALL",
    region: city.region ?? "",
    searchDurationType: "DAILY",
    sortType: "RELEVANCE",
    flexibleType: "NOT_FLEXIBLE",
  });
  if (city.place_id) params.set("placeId", city.place_id);
  if (opts.minPrice != null) params.set("minDailyPrice", String(opts.minPrice));
  if (opts.maxPrice != null) params.set("maxDailyPrice", String(opts.maxPrice));
  return `https://turo.com/us/en/search?${params.toString()}`;
}

async function discoverVehicleIds(
  city: { name: string; region: string | null; latitude: number; longitude: number; place_id: string | null },
  citySlugInUrl: string,
): Promise<FoundVehicle[]> {
  const found = new Map<string, FoundVehicle>();

  // --- Step 1: Turo /search endpoint (up to 200 results per request) ---
  // First an unfiltered pull, then split by price buckets to exceed the cap.
  console.log(`[search] unfiltered`);
  try {
    const res = await zyteText(buildSearchUrl(city), { browser: true });
    if (res.status === 200) {
      const added = harvestFromHtml(res.body, found);
      console.log(`  search unfiltered: +${added} (total ${found.size})`);
    } else {
      console.warn(`  search unfiltered: status ${res.status}`);
    }
  } catch (e) {
    console.warn(`  search unfiltered failed:`, e);
  }

  for (const [lo, hi] of PRICE_BUCKETS) {
    try {
      const res = await zyteText(buildSearchUrl(city, { minPrice: lo, maxPrice: hi }), { browser: true });
      if (res.status !== 200) continue;
      const added = harvestFromHtml(res.body, found);
      console.log(`  search $${lo}-${hi}: +${added} (total ${found.size})`);
    } catch (e) {
      console.warn(`  search $${lo}-${hi} failed:`, e);
    }
  }

  console.log(`[search] done with ${found.size} vehicles, falling back to category pages`);

  // --- Step 2: Category landing pages as fallback (catches anything missed) ---
  // Category fallback uses a city-scoped regex to avoid mis-attributing vehicles.
  const cityRe = new RegExp(
    `/us/en/([a-z-]+-rental)/united-states/${citySlugInUrl}/([a-z0-9-]+)/([a-z0-9-]+)/(\\d{4,8})`,
    "g",
  );

  for (const cat of CATEGORY_SLUGS) {
    for (const [lo, hi] of PRICE_BUCKETS) {
      const url = `https://turo.com/us/en/${cat}/united-states/${citySlugInUrl}?minDailyPrice=${lo}&maxDailyPrice=${hi}`;
      let res;
      try {
        res = await zyteText(url);
      } catch (e) {
        console.warn(`landing fetch failed: ${cat} $${lo}-${hi}`, e);
        continue;
      }
      if (res.status !== 200) continue;
      const before = found.size;
      let m: RegExpExecArray | null;
      cityRe.lastIndex = 0;
      while ((m = cityRe.exec(res.body)) !== null) {
        const [whole, type, make, model, id] = m;
        if (!found.has(id)) {
          found.set(id, {
            id,
            href: `https://turo.com${whole}`,
            make: make.replace(/-/g, " "),
            model: model.replace(/-/g, " "),
            type,
          });
        }
      }
      console.log(`  ${cat} $${lo}-${hi}: +${found.size - before} (total ${found.size})`);
    }
  }
  return [...found.values()];
}

// ---------- Detail parsing ----------
type LdProduct = {
  productID?: string;
  name?: string;
  description?: string;
  image?: string[] | string;
  offers?: { price?: number; priceCurrency?: string };
  aggregateRating?: { ratingValue?: number; ratingCount?: number };
  brand?: { name?: string };
};

function extractLdProduct(html: string): LdProduct | null {
  // Turo embeds JSON-LD inside __next_s pushes:
  //   self.__next_s=self.__next_s||[]).push([0,{"type":"application/ld+json","children":"{ ... escaped json ... }"}])
  // We find the children string and JSON.parse it (it's a JSON-encoded JSON string).
  const re = /"type":"application\/ld\+json","children":"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      // m[1] is a JSON-string-escaped value. Wrap and parse to unescape.
      const inner = JSON.parse(`"${m[1]}"`) as string;
      const obj = JSON.parse(inner);
      if (obj && obj["@type"] === "Product") return obj as LdProduct;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function parseYearAndModel(name: string | undefined, fallbackModel: string) {
  // e.g. "BMW Z4 2020 rental in Honolulu, HI by Gabriel | Turo"
  // or  "2020 BMW Z4 rental in Honolulu, HI by Gabriel | Turo"
  if (!name) return { year: null as number | null, model: fallbackModel };
  const ym = name.match(/(\d{4})/);
  const year = ym ? parseInt(ym[1], 10) : null;
  // Try to derive model from "{make} {model} {year} rental..." or "{year} {make} {model} rental..."
  let model = fallbackModel;
  if (!model) {
    const mRental = name.match(/^(.+?)\s+rental in/i);
    if (mRental) {
      const tokens = mRental[1].split(/\s+/).filter((t) => !/^\d{4}$/.test(t));
      if (tokens.length >= 2) model = tokens.slice(1).join(" "); // drop make
    }
  }
  return { year, model };
}

async function fetchVehicle(
  v: { id: string; href: string; make: string; model: string; type: string },
  citySlug: string,
) {
  const res = await zyteText(v.href);
  if (res.status !== 200) {
    console.warn(`detail ${v.id}: status ${res.status}`);
    return null;
  }
  const ld = extractLdProduct(res.body);
  if (!ld) {
    console.warn(`detail ${v.id}: no JSON-LD Product`);
    return null;
  }
  const { year, model } = parseYearAndModel(ld.name, v.model);
  const make = ld.brand?.name ?? v.make ?? null;
  // Prefer the explicit "$NNN/day" value from the meta description / page text.
  // Turo's JSON-LD offers.price is unreliable: it varies with the page's default
  // trip dates and sometimes returns a multi-day total instead of the daily rate
  // (e.g. a Lamborghini Urus showing $312/day was stored as $1,760 from offers.price).
  let price: number | null = null;
  const dailyMatch = res.body.match(/\$\s*([\d,]+(?:\.\d+)?)\s*\/\s*day/i);
  if (dailyMatch) {
    const n = parseFloat(dailyMatch[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) price = n;
  }
  if (price == null && typeof ld.offers?.price === "number") {
    price = ld.offers.price;
  }
  const currency = ld.offers?.priceCurrency ?? "USD";
  const rating = typeof ld.aggregateRating?.ratingValue === "number" ? ld.aggregateRating.ratingValue : null;
  const trips = typeof ld.aggregateRating?.ratingCount === "number" ? ld.aggregateRating.ratingCount : null;
  const image = Array.isArray(ld.image) ? ld.image[0] : ld.image ?? null;

  // type slug like "exotic-luxury-rental" -> "EXOTIC"
  const typeMap: Record<string, string> = {
    "car-rental": "CAR",
    "suv-rental": "SUV",
    "truck-rental": "TRUCK",
    "minivan-rental": "MINIVAN",
    "van-rental": "VAN",
    "sports-rental": "SPORTS",
    "exotic-luxury-rental": "EXOTIC",
    "convertible-rental": "CONVERTIBLE",
    "electric-vehicle-rental": "EV",
  };

  return {
    vehicle_id: v.id,
    city: citySlug,
    make: make ? String(make) : null,
    model: model
      ? model.replace(/\b\w/g, (c) => c.toUpperCase())
      : null,
    year,
    trim: null,
    vehicle_type: typeMap[v.type] ?? null,
    fuel_type: v.type === "electric-vehicle-rental" ? "Electric" : null,
    avg_daily_price: price,
    currency,
    completed_trips: trips,
    rating,
    is_all_star_host: false,
    host_id: null,
    host_name: null,
    image_url: image ?? null,
    listing_url: v.href,
    location_city: null,
    location_state: null,
    latitude: null,
    longitude: null,
    last_scraped_at: new Date().toISOString(),
  };
}

// ---------- Orchestrator ----------
async function runScrape(citySlug: string) {
  const startedAt = new Date().toISOString();
  const { data: runRow } = await supabase
    .from("scrape_runs")
    .insert({ city: citySlug, status: "running", started_at: startedAt })
    .select()
    .single();
  const runId = runRow?.id as string | undefined;

  try {
    const { data: city, error: cErr } = await supabase
      .from("cities")
      .select("*")
      .eq("slug", citySlug)
      .single();
    if (cErr || !city) throw new Error(`Unknown city ${citySlug}`);

    const urlSlug = cityUrlSlug({ name: city.name, region: city.region });
    console.log(`Discovering vehicles for ${citySlug} (urlSlug=${urlSlug})`);
    const found = await discoverVehicleIds(
      {
        name: city.name,
        region: city.region,
        latitude: Number(city.latitude),
        longitude: Number(city.longitude),
        place_id: city.place_id,
      },
      urlSlug,
    );
    console.log(`Discovered ${found.length} unique vehicle URLs`);

    if (runId) {
      await supabase
        .from("scrape_runs")
        .update({ segments_run: CATEGORY_SLUGS.length })
        .eq("id", runId);
    }

    // Fetch detail pages with limited concurrency
    const CONCURRENCY = 5;
    const vehicles: any[] = [];
    let i = 0;
    async function worker() {
      while (i < found.length) {
        const idx = i++;
        const v = found[idx];
        try {
          const row = await fetchVehicle(v, citySlug);
          if (row) vehicles.push(row);
        } catch (e) {
          console.warn(`vehicle ${v.id} error:`, e);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`Parsed ${vehicles.length} vehicles with prices`);

    if (vehicles.length) {
      const { error: upErr } = await supabase
        .from("listings_current")
        .upsert(vehicles, { onConflict: "vehicle_id" });
      if (upErr) throw upErr;

      const snaps = vehicles.map((v) => {
        const { last_scraped_at, ...rest } = v;
        return { ...rest, scraped_at: startedAt };
      });
      const { error: snapErr } = await supabase
        .from("listings_snapshots")
        .insert(snaps);
      if (snapErr) console.error("snapshot insert:", snapErr.message);
    }

    if (runId) {
      await supabase
        .from("scrape_runs")
        .update({
          status: vehicles.length ? "ok" : "empty",
          vehicles_count: vehicles.length,
          finished_at: new Date().toISOString(),
        })
        .eq("id", runId);
    }
    return { ok: true, vehicles: vehicles.length, discovered: found.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("scrape-turo error:", msg);
    if (runId) {
      await supabase
        .from("scrape_runs")
        .update({
          status: "error",
          error_message: msg,
          finished_at: new Date().toISOString(),
        })
        .eq("id", runId);
    }
    return { ok: false, error: msg };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const city = String(body?.city ?? "").trim();
    const all = !!body?.all || (!city);
    // Single-city invocations always run in the background so the HTTP
    // response is immediate and we don't hit the 150s edge timeout.
    const background = !!body?.background || !all;

    // Resolve target cities
    let targets: string[] = [];
    if (all) {
      const { data, error } = await supabase
        .from("cities")
        .select("slug")
        .eq("active", true);
      if (error) throw error;
      targets = (data ?? []).map((r: any) => r.slug);
      if (!targets.length) {
        return new Response(JSON.stringify({ error: "no active cities" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } else {
      targets = [city];
    }

    // Fan-out: when scraping multiple cities, invoke this same function
    // once per city so each one gets its own 150s budget. Each child runs
    // in background mode and returns immediately.
    if (all && targets.length > 1) {
      const url = `${SUPABASE_URL}/functions/v1/scrape-turo`;
      await Promise.all(
        targets.map((slug) =>
          fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${SERVICE_ROLE}`,
              apikey: SERVICE_ROLE,
            },
            body: JSON.stringify({ city: slug, background: true }),
          }).catch((e) => console.warn(`fan-out ${slug} failed:`, e)),
        ),
      );
      return new Response(JSON.stringify({ ok: true, queued: true, cities: targets }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Single city (or single-target "all") — run inline or in background.
    if (background) {
      // @ts-ignore EdgeRuntime is provided by Supabase runtime
      EdgeRuntime.waitUntil(runScrape(targets[0]));
      return new Response(JSON.stringify({ ok: true, queued: true, city: targets[0] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const r = await runScrape(targets[0]);
    return new Response(JSON.stringify({ ok: r.ok, result: r }), {
      status: r.ok ? 200 : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
