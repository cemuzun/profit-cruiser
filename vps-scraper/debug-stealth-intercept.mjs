// Debug: test stealth Playwright with XHR interception to find Turo's search API.
// Usage: node --env-file=.env debug-stealth-intercept.mjs
import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import { writeFile } from "node:fs/promises";

chromium.use(stealthPlugin());

const BROWSER_ARGS = [
  "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
  "--disable-gpu", "--disable-extensions",
];

const url = "https://turo.com/us/en/search?country=US&location=Los+Angeles&latitude=34.0549076&longitude=-118.242643&placeId=ChIJE9on3F3HwoAR9AhGJW_fL-I&locationType=CITY&pickupType=ALL&searchDurationType=DAILY&sortType=RELEVANCE&itemsPerPage=200&minDailyPriceUSD=50&maxDailyPriceUSD=120";

const browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
const page = await browser.newPage();

const jsonResponses = [];
const allApiUrls = [];

page.on("response", async (resp) => {
  const rUrl = resp.url();
  const status = resp.status();
  const ct = resp.headers()["content-type"] || "";

  if (ct.includes("json") && status === 200) {
    allApiUrls.push(`[${status}] ${rUrl.slice(0, 120)}`);
    try {
      const json = await resp.json();
      jsonResponses.push({ url: rUrl, data: json });
    } catch (_) {}
  }
});

await page.setViewportSize({ width: 1280, height: 800 });
console.log("Navigating...");
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
console.log("Waiting 12s for XHRs...");
await page.waitForTimeout(12_000);

console.log(`\n=== ${allApiUrls.length} JSON API calls intercepted ===`);
for (const u of allApiUrls) console.log(" ", u);

// Find the response that has vehicle-like data
let vehicleCount = 0;
const vehicleApiUrls = [];
for (const { url: rUrl, data } of jsonResponses) {
  const str = JSON.stringify(data);
  if (str.includes("avgDailyPrice") || str.includes("dailyPrice") || str.includes("vehicleId")) {
    vehicleCount++;
    vehicleApiUrls.push(rUrl);
    await writeFile(`./debug-intercept-${vehicleCount}.json`, JSON.stringify(data, null, 2));
    console.log(`\n✅ Vehicle data found in: ${rUrl.slice(0, 120)}`);
    console.log(`   Saved → debug-intercept-${vehicleCount}.json`);
  }
}

if (vehicleCount === 0) {
  console.log("\n⚠ No vehicle data found in intercepted JSON. Turo may have blocked this IP.");
  // Save the page HTML for inspection
  const html = await page.content();
  await writeFile("./debug-stealth-page.html", html);
  console.log("Saved page HTML → debug-stealth-page.html");
}

await browser.close();
