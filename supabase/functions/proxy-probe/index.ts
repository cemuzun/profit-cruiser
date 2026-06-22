// Temporary diagnostic v2: test raw residential proxies via Deno.createHttpClient
// with basicAuth passed separately. Does NOT leak secret values.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GEONIX = Deno.env.get("GEONIX_PROXY_URL") ?? "";
const TURO = Deno.env.get("TURO_PROXY_URL") ?? "";
const TEST_URL = "https://turo.com/us/en/car-rental/united-states/miami-fl";

// Parse "http://user:pass@host:port" OR "host:port:user:pass" OR "host:port"
function parseProxy(raw: string): { url: string; username?: string; password?: string } | null {
  if (!raw) return null;
  if (/^[a-z]+:\/\//i.test(raw)) {
    const u = new URL(raw);
    return {
      url: `${u.protocol}//${u.hostname}:${u.port}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  }
  const parts = raw.split(":");
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return { url: `http://${host}:${port}`, username: user, password: pass };
  }
  if (parts.length === 2) return { url: `http://${parts[0]}:${parts[1]}` };
  return null;
}

async function testProxy(raw: string) {
  const p = parseProxy(raw);
  if (!p) return { error: "unparseable" };
  try {
    // deno-lint-ignore no-explicit-any
    const client = (Deno as any).createHttpClient({
      proxy: { url: p.url, basicAuth: p.username ? { username: p.username, password: p.password } : undefined },
    });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const res = await fetch(TEST_URL, {
        // deno-lint-ignore no-explicit-any
        client,
        signal: ctrl.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      } as any);
      const body = await res.text();
      return {
        status: res.status,
        bytes: body.length,
        hasCards: body.includes("vehicle-card-link-box"),
        cardCount: body.split("vehicle-card-link-box").length - 1,
        blocked: body.slice(0, 3000).toLowerCase().includes("just a moment"),
      };
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const out = {
    geonix: GEONIX ? await testProxy(GEONIX) : "absent",
    turo: TURO ? await testProxy(TURO) : "absent",
  };
  return new Response(JSON.stringify(out, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
