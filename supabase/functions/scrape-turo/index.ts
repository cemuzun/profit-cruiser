// Scrape Turo via ARN HTTP proxy using a manually-implemented CONNECT tunnel.
// Supabase Edge Runtime ignores Deno.createHttpClient({ proxy }) in production,
// so we open a raw TCP socket to the proxy, send "CONNECT turo.com:443", upgrade
// to TLS with Deno.startTls, then speak HTTP/1.1 over the encrypted stream.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const CITIES: Record<string, { country: string; name: string }> = {
  "los-angeles": { country: "US", name: "Los Angeles" },
  "miami": { country: "US", name: "Miami" },
};

const PRICE_SEGMENTS: Array<[number, number]> = [
  [0, 50],
  [50, 80],
  [80, 120],
  [120, 180],
  [180, 300],
  [300, 1000],
];

const VEHICLE_TYPES = ["CAR", "SUV", "MINIVAN", "TRUCK", "VAN"];

const TURO_HOST = "turo.com";
const TURO_PORT = 443;

type ProxyConf = { host: string; port: number; user?: string; pass?: string };

function parseProxy(): ProxyConf | null {
  const raw = Deno.env.get("TURO_PROXY_URL");
  if (!raw) return null;
  const val = raw.trim();

  // Accept ARN-style "host:port:user:pass" format
  if (!val.includes("://")) {
    const parts = val.split(":");
    if (parts.length === 4) {
      return { host: parts[0], port: Number(parts[1]) || 80, user: parts[2], pass: parts[3] };
    }
    if (parts.length === 2) {
      return { host: parts[0], port: Number(parts[1]) || 80 };
    }
    console.error("Bad TURO_PROXY_URL: expected host:port:user:pass or URL");
    return null;
  }

  try {
    const u = new URL(val);
    return {
      host: u.hostname,
      port: Number(u.port) || 80,
      user: u.username ? decodeURIComponent(u.username) : undefined,
      pass: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch (e) {
    console.error("Bad TURO_PROXY_URL:", (e as Error).message);
    return null;
  }
}

function browserHeaders(pathAndQuery: string): string[] {
  return [
    `GET ${pathAndQuery} HTTP/1.1`,
    `Host: ${TURO_HOST}`,
    `User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`,
    `Accept: application/json, text/plain, */*`,
    `Accept-Language: en-US,en;q=0.9`,
    `Referer: https://turo.com/us/en/search`,
    `Origin: https://turo.com`,
    `X-Requested-With: XMLHttpRequest`,
    `Sec-Fetch-Dest: empty`,
    `Sec-Fetch-Mode: cors`,
    `Sec-Fetch-Site: same-origin`,
    `Connection: close`,
    `\r\n`, // end of headers
  ];
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<{ head: string; rest: Uint8Array }> {
  const td = new TextDecoder();
  let buf = new Uint8Array(0);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const next = new Uint8Array(buf.length + value.length);
    next.set(buf);
    next.set(value, buf.length);
    buf = next;
    const text = td.decode(buf, { stream: true });
    const idx = text.indexOf(marker);
    if (idx !== -1) {
      // Find byte offset of marker. Since headers are ASCII, byte == char index.
      const headBytes = idx + marker.length;
      return { head: text.slice(0, idx), rest: buf.slice(headBytes) };
    }
    if (buf.length > 65536) throw new Error("Header too large");
  }
  throw new Error("Connection closed before headers complete");
}

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>, initial: Uint8Array): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [initial];
  let total = initial.length;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > 20_000_000) throw new Error("Response too large");
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// Decode HTTP/1.1 chunked transfer-encoding
function dechunk(body: Uint8Array): Uint8Array {
  const td = new TextDecoder();
  const out: number[] = [];
  let i = 0;
  while (i < body.length) {
    // read size line
    let lineEnd = -1;
    for (let j = i; j < body.length - 1; j++) {
      if (body[j] === 0x0d && body[j + 1] === 0x0a) {
        lineEnd = j;
        break;
      }
    }
    if (lineEnd === -1) break;
    const sizeStr = td.decode(body.slice(i, lineEnd)).trim().split(";")[0];
    const size = parseInt(sizeStr, 16);
    if (isNaN(size)) throw new Error(`Bad chunk size: ${sizeStr}`);
    i = lineEnd + 2;
    if (size === 0) break;
    for (let k = 0; k < size; k++) out.push(body[i + k]);
    i += size + 2; // skip trailing CRLF
  }
  return new Uint8Array(out);
}

