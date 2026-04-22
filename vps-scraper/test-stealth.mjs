import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { writeFile } from 'node:fs/promises';

chromium.use(stealth());

async function run() {
  console.log("Launching stealth browser...");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  const url = "https://turo.com/us/en/search?country=US&location=Los+Angeles&latitude=34.0549076&longitude=-118.242643&placeId=ChIJE9on3F3HwoAR9AhGJW_fL-I&locationType=CITY&pickupType=ALL&searchDurationType=DAILY&sortType=RELEVANCE&itemsPerPage=200&minDailyPriceUSD=50&maxDailyPriceUSD=120";
  
  console.log("Navigating to", url);
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  console.log("Status:", response.status());
  
  await page.waitForTimeout(8000); // give more time to load
  
  const html = await page.content();
  console.log("HTML length:", html.length);
  
  await writeFile("debug-turo-stealth.html", html);
  
  const hasNextData = /id="__NEXT_DATA__"/.test(html);
  const hasApolloState = /__APOLLO_STATE__/.test(html);
  
  console.log("has __NEXT_DATA__:", hasNextData);
  console.log("has __APOLLO_STATE__:", hasApolloState);
  
  await browser.close();
}

run().catch(console.error);
