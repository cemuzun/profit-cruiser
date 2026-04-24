// Turo per-vehicle calendar scraper.
//
// For each active vehicle in listings_current, capture the next 90 days of
// availability + per-day price. Two strategies, in order:
//
//   1. API: GET https://turo.com/api/vehicle/daily_pricing/v1
//          ?vehicleId=...&start=YYYY-MM-DD&end=YYYY-MM-DD
//      Returns JSON with per-day price + availability. Fast, structured.
//      (Same endpoint Turo's own booking widget calls.)
//
//   2. HTML fallback: parse the listing detail page for unavailable-day
//      markers in the calendar widget. Slower, less precise (no daily price)
//      but resilient to API changes/blocks.
//
// One row per (vehicle_id, day, captured_on) into listing_calendar_days.

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

const WINDOW_DAYS = 90;

// ---------- Fetch helpers ----------
async function zyteFetch(
  url: string,
  opts: { json?: boolean } = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch("https://api.zyte.com/v1/extract", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(ZYTE_API_KEY + ":"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      geolocation: "US",
      httpResponseBody: true,
      // Some Turo API endpoints require these headers to return JSON.
      ...(opts.json
        ? {
            customHttpRequestHeaders: [
              { name: "Accept", value: "application/json" },
              { name: "User-Agent", value: "Mozilla/5.0" },
            ],
          }
        : {}),
    }),
  });
  if (!res.ok) {
    return { status: res.status, body: "" };
  }
  const data = await res.json();
  const status = data.statusCode ?? 0;
  const raw = data.httpResponseBody as string | undefined;
  if (!raw) return { status, body: "" };
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { status, body: new TextDecoder().decode(bytes) };
}

async function backupProxyFetch(url: string): Promise<{ status: number; body: string }> {
  const proxyUrl = TURO_PROXY_URL || GEONIX_PROXY_URL;
  if (!proxyUrl) return { status: 0, body: "" };
  try {
    const res = await fetch(`${proxyUrl}?url=${encodeURIComponent(url)}`, {
      method: "GET",
      headers: { Accept: "application/json,text/html;q=0.9,*/*;q=0.8" },
    });
    const body = res.ok ? await res.text() : "";
    return { status: res.status, body };
  } catch {
    return { status: 0, body: "" };
  }
}

// ---------- Calendar parsing ----------
type DayRow = {
  vehicle_id: string;
  city: string | null;
  day: string;
  is_available: boolean | null;
  daily_price: number | null;
  currency: string;
  source: string;
};

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function buildDateRange(days: number): { start: string; end: string; all: string[] } {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const all: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    all.push(ymd(d));
  }
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + days - 1);
  return { start: ymd(start), end: ymd(end), all };
}

// Try Turo's daily_pricing API. Returns per-day rows on success, [] otherwise.
async function tryDailyPricingApi(
  vehicleId: string,
  city: string | null,
  start: string,
  end: string,
): Promise<DayRow[]> {
  const url = `https://turo.com/api/vehicle/daily_pricing/v1?vehicleId=${vehicleId}&start=${start}&end=${end}&country=US`;
  let res = await zyteFetch(url, { json: true });
  if (res.status !== 200 || !res.body) {
    res = await backupProxyFetch(url);
  }
  if (res.status !== 200 || !res.body) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return [];
  }
  // Endpoint shape varies. Look for arrays of {date, price, available} or
  // {date, customPrice, status} or nested under .dailyPricingResponses.
  const list: any[] =
    parsed?.dailyPricingResponses ??
    parsed?.dailyPrices ??
    parsed?.prices ??
    (Array.isArray(parsed) ? parsed : []);
  if (!Array.isArray(list) || list.length === 0) return [];

  const out: DayRow[] = [];
  for (const item of list) {
    const day = item?.date ?? item?.day;
    if (!day || typeof day !== "string") continue;
    const price =
      typeof item?.price === "number"
        ? item.price
        : typeof item?.customPrice === "number"
          ? item.customPrice
          : typeof item?.priceWithCurrency?.amount === "number"
            ? item.priceWithCurrency.amount
            : null;
    // Availability can come as boolean, status string, or "wholesalePriceWithCurrency" presence.
    let available: boolean | null = null;
    if (typeof item?.available === "boolean") available = item.available;
    else if (typeof item?.isAvailable === "boolean") available = item.isAvailable;
    else if (typeof item?.status === "string") {
      const s = item.status.toUpperCase();
      if (s.includes("AVAILABLE")) available = true;
      else if (s.includes("UNAVAILABLE") || s.includes("BOOKED") || s.includes("BLOCKED"))
        available = false;
    }
    out.push({
      vehicle_id: vehicleId,
      city,
      day: day.slice(0, 10),
      is_available: available,
      daily_price: price,
      currency: "USD",
      source: "api",
    });
  }
  return out;
}

