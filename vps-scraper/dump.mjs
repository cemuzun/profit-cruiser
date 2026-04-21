// Re-dump JSON files from current Postgres state without re-scraping.
// Usage inside container:  node dump.mjs
import pg from "pg";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const DATA_DIR = process.env.DATA_DIR || "/data";

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const listings = (await pool.query(`select * from listings_current`)).rows;
  const forecasts = (await pool.query(
    `select vehicle_id, city, window_label, avg_price, min_price, max_price,
            window_start, window_end, scraped_at
       from price_forecasts where scraped_at > now() - interval '90 days' order by scraped_at`)).rows;
  const snapshots = (await pool.query(
    `select vehicle_id, city, make, model, year, vehicle_type, fuel_type,
            avg_daily_price, completed_trips, scraped_at
       from listings_snapshots where scraped_at > now() - interval '60 days' order by scraped_at`)).rows;
  const runs = (await pool.query(
    `select id, city, status, vehicles_count, segments_run, error_message, started_at, finished_at
       from scrape_runs order by started_at desc limit 50`)).rows;
  const meta = { generated_at: new Date().toISOString(),
                 listings_count: listings.length, forecasts_count: forecasts.length, snapshots_count: snapshots.length };
  await writeFile(path.join(DATA_DIR, "listings.json"), JSON.stringify(listings));
  await writeFile(path.join(DATA_DIR, "forecasts.json"), JSON.stringify(forecasts));
  await writeFile(path.join(DATA_DIR, "snapshots.json"), JSON.stringify(snapshots));
  await writeFile(path.join(DATA_DIR, "runs.json"), JSON.stringify(runs));
  await writeFile(path.join(DATA_DIR, "meta.json"), JSON.stringify(meta));
  console.log("Dumped:", meta);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
