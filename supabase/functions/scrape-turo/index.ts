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
async function zyteText(url: string): Promise<{ status: number; body: string }> {
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
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Zyte ${res.status} for ${url}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const status = data.statusCode ?? 0;
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

async function discoverVehicleIds(citySlugInUrl: string): Promise<
  Array<{ id: string; href: string; make: string; model: string; type: string }>
> {
  const found = new Map<string, { id: string; href: string; make: string; model: string; type: string }>();
  const re = new RegExp(
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
      re.lastIndex = 0;
      while ((m = re.exec(res.body)) !== null) {
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
  if (!name) return { year: null as number | null, model: fallbackModel };
  const ym = name.match(/(\d{4})/);
  const year = ym ? parseInt(ym[1], 10) : null;
  return { year, model: fallbackModel };
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
  const { year } = parseYearAndModel(ld.name, v.model);
  const make = ld.brand?.name ?? v.make;
  const price = typeof ld.offers?.price === "number" ? ld.offers.price : null;
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
    model: v.model
      ? v.model.replace(/\b\w/g, (c) => c.toUpperCase())
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
    const found = await discoverVehicleIds(urlSlug);
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
    const background = !!body?.background;

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

    const runAll = async () => {
      const results: any[] = [];
      for (const slug of targets) {
        try {
          const r = await runScrape(slug);
          results.push({ city: slug, ...r });
        } catch (e) {
          results.push({ city: slug, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return results;
    };

    if (background) {
      // @ts-ignore EdgeRuntime is provided by Supabase runtime
      EdgeRuntime.waitUntil(runAll());
      return new Response(JSON.stringify({ ok: true, queued: true, cities: targets }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results = await runAll();
    const ok = results.every((r) => r.ok);
    return new Response(JSON.stringify({ ok, results }), {
      status: ok ? 200 : 500,
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
