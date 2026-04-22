#!/usr/bin/env node
// Queue worker — polls scrape_runs for status='pending' rows and runs them.
// The "Scrape now" button in the dashboard inserts pending rows via the
// scrape-turo edge function; this worker picks them up.
//
// Usage:
//   node queue-worker.mjs            # process all pending rows then exit
//   node queue-worker.mjs --loop     # poll forever (every 30s)

import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import { scrapeCity, CITIES, pool } from "./scraper.mjs";

chromium.use(stealthPlugin());

const LOOP = process.argv.includes("--loop");
const POLL_MS = Number(process.env.QUEUE_POLL_MS || 30_000);

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
];

async function claimNextPending() {
  // Atomically claim one pending row so concurrent workers don't double-process.
  const { rows } = await pool.query(
    `update scrape_runs
        set status = 'running', started_at = now()
      where id = (
        select id from scrape_runs
         where status = 'pending'
         order by started_at asc
         limit 1
         for update skip locked
      )
      returning id, city`,
  );
  return rows[0] ?? null;
}

async function processOne(browser, job) {
  const { id, city } = job;
  console.log(`[queue] picked up ${city} (run ${id})`);
  if (!CITIES[city]) {
    await pool.query(
      `update scrape_runs
          set status='failed',
              error_message=$2,
              finished_at=now()
        where id=$1`,
      [id, `Unknown city slug "${city}". Add it to CITIES in scraper.mjs.`],
    );
    return;
  }
  try {
    await scrapeCity(browser, city, id);
  } catch (e) {
    console.error(`[queue] ${city} crashed:`, e);
    await pool.query(
      `update scrape_runs
          set status='failed',
              error_message=$2,
              finished_at=now()
        where id=$1 and status='running'`,
      [id, e?.message ?? String(e)],
    );
  }
}

async function drain() {
  let processed = 0;
  const browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
  try {
    while (true) {
      const job = await claimNextPending();
      if (!job) break;
      await processOne(browser, job);
      processed++;
    }
  } finally {
    await browser.close();
  }
  return processed;
}

async function main() {
  if (!LOOP) {
    const n = await drain();
    console.log(`[queue] processed ${n} job(s).`);
    await pool.end();
    return;
  }

  console.log(`[queue] loop mode, polling every ${POLL_MS}ms`);
  for (;;) {
    try {
      const n = await drain();
      if (n === 0) {
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } catch (e) {
      console.error("[queue] drain error:", e);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

main().catch((e) => {
  console.error("[queue] fatal:", e);
  process.exit(1);
});