// HTML fallback: parse listing detail page for blocked/unavailable days.
// Turo embeds calendar state inside __NEXT_DATA__ or inline JSON. We look for
// arrays of unavailable date strings in YYYY-MM-DD form.
async function tryHtmlFallback(
  vehicleId: string,
  city: string | null,
  listingUrl: string | null,
  allDays: string[],
): Promise<DayRow[]> {
  const href = listingUrl || `https://turo.com/us/en/car-details/${vehicleId}`;
  let res = await zyteFetch(href);
  if (res.status !== 200 || !res.body) {
    res = await backupProxyFetch(href);
  }
  if (!res.body) return [];

  // Heuristic: collect every YYYY-MM-DD inside an "unavailable"/"booked"/"blocked"
  // adjacent JSON segment. Scope each match to a small window around the keyword.
  const unavailable = new Set<string>();
  const re = /(unavailable|blocked|booked|reservedDates|unavailableDates)[^[{]{0,200}([\s\S]{0,2000})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(res.body)) !== null) {
    const segment = m[2];
    const dateRe = /(20\d{2}-[01]\d-[0-3]\d)/g;
    let dm: RegExpExecArray | null;
    while ((dm = dateRe.exec(segment)) !== null) {
      unavailable.add(dm[1]);
    }
  }
  if (unavailable.size === 0) return [];

  return allDays.map((day) => ({
    vehicle_id: vehicleId,
    city,
    day,
    is_available: !unavailable.has(day),
    daily_price: null,
    currency: "USD",
    source: "html",
  }));
}

