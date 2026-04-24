// Turo scraper using Zyte API + SSR HTML + JSON-LD.
//
// Strategy (no auth, no browser, Cloudflare bypass via proxy rotation):
//   1. Fetch Turo's official sitemaps to discover landing-page URLs for the
//      city across all categories (car-rental, suv-rental, exotic-luxury, etc.)
//   2. Fetch each landing page (plain HTTP via Zyte or backup proxies) and extract
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
const TURO_PROXY_URL = Deno.env.get("TURO_PROXY_URL") ?? "";
const GEONIX_PROXY_URL = Deno.env.get("GEONIX_PROXY_URL") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

// Strip listed keys from `obj` if their value is null/undefined.
// Use before upsert so a failed-parse fetch doesn't blank out good data.
function stripNulls<T extends Record<string, unknown>>(obj: T, keys: string[]): Partial<T> {
  const out: Record<string, unknown> = { ...obj };
  for (const k of keys) {
    if (out[k] == null) delete out[k];
  }
  return out as Partial<T>;
}

// Detect Cloudflare interstitials / "Just a moment" / empty pages.
// If we get one of these, the body is junk and must NOT be parsed as a listing.
function isBlockedPage(body: string): boolean {
  if (!body || body.length < 500) return true;
  const head = body.slice(0, 4000).toLowerCase();
  if (head.includes("just a moment")) return true;
  if (head.includes("cf-mitigated") || head.includes("cf-chl-")) return true;
  if (head.includes("attention required") && head.includes("cloudflare")) return true;
  if (head.includes("challenge-platform")) return true;
  if (head.includes("enable javascript and cookies")) return true;
  return false;
}

