

# Seasonality Analysis + Compare Cars

Two additions that build directly on the snapshot history we already collect.

## 1. Seasonality analysis

**Goal:** see how Turo daily prices move by month and by weekday, so utilization/revenue assumptions in the analyzer aren't just a flat 60%.

**Where it lives:**
- New page `/seasonality` (added to top nav as "Seasonality")
- Plus a compact "Seasonality" card on the **Car Detail** page for that specific vehicle

**What you'll see on `/seasonality`:**
- City filter (LA / Miami / both) and optional Make+Model filter
- **Monthly chart** — bar chart of median daily price for each calendar month (Jan–Dec), with P25/P75 band
- **Weekday chart** — bar chart of median daily price Mon–Sun, with weekend uplift % shown as a stat
- **Seasonality multipliers table** — each month and weekday shown as a multiplier vs. annual median (e.g. "July = 1.18×, Tuesday = 0.92×"). These are the numbers you'd plug into utilization estimates.
- KPI strip: peak month, low month, weekend premium %, sample size (snapshots used)

**On Car Detail:**
- Small "Seasonality" card with the monthly multiplier mini-chart for just that vehicle (falls back to its make/model if it has too few own snapshots, then to city-wide).

**Data source:** existing `listings_snapshots` table — we already store `avg_daily_price` + `scraped_at` daily, so we group by `EXTRACT(MONTH …)` and `EXTRACT(DOW …)`. No new scraping needed. Quality note: until we have ~30+ days of history, the page will show a "Limited data — collecting since {date}" banner; results get more meaningful with each daily run.

**Wiring into the rest of the app:**
- Analyzer + Car Detail get a new optional toggle: **"Apply seasonality"** → when on, instead of one flat utilization number, projected monthly revenue is multiplied by that month's seasonality factor and the chart shows 12 monthly profit bars instead of one.

## 2. Compare cars page

**Goal:** pick 2–4 watchlist vehicles and judge them head-to-head.

**Where it lives:** new page `/compare`, added to top nav as "Compare". Also a "Compare selected" button appears on `/watchlist` once you tick 2+ rows (watchlist gets row checkboxes).

**Layout:** side-by-side columns (one per car, up to 4), responsive — stacks on mobile.

**Each column shows:**
- Header: image, year + make + model, city, verdict badge (Excellent / Good / Marginal / Avoid)
- **Key stats** (rows aligned across columns so your eye can scan):
  - Avg daily price
  - Assumed utilization
  - Monthly gross revenue
  - Turo fee
  - Total monthly costs
  - **Monthly profit** (highlighted, color-coded)
  - Margin %
  - Payback months
  - Purchase price (override or estimate)
- **Price trend sparkline** (last 30 days from `listings_snapshots`)
- **Cost breakdown mini bar** (insurance / maintenance / cleaning / depreciation / registration / tires)

**Top of page:**
- Car picker chips — choose which 2–4 watchlist cars to show (defaults to first 3)
- "Winner" callout — highlights the car with highest monthly profit and shortest payback
- Toggle: "Use seasonality-adjusted revenue" (ties into feature #1)

**Empty state:** if watchlist has < 2 cars, show a CTA pointing to the dashboard to bookmark some.

## Technical notes (for reference)

- New file `src/lib/seasonality.ts` — pure functions: `computeMonthlyMultipliers(snapshots)`, `computeWeekdayMultipliers(snapshots)`, `applySeasonality(profit, month, multiplier)`.
- New hook `src/hooks/useSeasonality.ts` — TanStack Query, params `{ city?, make?, model?, vehicle_id? }`, fetches from `listings_snapshots` (cap last 365 days, limit 5000 rows). Falls back: vehicle → make+model → city → all.
- New pages: `src/pages/Seasonality.tsx`, `src/pages/Compare.tsx`.
- Routes added in `src/App.tsx`; nav links added in `src/components/AppNav.tsx` (Seasonality + Compare icons).
- Watchlist (`src/pages/Watchlist.tsx`) gets row checkboxes + "Compare selected (n)" button → navigates to `/compare?ids=…`.
- Charts: reuse Recharts (already in project) — `BarChart` for seasonality, small inline `LineChart` for sparklines on Compare.
- All computations run client-side from snapshots; no schema changes, no new edge functions, no new secrets.
- Independent of the scraper-fix discussion — works on whatever snapshot data we have (sample or real once scraping is fixed).