// ---------- Orchestrator ----------
async function runCalendarScrape(opts: {
  city?: string;
  vehicleId?: string;
  limit?: number;
}) {
  const startedAt = new Date().toISOString();
  const { data: runRow } = await supabase
    .from("calendar_scrape_runs")
    .insert({ city: opts.city ?? null, status: "running", started_at: startedAt })
    .select()
    .single();
  const runId = runRow?.id as string | undefined;

  try {
    let q = supabase
      .from("listings_current")
      .select("vehicle_id, city, listing_url");
    if (opts.vehicleId) q = q.eq("vehicle_id", opts.vehicleId);
    else if (opts.city) q = q.eq("city", opts.city);
    if (opts.limit) q = q.limit(opts.limit);
    const { data: vehicles, error } = await q;
    if (error) throw error;
    const list = vehicles ?? [];
    if (!list.length) throw new Error("no vehicles to scrape");

    const { start, end, all } = buildDateRange(WINDOW_DAYS);

    let okCount = 0;
    let failCount = 0;
    let apiCount = 0;
    let htmlCount = 0;

    const CONCURRENCY = 4;
    let i = 0;
    async function worker() {
      while (i < list.length) {
        const idx = i++;
        const v = list[idx] as { vehicle_id: string; city: string | null; listing_url: string | null };
        try {
          let rows = await tryDailyPricingApi(v.vehicle_id, v.city, start, end);
          let usedSource = "api";
          if (rows.length === 0) {
            rows = await tryHtmlFallback(v.vehicle_id, v.city, v.listing_url, all);
            usedSource = "html";
          }
          if (rows.length === 0) {
            failCount++;
            continue;
          }
          // Upsert per (vehicle_id, day, captured_on). captured_on defaults to today.
          const { error: upErr } = await supabase
            .from("listing_calendar_days")
            .upsert(rows, { onConflict: "vehicle_id,day,captured_on" });
          if (upErr) {
            console.warn(`upsert fail ${v.vehicle_id}:`, upErr.message);
            failCount++;
            continue;
          }
          okCount++;
          if (usedSource === "api") apiCount++;
          else htmlCount++;
        } catch (e) {
          console.warn(`vehicle ${v.vehicle_id} error:`, e);
          failCount++;
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    if (runId) {
      await supabase
        .from("calendar_scrape_runs")
        .update({
          status: okCount > 0 ? "ok" : "empty",
          finished_at: new Date().toISOString(),
          vehicles_attempted: list.length,
          vehicles_ok: okCount,
          vehicles_failed: failCount,
          source_api_count: apiCount,
          source_html_count: htmlCount,
        })
        .eq("id", runId);
    }
    return {
      ok: true,
      attempted: list.length,
      ok_count: okCount,
      fail_count: failCount,
      api_count: apiCount,
      html_count: htmlCount,
      window_days: WINDOW_DAYS,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("scrape-calendar error:", msg);
    if (runId) {
      await supabase
        .from("calendar_scrape_runs")
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
    const city = body?.city ? String(body.city) : undefined;
    const vehicleId = body?.vehicleId ? String(body.vehicleId) : undefined;
    const limit = body?.limit ? Number(body.limit) : undefined;
    const background = !!body?.background;
    const probe = !!body?.probe;

    // Probe mode: try several candidate calendar endpoints + dump previews so
    // we can confirm the real shape Turo returns. Used to bootstrap the parser.
    if (probe && vehicleId) {
      const { start, end } = buildDateRange(WINDOW_DAYS);
      const candidates = [
        `https://turo.com/api/vehicle/daily_pricing/v1?vehicleId=${vehicleId}&start=${start}&end=${end}&country=US`,
        `https://turo.com/api/vehicle/daily_pricing?vehicleId=${vehicleId}&start=${start}&end=${end}`,
        `https://turo.com/api/vehicle_search/${vehicleId}/daily_pricing?startDate=${start}&endDate=${end}`,
        `https://turo.com/api/vehicle/${vehicleId}/daily_pricing?start=${start}&end=${end}`,
        `https://turo.com/api/vehicle/${vehicleId}/calendar?startDate=${start}&endDate=${end}`,
        `https://turo.com/api/v2/vehicles/${vehicleId}/daily_pricing?start=${start}&end=${end}`,
      ];
      const results: any[] = [];
      for (const u of candidates) {
        let r = await zyteFetch(u, { json: true });
        if (r.status !== 200) {
          const b = await backupProxyFetch(u);
          if (b.status === 200) r = b;
        }
        results.push({
          url: u,
          status: r.status,
          length: r.body.length,
          preview: r.body.slice(0, 800),
        });
      }
      // Also dump the listing detail page for HTML calendar reverse-engineering.
      const detailUrl = `https://turo.com/us/en/car-details/${vehicleId}`;
      const detail = await zyteFetch(detailUrl);
      const calendarHints: string[] = [];
      const re =
        /(unavailable|blocked|booked|reservedDates|unavailableDates|calendar|availability)[\s\S]{0,300}/gi;
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = re.exec(detail.body)) !== null && count < 8) {
        calendarHints.push(m[0].slice(0, 250));
        count++;
      }
      return new Response(
        JSON.stringify({ candidates: results, detail_status: detail.status, detail_len: detail.body.length, calendar_hints: calendarHints }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (background) {
      // @ts-ignore EdgeRuntime is provided by Supabase runtime
      EdgeRuntime.waitUntil(runCalendarScrape({ city, vehicleId, limit }));
      return new Response(JSON.stringify({ ok: true, queued: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const r = await runCalendarScrape({ city, vehicleId, limit });
    return new Response(JSON.stringify(r), {
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
