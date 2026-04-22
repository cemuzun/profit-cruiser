#!/usr/bin/env node
// Discover Turo internal XHR/fetch endpoints from a valid browser session.
// Usage examples:
//   node discover-xhr.mjs --headful --city "Los Angeles" --region CA --place-id "..."
//   node discover-xhr.mjs --storage-state ./state/turo.json --proxy "http://user:pass@host:port"

import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

chromium.use(stealthPlugin());

function getArg(name, fallback = undefined) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function printUsage() {
  console.log(`
Usage:
  npm run discover:xhr -- [options]

Options:
  --headful                 Run with visible browser (requires GUI/X server)
  --auto-headless           If --headful is set without GUI, fallback to headless
  --install-browser         Auto-run "npx playwright install chromium" if missing
  --wait-ms <number>        Wait time for challenge/session warm-up
  --proxy <url>             HTTP proxy URL (e.g., http://user:pass@host:port)
  --storage-state <path>    Existing Playwright storage state to load
  --save-state <path>       Storage state output path (default: ./state/turo.json)
  --out-dir <path>          Artifact output directory (default: ./artifacts)
  --city <name>             Search city (default: Los Angeles)
  --region <code>           Region/state code (default: CA)
  --place-id <id>           Turo/Google place id for city
  --help                    Show this help
`);
}

if (hasFlag("help")) {
  printUsage();
  process.exit(0);
}

const city = getArg("city", "Los Angeles");
const region = getArg("region", "CA");
const placeId = getArg("place-id", "ChIJE9on3F3HwoAR9AhGJW_fL-I");
const lat = Number(getArg("lat", "34.0549076"));
const lng = Number(getArg("lng", "-118.242643"));
const country = getArg("country", "US");
const minPrice = Number(getArg("min-price", "50"));
const maxPrice = Number(getArg("max-price", "300"));
const vehicleType = getArg("type", "");
const storageState = getArg("storage-state", "");
const proxy = getArg("proxy", "");
const outDir = getArg("out-dir", "./artifacts");
const saveStatePath = getArg("save-state", "./state/turo.json");
const headful = hasFlag("headful");
const waitMs = Number(getArg("wait-ms", headful ? "45000" : "20000"));
const allowHeadlessFallback = hasFlag("auto-headless");
const autoInstallBrowser = hasFlag("install-browser");
const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

if (headful && !hasDisplay && !allowHeadlessFallback) {
  console.error(
    [
      "Headful mode was requested with --headful, but no GUI display is available.",
      "Run with xvfb-run, or remove --headful.",
      "Example:",
      "  xvfb-run -a npm run discover:xhr -- --headful --proxy \"http://USER:PASS@HOST:PORT\"",
      "Or use:",
      "  npm run discover:xhr -- --auto-headless --proxy \"http://USER:PASS@HOST:PORT\"",
    ].join("\n"),
  );
  process.exit(2);
}

if (!Number.isFinite(waitMs) || waitMs < 0) {
  console.error(`Invalid --wait-ms value: ${String(waitMs)} (must be a non-negative number).`);
  process.exit(2);
}

const effectiveHeadful = headful && hasDisplay;
if (headful && !effectiveHeadful && allowHeadlessFallback) {
  console.warn("No GUI display detected. Falling back to headless mode (--auto-headless).");
}

const start = new Date();
start.setUTCDate(start.getUTCDate() + 1);
const end = new Date(start);
end.setUTCDate(end.getUTCDate() + 3);
const isoDate = d => d.toISOString().slice(0, 10);

const params = new URLSearchParams({
  age: "30",
  country,
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
  pickupDate: isoDate(start),
  pickupTime: "10:00",
  dropoffDate: isoDate(end),
  dropoffTime: "10:00",
  minDailyPriceUSD: String(minPrice),
  maxDailyPriceUSD: String(maxPrice),
});
if (vehicleType) params.set("types", vehicleType);

const pageUrl = `https://turo.com/us/en/search?${params.toString()}`;

const launchOptions = {
  headless: !effectiveHeadful,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
};
if (proxy) {
  const u = new URL(proxy);
  launchOptions.proxy = {
    server: `${u.protocol}//${u.hostname}:${u.port}`,
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

function tryLaunchBrowser() {
  return chromium.launch(launchOptions);
}

function installBrowser() {
  console.log("Installing Playwright chromium browser...");
  const result = spawnSync("npx", ["playwright", "install", "chromium"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

let browser;
try {
  browser = await tryLaunchBrowser();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Executable doesn't exist")) {
    if (autoInstallBrowser) {
      const ok = installBrowser();
      if (!ok) {
        console.error("Browser auto-install failed. Please run manually: npx playwright install chromium");
        process.exit(2);
      }
      browser = await tryLaunchBrowser();
    } else {
      console.error(
        [
          "Playwright browser executable is missing.",
          "Install browsers and re-run:",
          "  cd /opt/turo-scraper/vps-scraper",
          "  npx playwright install chromium",
          "",
          "Or run this script with --install-browser to install automatically.",
        ].join("\n"),
      );
      process.exit(2);
    }
  } else {
    throw error;
  }
}

if (!browser) {
    console.error(
      "Could not launch browser after setup. Check Playwright installation and environment.",
    );
    process.exit(2);
}

const contextOptions = {
  viewport: { width: 1366, height: 900 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
};
if (storageState) contextOptions.storageState = storageState;

const context = await browser.newContext(contextOptions);
const page = await context.newPage();

const seen = new Map();

page.on("response", async (resp) => {
  const url = resp.url();
  if (!url.includes("turo.com/api")) return;

  const request = resp.request();
  let requestHeaders = {};
  try {
    requestHeaders = await request.allHeaders();
  } catch (_) {}

  const entry = {
    method: request.method(),
    status: resp.status(),
    url,
    requestHeaders,
    responseHeaders: resp.headers(),
    resourceType: request.resourceType(),
    ts: new Date().toISOString(),
  };

  const key = `${entry.method} ${entry.url}`;
  if (!seen.has(key) || entry.status === 200) {
    seen.set(key, entry);
  }

  console.log(`[API] ${entry.status} ${entry.method} ${entry.url}`);
});

try {
  console.log(`Opening: ${pageUrl}`);
  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });

  if (effectiveHeadful) {
    console.log(`Headful mode enabled. Solve any challenge manually; waiting ${waitMs}ms...`);
    await page.waitForTimeout(waitMs);
  } else {
    await page.waitForTimeout(waitMs);
  }

  // Trigger one in-page fetch retry after challenge/session cookies are ready.
  await page.evaluate(async () => {
    const endpoints = [
      "/api/v2/search",
      "/api/v2/search/filters",
    ];

    for (const endpoint of endpoints) {
      try {
        await fetch(`${endpoint}${location.search}`, {
          credentials: "include",
          headers: {
            Accept: "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
          },
        });
      } catch (_) {
        // best effort
      }
    }
  });

  await page.waitForTimeout(5_000);

  const out = [...seen.values()]
    .sort((a, b) => a.url.localeCompare(b.url));

  await mkdir(path.dirname(saveStatePath), { recursive: true });
  await context.storageState({ path: saveStatePath });

  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `turo-xhr-${Date.now()}.json`);
  await writeFile(outPath, JSON.stringify({ pageUrl, count: out.length, endpoints: out }, null, 2));

  console.log(`\nDiscovered ${out.length} API endpoints.`);
  console.log(`Saved: ${outPath}`);
  console.log(`Saved storage state: ${saveStatePath}`);

  if (out.length === 0) {
    console.log("No API endpoints observed. Re-run with --headful and a valid --storage-state.");
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
