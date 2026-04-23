// Turo scraper using Zyte API as a proxy to Turo's internal search JSON API.
// Turo's search page is client-rendered, so __NEXT_DATA__ is empty. Instead we
// hit https://turo.com/api/v2/search (the same endpoint the SPA uses) through
// Zyte's httpResponseBody+anti-bot to bypass Cloudflare. Returns JSON directly.

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

async function zyteJson(url: string): Promise<any> {
  const res = await fetch("https://api.zyte.com/v1/extract", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(ZYTE_API_KEY + ":"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      httpResponseBody: true,
      geolocation: "US",
      // Tell Zyte this is an XHR / API request
      customHttpRequestHeaders: [
        { name: "Accept", value: "application/json" },
        { name: "Accept-Language", value: "en-US,en;q=0.9" },
        { name: "Referer", value: "https://turo.com/us/en/search" },
        { name: "x-csrf-token", value: "turo" },
      ],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Zyte ${res.status}: ${txt.slice(0, 400)}`);
  }
  const data = await res.json();
  if (!data.httpResponseBody) throw new Error("Zyte returned no httpResponseBody");
  // httpResponseBody is base64-encoded
  const decoded = atob(data.httpResponseBody);
  try {
    return JSON.parse(decoded);
  } catch {
    throw new Error(
      `Response was not JSON (status ${data.statusCode}). First 300 chars: ${decoded.slice(0, 300)}`,
    );
  }
}

function num(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function mapVehicle(v: any, city: string) {
  const id = String(v.id ?? v.vehicleId ?? "");
  if (!id) return null;
  const make = v.make ?? v?.vehicle?.make ?? null;
  const model = v.model ?? v?.vehicle?.model ?? null;
  const year = num(v.year ?? v?.vehicle?.year);
  const trim = v.trim ?? v?.vehicle?.trim ?? null;
  const price =
    num(v?.avgDailyPrice?.amount) ??
    num(v?.dailyPricing?.priceWithCurrency?.amount) ??
    num(v?.rate?.amount) ??
    num(v?.dailyPriceWithCurrency?.amount) ??
    num(v?.dailyPrice);
  const trips = num(v?.completedTrips ?? v?.numberOfTrips ?? v?.trips);
  const rating = num(v?.rating ?? v?.hostRating ?? v?.host?.rating);
  const lat = num(v?.location?.latitude ?? v?.latitude);
  const lon = num(v?.location?.longitude ?? v?.longitude);
  const cityName = v?.location?.city ?? null;
  const state = v?.location?.state ?? null;
  const image =
    v?.images?.[0]?.originalImageUrl ??
    v?.images?.[0]?.url ??
    v?.image?.originalImageUrl ??
    v?.imageUrl ??
    null;
  const hostId = v?.host?.id ? String(v.host.id) : null;
  const hostName = v?.host?.firstName ?? v?.host?.name ?? null;
  const allStar = !!(v?.host?.allStarHost ?? v?.allStarHost);

  return {
    vehicle_id: id,
    city,
    make,
    model,
    year: year ? Math.round(year) : null,
    trim,
    vehicle_type: v?.type ?? v?.vehicle?.type ?? v?.vehicleType ?? null,
    fuel_type: v?.fuelType ?? v?.vehicle?.fuelType ?? null,
    avg_daily_price: price,
    currency:
      v?.avgDailyPrice?.currency ??
      v?.dailyPricing?.priceWithCurrency?.currencyCode ??
      "USD",
    completed_trips: trips ? Math.round(trips) : null,
    rating,
    is_all_star_host: allStar,
    host_id: hostId,
    host_name: hostName,
    image_url: image,
    location_city: cityName,
    location_state: state,
    latitude: lat,
    longitude: lon,
    last_scraped_at: new Date().toISOString(),
  };
}

function buildSearchUrl(city: { name: string; latitude: number; longitude: number }) {
  const start = new Date();
  start.setDate(start.getDate() + 3);
  const end = new Date(start);
  end.setDate(end.getDate() + 3);
  const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // Turo's public search API
  const params = new URLSearchParams({
    country: "US",
    defaultZoomLevel: "11",
    itemsPerPage: "200",
    locationType: "CITY",
    region: "US",
    sortType: "RELEVANCE",
    location: city.name,
    latitude: String(city.latitude),
    longitude: String(city.longitude),
    pickupTime: `${fmtDate(start)}T10:00`,
    dropoffTime: `${fmtDate(end)}T10:00`,
  });
  return `https://turo.com/api/v2/search?${params.toString()}`;
}

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

    const url = buildSearchUrl({
      name: city.name,
      latitude: Number(city.latitude),
      longitude: Number(city.longitude),
    });
    console.log("Zyte fetching API:", url);

    const json = await zyteJson(url);

    // Turo returns { vehicles: [...], totalCount, ... } or { searchResults: [...] }
    const list: any[] =
      json?.vehicles ??
      json?.searchResults ??
      json?.results ??
      [];

    console.log(
      `API returned ${list.length} vehicles. Top-level keys: ${Object.keys(json ?? {}).join(",")}`,
    );

    const seen = new Set<string>();
    const vehicles = list
      .map((v) => mapVehicle(v, citySlug))
      .filter((v): v is NonNullable<typeof v> => {
        if (!v || !v.vehicle_id || seen.has(v.vehicle_id)) return false;
        seen.add(v.vehicle_id);
        return true;
      });

    if (vehicles.length) {
      const { error: upErr } = await supabase
        .from("listings_current")
        .upsert(vehicles, { onConflict: "vehicle_id" });
      if (upErr) throw upErr;

      const snaps = vehicles.map((v) => ({ ...v, scraped_at: startedAt }));
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
    return { ok: true, vehicles: vehicles.length };
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
    if (!city) {
      return new Response(JSON.stringify({ error: "city is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const background = !!body?.background;

    if (background) {
      // @ts-ignore EdgeRuntime is provided by Supabase runtime
      EdgeRuntime.waitUntil(runScrape(city));
      return new Response(JSON.stringify({ ok: true, queued: true, city }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await runScrape(city);
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 500,
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