async function fetchViaProxy(proxy: ProxyConf, pathAndQuery: string): Promise<any> {
  // 1. Open raw TCP to proxy
  const conn = await Deno.connect({ hostname: proxy.host, port: proxy.port });

  try {
    // 2. Send CONNECT
    const auth =
      proxy.user || proxy.pass
        ? `Proxy-Authorization: Basic ${btoa(`${proxy.user ?? ""}:${proxy.pass ?? ""}`)}\r\n`
        : "";
    const connectReq =
      `CONNECT ${TURO_HOST}:${TURO_PORT} HTTP/1.1\r\n` +
      `Host: ${TURO_HOST}:${TURO_PORT}\r\n` +
      auth +
      `\r\n`;
    await conn.write(new TextEncoder().encode(connectReq));

    // 3. Read CONNECT response
    const reader = conn.readable.getReader();
    const { head: connectHead, rest: leftover } = await readUntil(reader, "\r\n\r\n");
    if (!/^HTTP\/1\.[01] 200/.test(connectHead)) {
      throw new Error(`Proxy CONNECT failed: ${connectHead.split("\r\n")[0]}`);
    }
    if (leftover.length > 0) {
      throw new Error("Unexpected data after CONNECT response");
    }
    reader.releaseLock();

    // 4. Upgrade socket to TLS
    const tls = await Deno.startTls(conn, { hostname: TURO_HOST });

    try {
      // 5. Send HTTP request over TLS
      const req = browserHeaders(pathAndQuery).join("\r\n");
      await tls.write(new TextEncoder().encode(req));

      // 6. Read response
      const tlsReader = tls.readable.getReader();
      const { head, rest } = await readUntil(tlsReader, "\r\n\r\n");
      const bodyBytes = await readAll(tlsReader, rest);

      // Parse status
      const statusLine = head.split("\r\n")[0];
      const statusMatch = statusLine.match(/HTTP\/1\.[01] (\d+)/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;

      // Detect chunked
      const isChunked = /transfer-encoding:\s*chunked/i.test(head);
      const finalBody = isChunked ? dechunk(bodyBytes) : bodyBytes;

      // Detect gzip — most servers won't gzip if we don't send Accept-Encoding,
      // and we don't, so we should be fine. But guard:
      if (/content-encoding:\s*(gzip|br|deflate)/i.test(head)) {
        throw new Error("Got encoded response — not supported");
      }

      const text = new TextDecoder().decode(finalBody);
      if (status !== 200) {
        throw new Error(`Turo ${status}: ${text.slice(0, 200)}`);
      }
      return JSON.parse(text);
    } finally {
      try { tls.close(); } catch { /* already closed */ }
    }
  } catch (e) {
    try { conn.close(); } catch { /* ignore */ }
    throw e;
  }
}

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

async function fetchSegment(proxy: ProxyConf, citySlug: string, vehicleType: string, minPrice: number, maxPrice: number) {
  const city = CITIES[citySlug];
  if (!city) throw new Error(`Unknown city ${citySlug}`);
  const dates = pickupReturnDates();

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

  const data = await fetchViaProxy(proxy, `/api/v2/search?${params.toString()}`);
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

async function runScrape(cities: string[], testMode = false) {
  const proxy = parseProxy();
  if (!proxy) throw new Error("TURO_PROXY_URL not configured");
  console.log(`Proxy: ${proxy.host}:${proxy.port} auth=${proxy.user ? "yes" : "no"}`);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const summary: any[] = [];
  const vts = testMode ? ["CAR"] : VEHICLE_TYPES;
  const segs = testMode ? [PRICE_SEGMENTS[2]] : PRICE_SEGMENTS;

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

    for (const vt of vts) {
      for (const [minP, maxP] of segs) {
        try {
          const list = await fetchSegment(proxy, citySlug, vt, minP, maxP);
          segments++;
          for (const raw of list) {
            const n = normalize(raw, citySlug);
            if (n && !seen.has(n.vehicle_id)) seen.set(n.vehicle_id, n);
          }
          await new Promise((r) => setTimeout(r, 300));
        } catch (e: any) {
          errorMsg = e.message;
          console.error(`Segment ${citySlug}/${vt}/${minP}-${maxP}:`, e.message);
        }
      }
    }

    const rows = Array.from(seen.values());
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

  console.log("Scrape summary:", JSON.stringify(summary));
  return summary;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: any = {};
  try { body = await req.json(); } catch (_) {}
  const cities: string[] = body.cities ?? ["los-angeles", "miami"];
  const testMode: boolean = body.test === true;

  // Test mode: run synchronously and return result so user can see it worked.
  if (testMode) {
    try {
      const result = await runScrape(cities, true);
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

  // Background mode for full scans (avoids client timeout).
  // @ts-ignore - EdgeRuntime is provided by supabase edge runtime
  EdgeRuntime.waitUntil(
    runScrape(cities, false).catch((e) => console.error("Scrape failed:", e)),
  );

  return new Response(
    JSON.stringify({
      ok: true,
      message: `Scrape started for ${cities.join(", ")}. Check back in a few minutes.`,
      cities,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
