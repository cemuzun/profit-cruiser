
# Turo Profitability Analyzer — LA & Miami

A data-driven tool to find the most profitable cars to list on Turo, and to score any specific car you're considering buying.

## How it works

**Daily scrape (background job)**
- Scheduled Supabase Edge Function runs once a day for Los Angeles and Miami.
- Calls Turo's internal search endpoint directly via `fetch` (deep scan: multiple price/vehicle-type segments per city to gather a broad set of listings, ~1000/city/day).
- Stores each listing snapshot in the database with timestamp so we build historical trends over time.
- Manual "Refresh now" button on the dashboard to trigger an on-demand scrape.

**Note on direct fetch:** Turo can change their internal API or block requests at any time. If/when that happens, we'll need to swap to a scraping service. We'll log failures clearly so you'll know when a scrape breaks.

**Profitability model (simple & transparent)**
- Monthly revenue = `avgDailyPrice × 30 × utilization%` (default 60%, adjustable globally and per-car).
- Monthly profit = Monthly revenue − Monthly operating cost.
- ROI shown as profit margin % and payback months.

**Operating cost (hybrid)**
- Smart defaults estimated from year/make/model/city: depreciation, insurance, maintenance, cleaning, Turo platform fee (25% default), tires, registration.
- Every line item is editable per car or globally in Settings.

## Screens

1. **Market Dashboard** (home)
   - City toggle: Los Angeles / Miami / Both
   - KPI strip: total listings tracked, avg daily price, avg estimated monthly profit, top performer
   - Sortable/filterable table of cars ranked by estimated monthly profit
   - Filters: make, model, year, vehicle type, fuel type, price range, min trips, min rating, All-Star host
   - Charts: avg daily price trend (last 30/90 days), profit distribution by make, supply trend per segment
   - Click a row → Car Detail

2. **Car Detail**
   - Full listing info, host stats, image, location
   - Price & utilization history chart (from snapshots)
   - Editable cost breakdown with live profit recalculation
   - "Save to watchlist" button

3. **Car Analyzer** (the "should I buy this?" tool)
   - Form: make, model, year, city, purchase price, expected utilization
   - Auto-pulls comparable listings from our DB to suggest realistic daily price (median, p25, p75 of similar cars in that city)
   - Output: estimated monthly revenue, total monthly costs (with breakdown), monthly profit, margin %, payback months, verdict badge (Excellent / Good / Marginal / Avoid)
   - Comparison table vs. top 5 similar listings currently on Turo

4. **Watchlist**
   - Saved cars from Dashboard or Detail
   - Side-by-side comparison view (revenue, costs, profit, trend sparkline)
   - Alert badge if price drops or new comparable listing beats it

5. **Settings**
   - Global defaults: utilization %, Turo fee %, insurance/month, maintenance/1000mi, cleaning/trip, depreciation %, etc.
   - Cities tracked (LA, Miami; expandable later)
   - Scrape schedule status + last run log

## Data model (high level)
- `listings_snapshots` — every scraped row with `scraped_at` (history)
- `listings_current` — latest snapshot per Turo vehicle ID (fast dashboard reads)
- `cost_assumptions` — global defaults + per-car overrides
- `watchlist` — saved vehicle IDs
- `scrape_runs` — job log (city, count, status, errors)

## Tech
- Lovable Cloud (Supabase) for DB + Edge Functions + scheduled cron
- Single-user mode (no login) — all data shared
- React + Tailwind + shadcn/ui, Recharts for charts
- TanStack Query for data fetching

## Out of scope for v1
- User accounts / multi-tenant
- Real Turo booking calendar / live availability beyond snapshot
- Other cities (easy to add later by parameter)
- Email/push alerts (badge alerts only in v1)
