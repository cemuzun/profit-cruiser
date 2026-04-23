// Turo scraper using Zyte API (browserHtml + Cloudflare bypass).
// POST { city: "los-angeles" } — looks up coords from `cities`, calls Zyte
// for the Turo search page, parses __NEXT_DATA__ vehicles, upserts into
// listings_current + listings_snapshots + price_forecasts, logs scrape_runs.

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

type ZyteResponse = { browserHtml?: string; statusCode?: number };

async function zyteFetch(url: string): Promise<string> {
  const res = await fetch("https://api.zyte.com/v1/extract", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(ZYTE_API_KEY + ":"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      browserHtml: true,
      // Tell Zyte we're hitting an anti-bot protected site
      httpResponseBody: false,
      requestHeaders: {
        referer: "https://turo.com/",
      },
      // Geo-target US
      geolocation: "US",
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Zyte ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = (await res.json()) as ZyteResponse;
  if (!data.browserHtml) throw new Error("Zyte returned no browserHtml");
  return data.browserHtml;
}

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

// Walk arbitrary JSON looking for objects that look like Turo vehicle cards
function findVehicles(node: any, out: any[] = []): any[] {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const v of node) findVehicles(v, out);
    return out;
  }
  if (typeof node === "object") {
    const looksLikeVehicle =
      typeof node.id !== "undefined" &&
      (node.make || node.vehicleMake) &&
      (node.model || node.vehicleModel);
    if (looksLikeVehicle) out.push(node);
    for (const k of Object.keys(node)) findVehicles(node[k], out);
  }
  return out;
}

function num(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function mapVehicle(v: any, city: string) {
  const id = String(v.id ?? v.vehicleId ?? "");
  if (!id) return null;
  const make = v.make ?? v.vehicleMake ?? null;
  const model = v.model ?? v.vehicleModel ?? null;
  const year = num(v.year ?? v.vehicleYear);
  const trim = v.trim ?? null;
  const price =
    num(v?.avgDailyPrice?.amount) ??
    num(v?.dailyPricing?.priceWithCurrency?.amount) ??
    num(v?.rate?.amount) ??
    num(v?.dailyPrice);
  const trips = num(v?.completedTrips ?? v?.numberOfTrips ?? v?.trips);
  const rating = num(v?.rating ?? v?.hostRating);
  const lat = num(v?.location?.latitude ?? v?.latitude);
  const lon = num(v?.location?.longitude ?? v?.longitude);
  const cityName = v?.location?.city ?? null;
  const state = v?.location?.state ?? null;
  const image =
    v?.images?.[0]?.originalImageUrl ??
    v?.images?.[0]?.url ??
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
    vehicle_type: v?.type ?? v?.vehicleType ?? null,
    fuel_type: v?.fuelType ?? null,
    avg_daily_price: price,
    currency: v?.avgDailyPrice?.currency ?? "USD",
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

    const start = new Date();
    start.setDate(start.getDate() + 3);
    const end = new Date(start);
    end.setDate(end.getDate() + 3);
    const fmt = (d: Date) =>
      `${String(d.getMonth() + 1).padStart(2, "0")}/${String(
        d.getDate(),
      ).padStart(2, "0")}/${d.getFullYear()}`;

    const url =
      `https://turo.com/us/en/search?` +
      new URLSearchParams({
        country: "US",
        defaultZoomLevel: "11",
        endDate: fmt(end),
        endTime: "10:00",
        isMapSearch: "false",
        latitude: String(city.latitude),
        longitude: String(city.longitude),
        location: city.name,
        sortType: "RELEVANCE",
        startDate: fmt(start),
        startTime: "10:00",
      }).toString();

    console.log("Zyte fetching:", url);
    const html = await zyteFetch(url);
    const nextData = extractNextData(html);
    if (!nextData) throw new Error("No __NEXT_DATA__ found in HTML");

    const raw = findVehicles(nextData);
    const seen = new Set<string>();
    const vehicles = raw
      .map((v) => mapVehicle(v, citySlug))
      .filter((v): v is NonNullable<typeof v> => {
        if (!v || !v.vehicle_id || seen.has(v.vehicle_id)) return false;
        seen.add(v.vehicle_id);
        return true;
      });

    console.log(`Parsed ${vehicles.length} vehicles for ${citySlug}`);

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
          status: "ok",
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
