// Temporary diagnostic v3: manual HTTP CONNECT tunnel through a raw residential
// proxy with our own Proxy-Authorization header, then TLS + HTTP GET over it.
// This bypasses the Supabase edge runtime dropping proxy auth.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GEONIX = Deno.env.get("GEONIX_PROXY_URL") ?? "";
const TURO = Deno.env.get("TURO_PROXY_URL") ?? "";

function parseProxy(raw: string): { host: string; port: number; user?: string; pass?: string } | null {
  if (!raw) return null;
  if (/^[a-z]+:\/\//i.test(raw)) {
    const u = new URL(raw);
    return { host: u.hostname, port: Number(u.port), user: u.username ? decodeURIComponent(u.username) : undefined, pass: u.password ? decodeURIComponent(u.password) : undefined };
  }
  const parts = raw.split(":");
  if (parts.length === 4) return { host: parts[0], port: Number(parts[1]), user: parts[2], pass: parts[3] };
  if (parts.length === 2) return { host: parts[0], port: Number(parts[1]) };
  return null;
}

async function fetchViaProxy(raw: string, targetUrl: string): Promise<{ status: number; body: string }> {
  const p = parseProxy(raw);
  if (!p) throw new Error("unparseable proxy");
  const target = new URL(targetUrl);
  const targetHost = target.hostname;
  const targetPort = target.port ? Number(target.port) : 443;

  let conn: Deno.Conn = await Deno.connect({ hostname: p.host, port: p.port });

  // CONNECT handshake
  const auth = p.user ? "Proxy-Authorization: Basic " + btoa(`${p.user}:${p.pass}`) + "\r\n" : "";
  const connectReq =
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
    `Host: ${targetHost}:${targetPort}\r\n` +
    auth +
    `\r\n`;
  await conn.write(new TextEncoder().encode(connectReq));

  // Read CONNECT response (until \r\n\r\n)
  const dec = new TextDecoder();
  let handshake = "";
  const buf = new Uint8Array(1024);
  while (!handshake.includes("\r\n\r\n")) {
    const n = await conn.read(buf);
    if (n === null) break;
    handshake += dec.decode(buf.subarray(0, n));
    if (handshake.length > 8192) break;
  }
  const statusLine = handshake.split("\r\n")[0] ?? "";
  if (!/ 200 /.test(statusLine)) {
    conn.close();
    return { status: 0, body: `CONNECT failed: ${statusLine}` };
  }

  // Upgrade to TLS over the tunneled connection
  const tls = await Deno.startTls(conn, { hostname: targetHost });

  // Send the actual GET
  const getReq =
    `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
    `Host: ${targetHost}\r\n` +
    `User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36\r\n` +
    `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n` +
    `Accept-Language: en-US,en;q=0.9\r\n` +
    `Connection: close\r\n` +
    `\r\n`;
  await tls.write(new TextEncoder().encode(getReq));

  // Read full response
  const chunks: Uint8Array[] = [];
  const rbuf = new Uint8Array(16384);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const n = await tls.read(rbuf);
    if (n === null) break;
    chunks.push(rbuf.slice(0, n));
  }
  tls.close();

  // Combine + split headers/body
  let total = 0;
  for (const c of chunks) total += c.length;
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  const raw2 = dec.decode(all);
  const sep = raw2.indexOf("\r\n\r\n");
  const head = sep >= 0 ? raw2.slice(0, sep) : raw2;
  let body = sep >= 0 ? raw2.slice(sep + 4) : "";
  const statusM = head.split("\r\n")[0].match(/HTTP\/1\.\d (\d+)/);
  const status = statusM ? Number(statusM[1]) : 0;

  // De-chunk if Transfer-Encoding: chunked
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    body = dechunk(body);
  }
  return { status, body };
}

function dechunk(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const nl = s.indexOf("\r\n", i);
    if (nl < 0) break;
    const size = parseInt(s.slice(i, nl).trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out += s.slice(nl + 2, nl + 2 + size);
    i = nl + 2 + size + 2;
  }
  return out;
}

async function test(raw: string) {
  const url = "https://turo.com/us/en/car-rental/united-states/miami-fl?minDailyPrice=0&maxDailyPrice=80";
  try {
    const r = await fetchViaProxy(raw, url);
    return {
      status: r.status,
      bytes: r.body.length,
      cardCount: r.body.split("vehicle-card-link-box").length - 1,
      blocked: r.body.slice(0, 3000).toLowerCase().includes("just a moment"),
      preview: r.status !== 200 ? r.body.slice(0, 200) : undefined,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const out = {
    geonix: GEONIX ? await test(GEONIX) : "absent",
    turo: TURO ? await test(TURO) : "absent",
  };
  return new Response(JSON.stringify(out, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
