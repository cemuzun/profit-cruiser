// Scrape Turo listings for a given city (deep scan via price/vehicle-type segments)
// Direct fetch to Turo's public search endpoint. May break if Turo changes their API.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const CITIES: Record<string, { country: string; lat: number; lng: number; name: string }> = {
  "los-angeles": { country: "US", lat: 34.0522, lng: -118.2437, name: "Los Angeles" },
  "miami": { country: "US", lat: 25.7617, lng: -80.1918, name: "Miami" },
};

// Deep scan segments: price brackets x vehicle types
const PRICE_SEGMENTS: Array<[number, number]> = [
  [0, 50],
  [50, 80],
  [80, 120],
  [120, 180],
  [180, 300],
  [300, 1000],
];

const VEHICLE_TYPES = ["CAR", "SUV", "MINIVAN", "TRUCK", "VAN"];

const TURO_SEARCH_URL = "https://turo.com/api/v2/search";

function buildHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://turo.com/us/en/search",
    "Origin": "https://turo.com",
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

// Build a Deno HTTP client routing through the user's proxy if TURO_PROXY_URL is set.
// Supports http/https proxies with optional basic auth (http://user:pass@host:port).
function buildProxyClient(): Deno.HttpClient | undefined {
  const proxyUrl = Deno.env.get("TURO_PROXY_URL");
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    const basicAuth =
      u.username || u.password
        ? "Basic " +
          btoa(
            `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`,
          )
        : undefined;
    // Strip credentials from URL for the proxy field
    const cleanUrl = `${u.protocol}//${u.host}`;
    // @ts-ignore - Deno unstable API; available in supabase edge runtime
    return Deno.createHttpClient({
      proxy: { url: cleanUrl, basicAuth: basicAuth ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : undefined },
    });
  } catch (e) {
    console.error("Invalid TURO_PROXY_URL:", (e as Error).message);
    return undefined;
  }
}

let PROXY_CLIENT: Deno.HttpClient | undefined;

function pickupReturnDates() {
  const start = new Date();
  start.setDate(start.getDate() + 7);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 3);
  return {
    pickupDate: start.toISOString().slice(0, 10),
    pickupTime: "10:00",
    dropoffDate: end.toISOString().slice(0, 10),
    dropoffTime: "10:00",
  };
}

async function fetchSegment(citySlug: string, vehicleType: string, minPrice: number, maxPrice: number) {
  const city = CITIES[citySlug];
  if (!city) throw new Error(`Unknown city ${citySlug}`);
  const dates = pickupReturnDates();

  // Try Turo's search API. They use a complex GraphQL-ish endpoint; we'll try the v2 REST search.
  const params = new URLSearchParams({
    country: city.country,
    defaultZoomLevel: "11",
    isMapSearch: "false",
    itemsPerPage: "200",
    location: city.name,
    locationType: "City",
    pickupTime: `${dates.pickupDate}T${dates.pickupTime}`,
    returnTime: `${dates.dropoffDate}T${dates.dropoffTime}`,
    region: city.country,
    sortType: "RELEVANCE",
    types: vehicleType,
    minDailyPriceUSD: String(minPrice),
    maxDailyPriceUSD: String(maxPrice),
  });

  const url = `${TURO_SEARCH_URL}?${params.toString()}`;
  const fetchOpts: RequestInit & { client?: Deno.HttpClient } = {
    headers: buildHeaders(),
  };
  if (PROXY_CLIENT) fetchOpts.client = PROXY_CLIENT;
  const res = await fetch(url, fetchOpts);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Turo ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  // Response shape varies; try common locations
  const list =
    data?.searchResults ??
    data?.vehicles ??
    data?.list ??
    data?.results ??
    [];
  return Array.isArray(list) ? list : [];
}