// Backup proxy fetch using TURO_PROXY_URL (Geonix-based service)
async function backupProxyText(url: string): Promise<{ status: number; body: string }> {
  const proxyUrl = TURO_PROXY_URL || GEONIX_PROXY_URL;
  if (!proxyUrl) return { status: 0, body: "" };
  try {
    const target = encodeURIComponent(url);
    const res = await fetch(`${proxyUrl}?url=${target}`, {
      method: "GET",
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "DNT": "1",
        "Connection": "keep-alive",
      },
    });
    if (!res.ok) {
      console.warn(`backup proxy ${res.status} for ${url}`);
      return { status: res.status, body: "" };
    }
    const body = await res.text();
    return { status: res.status, body };
  } catch (e) {
    console.warn(`backup proxy threw for ${url}:`, e);
    return { status: 0, body: "" };
  }
}

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
  filters?: {
    vehicle_types: string[];
    min_daily_price: number | null;
    max_daily_price: number | null;
  } | null,
): Promise<FoundVehicle[]> {
  const found = new Map<string, FoundVehicle>();

  // NOTE: Turo's /search page loads results via XHR — even with JS rendering
  // it only returns ~4-6 vehicles per request and is very slow (3+ min for 9
  // requests). Category landing pages are SSR'd and return 30-40 per page,
  // so we rely solely on them.

  // --- Category landing pages (SSR, fast, 30-40 vehicles per page) ---
  // Category fallback uses a city-scoped regex to avoid mis-attributing vehicles.
  const cityRe = new RegExp(
    `/us/en/([a-z-]+-rental)/united-states/${citySlugInUrl}/([a-z0-9-]+)/([a-z0-9-]+)/(\\d{4,8})`,
    "g",
  );

  const activeCats = filters?.vehicle_types?.length
    ? CATEGORY_SLUGS.filter((c) => filters!.vehicle_types.includes(c))
    : CATEGORY_SLUGS;

  const minP = filters?.min_daily_price ?? null;
  const maxP = filters?.max_daily_price ?? null;
  const activeBuckets = PRICE_BUCKETS.filter(([lo, hi]) => {
    if (minP != null && hi <= minP) return false;
    if (maxP != null && lo >= maxP) return false;
    return true;
  }).map(([lo, hi]) => [
    minP != null ? Math.max(lo, minP) : lo,
    maxP != null ? Math.min(hi, maxP) : hi,
  ] as [number, number]);

  for (const cat of activeCats) {
    for (const [lo, hi] of activeBuckets) {
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
  let res = await zyteText(v.href);
  let source = "zyte";

  // If Zyte got a non-200 OR a Cloudflare challenge page, try backup proxy.
  if (res.status !== 200 || isBlockedPage(res.body) || !extractLdProduct(res.body)) {
    console.warn(`detail ${v.id}: zyte status=${res.status} blocked=${isBlockedPage(res.body)} — trying backup proxy`);
    const bp = await backupProxyText(v.href);
    if (bp.body && !isBlockedPage(bp.body) && extractLdProduct(bp.body)) {
      res = bp;
      source = "backup_proxy";
    }
  }

  if (res.status !== 200 && source === "zyte") {
    console.warn(`detail ${v.id}: status ${res.status}, no fallback succeeded`);
    return null;
  }
  if (isBlockedPage(res.body)) {
    console.warn(`detail ${v.id}: blocked page from both providers — skipping`);
    return null;
  }

  const ld = extractLdProduct(res.body);
  if (!ld) {
    console.warn(`detail ${v.id}: no JSON-LD Product (source=${source})`);
    return null;
  }
  const { year, model } = parseYearAndModel(ld.name, v.model);
  const make = ld.brand?.name ?? v.make ?? null;

  // Price extraction with cross-validation against multiple source signals.
  // Turo's `offers.price` in JSON-LD is UNRELIABLE — it often returns a
  // multi-day total, weekly rate, or aggregate. We only trust it when at
  // least one other source agrees (within ±40%).
  //
  // Sources, in order of trust:
  //   1. Visible "$NNN/day" text in SSR HTML (most reliable)
  //   2. data-testid="search-result-price" / "vehicle-price" attributes
  //   3. ld.offers.lowPrice (Turo's true daily floor when range is given)
  //   4. ld.offers.price (LAST RESORT — must cross-validate)
  const HARD_MAX_DAILY = 2500; // Even hypercars rarely exceed this on Turo
  const HARD_MIN_DAILY = 15;

  const candidates: Array<{ value: number; source: string }> = [];

  // Source 1: "$NNN/day" or "$NNN per day"
  const dailyMatch = res.body.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:\/\s*day|per\s+day)/i);
  if (dailyMatch) {
    const n = parseFloat(dailyMatch[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n >= HARD_MIN_DAILY && n <= HARD_MAX_DAILY) {
      candidates.push({ value: n, source: "per-day-text" });
    }
  }

  // Source 2: data-testid attribute (Turo's React render)
  const testIdMatch = res.body.match(/data-testid=["'](?:search-result-price|vehicle-price|daily-price)["'][^>]*>\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
  if (testIdMatch) {
    const n = parseFloat(testIdMatch[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n >= HARD_MIN_DAILY && n <= HARD_MAX_DAILY) {
      candidates.push({ value: n, source: "testid" });
    }
  }

  // Source 3: lowPrice from offers (this is genuinely the daily rate when present)
  if (typeof (ld.offers as any)?.lowPrice === "number") {
    const n = (ld.offers as any).lowPrice as number;
    if (n >= HARD_MIN_DAILY && n <= HARD_MAX_DAILY) {
      candidates.push({ value: n, source: "ld-lowPrice" });
    }
  }

  // Source 4: ld.offers.price — only as cross-validation, never alone
  let ldPriceCandidate: number | null = null;
  if (typeof ld.offers?.price === "number") {
    const n = ld.offers.price;
    if (n >= HARD_MIN_DAILY && n <= HARD_MAX_DAILY) {
      ldPriceCandidate = n;
    }
  }

  let price: number | null = null;
  if (candidates.length > 0) {
    // Use the most-trusted candidate (first in array)
    price = candidates[0].value;
    // If ld.offers.price is wildly off from the trusted source, log it
    if (ldPriceCandidate && Math.abs(ldPriceCandidate - price) / price > 0.4) {
      console.warn(
        `detail ${v.id}: ld.offers.price=${ldPriceCandidate} disagrees with ${candidates[0].source}=${price} — using trusted source`,
      );
    }
  } else if (ldPriceCandidate != null) {
    // No trusted source available — fall back to ld.offers.price as-is.
    // No ceiling: we want the real number even for $5k+/day hyper-exotics.
    price = ldPriceCandidate;
  }

  // Class-based MIN floor — drop absurdly low prices for premium vehicles.
  // Example: Lamborghini Urus parsed at $306/day is almost certainly a
  // promo/deposit/wrong-element parse, not a real daily rate.
  if (price != null) {
    const makeLc = (ld.brand?.name ?? v.make ?? "").toLowerCase();
    const minFloor = (() => {
      if (/ferrari|lamborghini|mclaren|bentley|rolls|aston|bugatti|koenigsegg|pagani/.test(makeLc)) return 500;
      if (/maserati|porsche|lucid|mercedes.*amg|bmw.*m[0-9]|audi.*r[s8]/.test(makeLc)) return 150;
      return 0;
    })();
    if (price < minFloor) {
      console.warn(
        `detail ${v.id}: price ${price} below class min ${minFloor} for ${makeLc} — dropping`,
      );
      await supabase.from("price_anomalies").insert({
        vehicle_id: v.id,
        city: citySlug,
        make: String(make ?? ""),
        model: model ?? null,
        year,
        attempted_price: price,
        previous_price: null,
        kept_price: null,
        reason: `below_class_min (floor=${minFloor})`,
        source,
        listing_url: v.href,
      });
      price = null;
    }
  }

  // Sanity guard: compare against previous price. Tightened from 5x to 3x
  // because $1760→$306 (5.75x drop) is implausible for a real price change.
  if (price != null) {
    const { data: prev } = await supabase
      .from("listings_current")
      .select("avg_daily_price")
      .eq("vehicle_id", v.id)
      .maybeSingle();
    const prevPrice = prev?.avg_daily_price ? Number(prev.avg_daily_price) : null;
    if (prevPrice && prevPrice > 0) {
      const ratio = price / prevPrice;
      if (ratio > 3 || ratio < 0.33) {
        console.warn(
          `detail ${v.id}: price ${price} differs >3x from prev ${prevPrice} (source=${source}) — dropping new price`,
        );
        await supabase.from("price_anomalies").insert({
          vehicle_id: v.id,
          city: citySlug,
          make: String(make ?? ""),
          model: model ?? null,
          year,
          attempted_price: price,
          previous_price: prevPrice,
          kept_price: prevPrice,
          reason: `change_guard_3x (ratio=${ratio.toFixed(2)})`,
          source,
          listing_url: v.href,
        });
        price = null;
      }
    }
  }

  const currency = ld.offers?.priceCurrency ?? "USD";
  const rating = typeof ld.aggregateRating?.ratingValue === "number" ? ld.aggregateRating.ratingValue : null;
  const trips = typeof ld.aggregateRating?.ratingCount === "number" ? ld.aggregateRating.ratingCount : null;
  const image = Array.isArray(ld.image) ? ld.image[0] : ld.image ?? null;

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
    model: model ? model.replace(/\b\w/g, (c) => c.toUpperCase()) : null,
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

    // Load active scrape filters (singleton row, id=1).
    const { data: filtRow } = await supabase
      .from("scrape_filters")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    const filters = filtRow && filtRow.enabled
      ? {
          vehicle_types: (filtRow.vehicle_types ?? []) as string[],
          fuel_types: ((filtRow.fuel_types ?? []) as string[]).map((f) => f.toUpperCase()),
          min_daily_price: filtRow.min_daily_price != null ? Number(filtRow.min_daily_price) : null,
          max_daily_price: filtRow.max_daily_price != null ? Number(filtRow.max_daily_price) : null,
          min_year: filtRow.min_year != null ? Number(filtRow.min_year) : null,
          max_year: filtRow.max_year != null ? Number(filtRow.max_year) : null,
          min_trips: filtRow.min_trips != null ? Number(filtRow.min_trips) : null,
          min_rating: filtRow.min_rating != null ? Number(filtRow.min_rating) : null,
        }
      : null;
    if (filters) {
      console.log(
        `Scrape filters active: types=${filters.vehicle_types.length || "all"} fuels=${filters.fuel_types.length || "all"} price=[${filters.min_daily_price ?? "-"},${filters.max_daily_price ?? "-"}] year=[${filters.min_year ?? "-"},${filters.max_year ?? "-"}] minTrips=${filters.min_trips ?? "-"} minRating=${filters.min_rating ?? "-"}`,
      );
    }

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
      filters,
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
          if (!row) continue;
          // Apply post-fetch filters: drop vehicles outside year/price/trips/rating/fuel.
          if (filters) {
            if (filters.min_year != null && row.year != null && row.year < filters.min_year) continue;
            if (filters.max_year != null && row.year != null && row.year > filters.max_year) continue;
            if (filters.min_daily_price != null && row.avg_daily_price != null && row.avg_daily_price < filters.min_daily_price) continue;
            if (filters.max_daily_price != null && row.avg_daily_price != null && row.avg_daily_price > filters.max_daily_price) continue;
            if (filters.min_trips != null && (row.completed_trips ?? 0) < filters.min_trips) continue;
            if (filters.min_rating != null && (row.rating ?? 0) < filters.min_rating) continue;
            // Fuel filter: only enforce when listing has a known fuel_type.
            // Listings with null fuel_type pass through (Turo doesn't always expose it).
            if (filters.fuel_types.length > 0 && row.fuel_type) {
              if (!filters.fuel_types.includes(String(row.fuel_type).toUpperCase())) continue;
            }
          }
          vehicles.push(row);
        } catch (e) {
          console.warn(`vehicle ${v.id} error:`, e);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`Parsed ${vehicles.length} vehicles with prices`);

    if (vehicles.length) {
      const cleaned = vehicles.map((v) =>
        stripNulls(v, ["avg_daily_price", "rating", "completed_trips", "image_url"]),
      );
      const { error: upErr } = await supabase
        .from("listings_current")
        .upsert(cleaned, { onConflict: "vehicle_id" });
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
    const vehicleId = String(body?.vehicleId ?? "").trim();
    const all = !!body?.all || (!city && !vehicleId);

    // Targeted single-vehicle refresh: re-fetch one listing and upsert.
    if (vehicleId) {
      const { data: existing, error: exErr } = await supabase
        .from("listings_current")
        .select("vehicle_id, city, listing_url, make, model, vehicle_type")
        .eq("vehicle_id", vehicleId)
        .single();
      if (exErr || !existing) {
        return new Response(JSON.stringify({ error: `vehicle ${vehicleId} not found` }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const href = existing.listing_url ||
        `https://turo.com/us/en/suv-rental/united-states/los-angeles-ca/x/x/${vehicleId}`;
      const row = await fetchVehicle(
        {
          id: vehicleId,
          href,
          make: existing.make ?? "",
          model: existing.model ?? "",
          type: (existing.vehicle_type ?? "car-rental").toLowerCase().includes("suv")
            ? "suv-rental"
            : "car-rental",
        },
        existing.city,
      );
      if (!row) {
        return new Response(JSON.stringify({ ok: false, error: "fetch returned null" }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Don't overwrite previously-good fields with null (price/rating/trips
      // can be null when the sanity guard rejects a parse, or when CF blocks).
      const cleanRow = stripNulls(row, ["avg_daily_price", "rating", "completed_trips", "image_url"]);
      const { error: upErr } = await supabase
        .from("listings_current")
        .upsert(cleanRow, { onConflict: "vehicle_id" });
      if (upErr) throw upErr;
      return new Response(JSON.stringify({ ok: true, vehicle: row }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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
