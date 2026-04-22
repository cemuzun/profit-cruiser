// Debug: fetch one Turo URL via ScraperAPI and dump diagnostics about its HTML shape.
// Usage: docker compose run --rm scraper node debug-scraperapi.mjs
import { writeFile } from "node:fs/promises";

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
if (!SCRAPER_API_KEY) { console.error("SCRAPER_API_KEY missing"); process.exit(1); }

const url = "https://turo.com/us/en/search?country=US&location=Los+Angeles&latitude=34.0549076&longitude=-118.242643&placeId=ChIJE9on3F3HwoAR9AhGJW_fL-I&locationType=CITY&pickupType=ALL&searchDurationType=DAILY&sortType=RELEVANCE&itemsPerPage=200&minDailyPriceUSD=50&maxDailyPriceUSD=120";

console.log("Fetching via ScraperAPI:", url);
const t0 = Date.now();

const targetUrl = new URL('http://api.scraperapi.com');
targetUrl.searchParams.set('api_key', SCRAPER_API_KEY);
targetUrl.searchParams.set('url', url);
targetUrl.searchParams.set('render', 'true');
targetUrl.searchParams.set('country_code', 'us');
// Give JS 15s to hydrate search results after page load
targetUrl.searchParams.set('wait', '15000');

const res = await fetch(targetUrl.toString());

console.log(`HTTP ${res.status} in ${Date.now() - t0}ms`);
const html = await res.text();
console.log("HTML length:", html.length);

await writeFile("./turo-debug.html", html);
console.log("Saved → ./turo-debug.html");

// Diagnostics
const probes = {
  has__NEXT_DATA__: /id="__NEXT_DATA__"/.test(html),
  hasApolloState: /__APOLLO_STATE__/.test(html),
  hasInitialState: /__INITIAL_STATE__/.test(html),
  hasReduxState: /__PRELOADED_STATE__|__REDUX_STATE__/.test(html),
  hasVehicleAnchors: (html.match(/href="\/us\/en\/rentals\/[^"]+\/(\d+)/g) || []).length,
  hasVehicleTestId: (html.match(/data-testid="[^"]*vehicle[^"]*"/g) || []).length,
  hasSearchResultCard: (html.match(/searchResultCard|SearchResultCard/g) || []).length,
  hasDailyPrice: (html.match(/dailyPrice|avgDailyPrice/g) || []).length,
  hasCloudflareChallenge: /challenge-platform|cf-mitigated|Just a moment/i.test(html),
  hasLogin: /Log in|Sign up/i.test(html),
  title: (html.match(/<title>([^<]*)<\/title>/) || [,""])[1],
};
console.log("\n=== Probes ===");
console.log(JSON.stringify(probes, null, 2));

// Find script tags with JSON-ish content
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]{200,}?)<\/script>/g)]
  .map(m => ({ attrs: m[1].trim(), len: m[2].length, head: m[2].slice(0, 120).replace(/\s+/g, " ") }))
  .sort((a, b) => b.len - a.len)
  .slice(0, 8);
console.log("\n=== Top 8 largest <script> tags ===");
for (const s of scripts) console.log(`  [${s.len}b] ${s.attrs} :: ${s.head}`);