function normalize(raw: any, citySlug: string) {
  const v = raw?.vehicle ?? raw;
  const id = String(v?.id ?? raw?.id ?? "");
  if (!id) return null;
  const make = v?.make ?? raw?.make ?? null;
  const model = v?.model ?? raw?.model ?? null;
  const year = Number(v?.year ?? raw?.year) || null;
  const trim = v?.trim ?? raw?.trim ?? null;
  const vehicleType = v?.type ?? raw?.type ?? null;
  const fuelType = v?.fuelTypeLabel ?? v?.fuelType ?? raw?.fuelType ?? null;
  const price =
    Number(
      raw?.avgDailyPrice?.amount ??
        raw?.avgDailyPrice ??
        raw?.dailyPrice?.amount ??
        raw?.dailyPriceWithCurrency?.amount ??
        raw?.rate?.amount,
    ) || null;
  const trips = Number(raw?.completedTrips ?? raw?.tripCount ?? v?.completedTrips) || 0;
  const rating = Number(raw?.rating ?? v?.rating ?? raw?.hostRating) || null;
  const allStar = Boolean(raw?.isAllStarHost ?? raw?.host?.allStarHost ?? false);
  const hostId = String(raw?.host?.id ?? raw?.owner?.id ?? "") || null;
  const hostName = raw?.host?.firstName ?? raw?.owner?.firstName ?? null;
  const image =
    raw?.images?.[0]?.originalImageUrl ??
    raw?.images?.[0]?.resizableUrlTemplate ??
    raw?.image?.url ??
    v?.image?.url ??
    null;
  const loc = raw?.location ?? v?.location ?? {};
  return {
    vehicle_id: id,
    city: citySlug,
    make,
    model,
    year,
    trim,
    vehicle_type: vehicleType,
    fuel_type: fuelType,
    avg_daily_price: price,
    currency: "USD",
    completed_trips: trips,
    rating,
    is_all_star_host: allStar,
    host_id: hostId,
    host_name: hostName,
    image_url: typeof image === "string" ? image.replace("{width}", "640").replace("{height}", "480") : null,
    location_city: loc?.city ?? null,
    location_state: loc?.state ?? null,
    latitude: Number(loc?.latitude) || null,
    longitude: Number(loc?.longitude) || null,
    raw: raw,
  };
}

async function runScrape(cities: string[]) {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  PROXY_CLIENT = buildProxyClient();
  console.log("Proxy configured:", PROXY_CLIENT ? "yes" : "no");

  const summary: any[] = [];

  for (const citySlug of cities) {
    const { data: runRow } = await supabase
      .from("scrape_runs")
      .insert({ city: citySlug, status: "running" })
      .select()
      .single();
    const runId = runRow?.id;

    const seen = new Map<string, any>();
    let segments = 0;
    let errorMsg: string | null = null;

    for (const vt of VEHICLE_TYPES) {
      for (const [minP, maxP] of PRICE_SEGMENTS) {
        try {
          const list = await fetchSegment(citySlug, vt, minP, maxP);
          segments++;
          for (const raw of list) {
            const n = normalize(raw, citySlug);
            if (n && !seen.has(n.vehicle_id)) seen.set(n.vehicle_id, n);
          }
          // small delay to be polite
          await new Promise((r) => setTimeout(r, 250));
        } catch (e: any) {
          errorMsg = e.message;
          console.error(`Segment failed ${citySlug}/${vt}/${minP}-${maxP}:`, e.message);
        }
      }
    }

    const rows = Array.from(seen.values());

    if (rows.length > 0) {
      // Insert snapshots in chunks
      const chunkSize = 200;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        await supabase.from("listings_snapshots").insert(chunk);
      }
      // Upsert current
      const currentRows = rows.map(({ raw, ...r }) => ({
        ...r,
        last_scraped_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));
      for (let i = 0; i < currentRows.length; i += chunkSize) {
        const chunk = currentRows.slice(i, i + chunkSize);
        await supabase.from("listings_current").upsert(chunk, { onConflict: "vehicle_id" });
      }
    }

    await supabase
      .from("scrape_runs")
      .update({
        status: rows.length > 0 ? "success" : (errorMsg ? "failed" : "empty"),
        vehicles_count: rows.length,
        segments_run: segments,
        error_message: errorMsg,
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);

    summary.push({ city: citySlug, count: rows.length, segments, error: errorMsg });
  }

  return new Response(JSON.stringify({ ok: true, summary }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
