#!/usr/bin/env bash
# Track A — Run Turo XHR discovery directly on the VPS host (no Docker).
#
# Usage (on the VPS):
#   cd /opt/turo-scraper
#   chmod +x host-discover.sh
#   SCRAPER_PROXY="http://USER:PASS@proxy-server.scraperapi.com:8001" \
#     ./host-discover.sh
#
# Optional env:
#   CITY="Los Angeles"  REGION="CA"  PLACE_ID="ChIJE9on3F3HwoAR9AhGJW_fL-I"
#   WAIT_MS=25000
#   WORKDIR=/opt/turo-scraper/host-discover
#   ARTIFACTS=/opt/turo-scraper/artifacts-host

set -euo pipefail

WORKDIR="${WORKDIR:-/opt/turo-scraper/host-discover}"
ARTIFACTS="${ARTIFACTS:-/opt/turo-scraper/artifacts-host}"
CITY="${CITY:-Los Angeles}"
REGION="${REGION:-CA}"
PLACE_ID="${PLACE_ID:-ChIJE9on3F3HwoAR9AhGJW_fL-I}"
WAIT_MS="${WAIT_MS:-25000}"
PROXY="${SCRAPER_PROXY:-}"

echo "==> Workdir:   $WORKDIR"
echo "==> Artifacts: $ARTIFACTS"
echo "==> City:      $CITY ($REGION)"
echo "==> Proxy:     ${PROXY:+(set)}${PROXY:-(none)}"

mkdir -p "$WORKDIR" "$ARTIFACTS"
cd "$WORKDIR"

# ---- 1. Install Node 20 if missing -----------------------------------------
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 18 ]; then
  echo "==> Installing Node.js 20.x"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

# ---- 2. Install Playwright + stealth in this workdir -----------------------
if [ ! -f package.json ]; then
  cat > package.json <<'JSON'
{
  "name": "turo-host-discover",
  "private": true,
  "type": "module",
  "version": "1.0.0"
}
JSON
fi

echo "==> Installing npm deps"
npm install --no-audit --no-fund \
  playwright@1.48.0 \
  playwright-extra@4.3.6 \
  puppeteer-extra-plugin-stealth@2.11.2

echo "==> Installing Chromium + system deps"
npx playwright install --with-deps chromium

# ---- 3. Write the discovery script via heredoc -----------------------------
cat > discover-xhr.mjs <<'NODE'
import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

chromium.use(stealthPlugin());

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};

const city = arg("city", "Los Angeles");
const region = arg("region", "CA");
const placeId = arg("place-id", "ChIJE9on3F3HwoAR9AhGJW_fL-I");
const lat = Number(arg("lat", "34.0549076"));
const lng = Number(arg("lng", "-118.242643"));
const waitMs = Number(arg("wait-ms", "25000"));
const proxy = arg("proxy", process.env.SCRAPER_PROXY || "");
const outDir = arg("out-dir", "./artifacts");

const start = new Date();
start.setUTCDate(start.getUTCDate() + 1);
const end = new Date(start);
end.setUTCDate(end.getUTCDate() + 3);
const iso = (d) => d.toISOString().slice(0, 10);

const params = new URLSearchParams({
  age: "30",
  country: "US",
  defaultZoomLevel: "11",
  isMapSearch: "false",
  itemsPerPage: "200",
  latitude: String(lat),
  longitude: String(lng),
  location: city,
  locationType: "CITY",
  pickupType: "ALL",
  placeId,
  region,
  searchDurationType: "DAILY",
  sortType: "RELEVANCE",
  pickupDate: iso(start),
  pickupTime: "10:00",
  dropoffDate: iso(end),
  dropoffTime: "10:00",
  minDailyPriceUSD: "50",
  maxDailyPriceUSD: "300",
});

const pageUrl = `https://turo.com/us/en/search?${params.toString()}`;

const launchOptions = {
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
};
if (proxy) {
  const u = new URL(proxy);
  launchOptions.proxy = {
    server: `${u.protocol}//${u.hostname}:${u.port}`,
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
  console.log(`Using proxy: ${u.hostname}:${u.port}`);
}

const browser = await chromium.launch(launchOptions);
const context = await browser.newContext({
  viewport: { width: 1366, height: 900 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
});
const page = await context.newPage();

const seen = new Map();
page.on("response", async (resp) => {
  const url = resp.url();
  if (!url.includes("turo.com/api")) return;
  const req = resp.request();
  let reqHeaders = {};
  try { reqHeaders = await req.allHeaders(); } catch {}
  let bodyPreview = null;
  try {
    const ct = resp.headers()["content-type"] || "";
    if (ct.includes("json")) {
      const text = await resp.text();
      bodyPreview = text.slice(0, 2000);
    }
  } catch {}
  const entry = {
    method: req.method(),
    status: resp.status(),
    url,
    requestHeaders: reqHeaders,
    responseHeaders: resp.headers(),
    bodyPreview,
    ts: new Date().toISOString(),
  };
  const key = `${entry.method} ${entry.url}`;
  if (!seen.has(key) || entry.status === 200) seen.set(key, entry);
  console.log(`[API] ${entry.status} ${entry.method} ${entry.url}`);
});

console.log(`Opening: ${pageUrl}`);
try {
  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
} catch (e) {
  console.error(`goto failed: ${e.message}`);
}
await page.waitForTimeout(waitMs);

// nudge in-page fetches with current cookies
try {
  await page.evaluate(async () => {
    for (const ep of ["/api/v2/search", "/api/v2/search/filters"]) {
      try {
        await fetch(`${ep}${location.search}`, {
          credentials: "include",
          headers: { Accept: "application/json,*/*" },
        });
      } catch {}
    }
  });
} catch {}
await page.waitForTimeout(5000);

// Capture the rendered HTML too — useful if Cloudflare blocked us
const html = await page.content().catch(() => "");
const title = await page.title().catch(() => "");

await mkdir(outDir, { recursive: true });
const stamp = Date.now();
const outPath = path.join(outDir, `turo-xhr-${stamp}.json`);
const htmlPath = path.join(outDir, `turo-page-${stamp}.html`);

const out = [...seen.values()].sort((a, b) => a.url.localeCompare(b.url));
await writeFile(
  outPath,
  JSON.stringify(
    { pageUrl, title, count: out.length, endpoints: out },
    null,
    2,
  ),
);
await writeFile(htmlPath, html);

console.log(`\nTitle:        ${title}`);
console.log(`Endpoints:    ${out.length}`);
console.log(`Saved JSON:   ${outPath}`);
console.log(`Saved HTML:   ${htmlPath}`);

if (out.length === 0) {
  console.log("\nNo /api requests captured.");
  console.log("Likely Cloudflare challenge. Inspect the saved HTML:");
  console.log(`  head -c 4000 ${htmlPath}`);
}

await browser.close();
NODE

# ---- 4. Run it -------------------------------------------------------------
echo ""
echo "==> Running discovery (this takes ~60s)"
node discover-xhr.mjs \
  --city "$CITY" \
  --region "$REGION" \
  --place-id "$PLACE_ID" \
  --wait-ms "$WAIT_MS" \
  --out-dir "$ARTIFACTS" \
  ${PROXY:+--proxy "$PROXY"}

echo ""
echo "==> Done. Artifacts:"
ls -la "$ARTIFACTS"
echo ""
echo "==> To inspect:"
echo "    cat \$(ls -t $ARTIFACTS/turo-xhr-*.json | head -1) | head -100"
echo "    head -c 4000 \$(ls -t $ARTIFACTS/turo-page-*.html | head -1)"
