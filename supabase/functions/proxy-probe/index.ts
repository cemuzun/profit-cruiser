// Temporary diagnostic: inspect GEONIX_PROXY_URL / TURO_PROXY_URL shape and
// test fetching a Turo listing page through them. Does NOT leak secret values.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GEONIX = Deno.env.get("GEONIX_PROXY_URL") ?? "";
const TURO = Deno.env.get("TURO_PROXY_URL") ?? "";

const TEST_URL = "https://turo.com/us/en/car-rental/united-states/miami-fl";

function shape(raw: string) {
  if (!raw) return { present: false };
  let scheme = "(none)";
  const m = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (m) scheme = m[1];
  const hasAuth = /\/\/[^/@]+@/.test(raw);
  const hasUrlParam = /[?&]url=/.test(raw) || raw.endsWith("=") || raw.endsWith("?");
  // Try to extract host:port without exposing credentials
  let hostPort = "(unknown)";
  try {
    const u = new URL(raw);
    hostPort = `${u.hostname}:${u.port || "(default)"}`;
  } catch {
    const hp = raw.replace(/^[a-z]+:\/\//i, "").replace(/^[^@]+@/, "").split(/[/?]/)[0];
    hostPort = hp || "(unparseable)";
  }
  return { present: true, scheme, hasAuth, looksLikeApiGateway: hasUrlParam, hostPort, length: raw.length };
}

async function tryGateway(raw: string) {
  // API-gateway style: append ?url=<target>
  const sep = raw.includes("?") ? "&" : "?";
  const u = `${raw}${sep}url=${encodeURIComponent(TEST_URL)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(u, { signal: ctrl.signal, headers: { Accept: "text/html" } });
    const body = await res.text();
    return { mode: "gateway", status: res.status, bytes: body.length, hasCards: body.includes("vehicle-card-link-box"), blocked: body.slice(0, 2000).toLowerCase().includes("just a moment") };
  } catch (e) {
    return { mode: "gateway", error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function tryHttpClient(raw: string) {
  // Raw host:port proxy style via Deno.createHttpClient
  try {
    // deno-lint-ignore no-explicit-any
    const client = (Deno as any).createHttpClient({ proxy: { url: raw } });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25_000);
    try {
      // deno-lint-ignore no-explicit-any
      const res = await fetch(TEST_URL, { client, signal: ctrl.signal, headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" } } as any);
      const body = await res.text();
      return { mode: "httpClient", status: res.status, bytes: body.length, hasCards: body.includes("vehicle-card-link-box"), blocked: body.slice(0, 2000).toLowerCase().includes("just a moment") };
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    return { mode: "httpClient", error: e instanceof Error ? e.message : String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const out: Record<string, unknown> = {
    geonix: shape(GEONIX),
    turo: shape(TURO),
  };
  if (GEONIX) {
    out.geonix_gateway = await tryGateway(GEONIX);
    out.geonix_httpclient = await tryHttpClient(GEONIX);
  }
  if (TURO) {
    out.turo_gateway = await tryGateway(TURO);
  }
  return new Response(JSON.stringify(out, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
