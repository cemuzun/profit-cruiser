// Sanity test: scrape ONE city × ONE price segment × no vehicle-type filter
// via stealth Playwright.
// Usage:  docker compose run --rm scraper node test-scrape.mjs [city]
//   default city = los-angeles
import { scrapeSegment, launchBrowser, CITIES, WINDOWS, pool } from "./scraper.mjs";

const citySlug = process.argv[2] || "los-angeles";
if (!CITIES[citySlug]) {
  console.error(`Unknown city: ${citySlug}. Options: ${Object.keys(CITIES).join(", ")}`);
  process.exit(1);
}

const win = WINDOWS[0]; // "now"
const [minP, maxP] = [50, 120];

console.log(`Test scrape → ${citySlug} / ${win.key} / $${minP}-${maxP} / ALL`);
const browser = await launchBrowser();
try {
  const t0 = Date.now();
  const vehicles = await scrapeSegment(browser, citySlug, win, minP, maxP, null);
  const ms = Date.now() - t0;
  console.log(`\n✅ ${vehicles.length} vehicles in ${ms}ms`);
  for (const v of vehicles.slice(0, 5)) {
    console.log(`  - ${v.vehicle_id}  ${v.year ?? ""} ${v.make ?? ""} ${v.model ?? ""}  $${v.avg_daily_price}/day`);
  }
  if (vehicles.length === 0) {
    console.error("\n⚠ Zero vehicles — VPS IP may be blocked, or Turo changed their API shape.");
    process.exitCode = 2;
  }
} catch (e) {
  console.error("Test scrape failed:", e);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  await pool.end();
}
