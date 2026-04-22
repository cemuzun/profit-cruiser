// Turo daily-pricing scraper using rotating residential proxies (Geonix).
// Calls Turo's official `daily_pricing` endpoint with randomized UA/headers,
// fresh proxy session per request, and automatic retries.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "jsr:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PROXY_URL = Deno.env.get("GEONIX_PROXY_URL"); // http://user:pass@host:port

const UAS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
];
const LOCALES = ["en-US,en;q=0.9", "en-GB,en;q=0.9", "en-US,en;q=0.8,fr;q=0.6"];
const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
const rand = () => Math.random().toString(36).slice(2, 10);

function buildProxyWithSession(sessionId: string): string | null {
  if (!PROXY_URL) return null;
  // Geonix supports sticky sessions via username suffix: user-session-XXX
  try {
    const u = new URL(PROXY_URL);
    const user = decodeURIComponent(u.username);
    u.username = encodeURIComponent(`${user}-session-${sessionId}`);
    return u.toString();
  } catch {
    return PROXY_URL;
  }
}

function extractVehicleId(url: string): string | null {
  const m = url.match(/\/(\d{5,})(?:[/?#]|$)/);
  return m ? m[1] : null;
}

function fmtMDY(d: Date) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

async function fetchPricing(vehicleId: string, start: string, end: string, attempt = 1): Promise<any> {
  const sessionId = rand();
  const proxy = buildProxyWithSession(sessionId);
  const url = `https://turo.com/api/vehicle/daily_pricing?vehicleId=${vehicleId}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const headers: Record<string, string> = {
    "User-Agent": pick(UAS),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": pick(LOCALES),
    "Referer": `https://turo.com/us/en/car-details/${vehicleId}`,
    "x-requested-with": "XMLHttpRequest",
  };

  try {
    const init: RequestInit & { client?: Deno.HttpClient } = { headers, signal: AbortSignal.timeout(30000) };
    if (proxy) {
      // Deno supports HTTP/HTTPS proxies via createHttpClient
      // @ts-ignore - createHttpClient is available in Deno Deploy edge runtime
      const client = Deno.createHttpClient({ proxy: { url: proxy } });
      init.client = client;
    }
    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } catch (e) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
      return fetchPricing(vehicleId, start, end, attempt + 1);
    }
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { vehicleUrl, vehicleIds, startDate, endDate } = body as {
      vehicleUrl?: string;
      vehicleIds?: string[];
      startDate?: string;
      endDate?: string;
    };

    // Default date range: 30 days from today → 13 months ahead
    const now = new Date();
    const defStart = new Date(now); defStart.setDate(defStart.getDate() + 30);
    const defEnd = new Date(now); defEnd.setMonth(defEnd.getMonth() + 13);
    const start = startDate ?? fmtMDY(defStart);
    const end = endDate ?? fmtMDY(defEnd);

    // Resolve target vehicle list
    let targets: string[] = [];
    if (vehicleUrl) {
      const id = extractVehicleId(vehicleUrl);
      if (!id) throw new Error("Could not extract vehicleId from vehicleUrl");
      targets = [id];
    } else if (Array.isArray(vehicleIds) && vehicleIds.length) {
      targets = vehicleIds;
    } else {
      // Fallback: scrape pricing for everything in watchlist
      const supa = createClient(SUPABASE_URL, SERVICE_ROLE);
      const { data, error } = await supa.from("watchlist").select("vehicle_id");
      if (error) throw error;
      targets = (data ?? []).map((r) => r.vehicle_id);
    }

    if (!targets.length) {
      return new Response(JSON.stringify({ ok: true, message: "No vehicles to scrape." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supa = createClient(SUPABASE_URL, SERVICE_ROLE);
    const results: any[] = [];

    for (const vehicleId of targets) {
      try {
        const data = await fetchPricing(vehicleId, start, end);
        const daily: any[] = data?.dailyPricingResponses ?? [];
        const prices = daily
          .filter((d) => !d.wholeDayUnavailable && typeof d.price === "number")
          .map((d) => Number(d.price));

        // Compute simple 7/14/30-day forward averages and persist
        const wins = [
          { label: "7d", days: 7 },
          { label: "14d", days: 14 },
          { label: "30d", days: 30 },
        ];
        const scrapedAt = new Date().toISOString();
        const ws = new Date(start.split("/").reverse().join("-")).toISOString().slice(0, 10);
        for (const w of wins) {
          const slice = prices.slice(0, w.days);
          if (!slice.length) continue;
          const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
          const we = new Date(); we.setDate(we.getDate() + w.days);
          await supa.from("price_forecasts").insert({
            vehicle_id: vehicleId,
            city: "unknown",
            window_label: w.label,
            avg_price: avg,
            min_price: Math.min(...slice),
            max_price: Math.max(...slice),
            window_start: ws,
            window_end: we.toISOString().slice(0, 10),
            scraped_at: scrapedAt,
          });
        }

        // Update listings_current price averages if vehicle exists
        if (prices.length) {
          const a7 = prices.slice(0, 7); const a14 = prices.slice(0, 14); const a30 = prices.slice(0, 30);
          const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
          await supa.from("listings_current").update({
            price_7d_avg: avg(a7),
            price_14d_avg: avg(a14),
            price_30d_avg: avg(a30),
            last_scraped_at: scrapedAt,
          }).eq("vehicle_id", vehicleId);
        }

        results.push({ vehicleId, ok: true, days: daily.length, sampledPrices: prices.length });
      } catch (e) {
        results.push({ vehicleId, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return new Response(JSON.stringify({ ok: true, dateRange: { start, end }, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("turo-pricing error:", e);
    return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
