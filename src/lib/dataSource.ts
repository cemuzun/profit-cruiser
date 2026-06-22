// Data source: reads from Lovable Cloud (Supabase) for scraped data,
// and uses localStorage for user-owned state (watchlist, cost overrides,
// global settings). Scraping is performed by the scrape-turo edge function
// (Firecrawl-powered) and writes into the listings_current / snapshots /
// price_forecasts / scrape_runs tables.

import { supabase } from "@/integrations/supabase/client";
import { DEFAULT_GLOBAL, type GlobalCosts, type AcquisitionMode } from "./profitability";

// ---------- Types mirroring DB rows ----------
export type Listing = {
  vehicle_id: string;
  city: string;
  make: string | null;
  model: string | null;
  year: number | null;
  trim: string | null;
  vehicle_type: string | null;
  fuel_type: string | null;
  avg_daily_price: number | null;
  currency: string | null;
  price_7d_avg: number | null;
  price_14d_avg: number | null;
  price_30d_avg: number | null;
  completed_trips: number | null;
  rating: number | null;
  is_all_star_host: boolean | null;
  host_id: string | null;
  host_name: string | null;
  image_url: string | null;
  location_city: string | null;
  location_state: string | null;
  latitude: number | null;
  longitude: number | null;
  last_scraped_at: string;
  updated_at: string;
};

export type Snapshot = {
  vehicle_id: string;
  city: string;
  make: string | null;
  model: string | null;
  year: number | null;
  vehicle_type: string | null;
  fuel_type: string | null;
  avg_daily_price: number | null;
  completed_trips: number | null;
  scraped_at: string;
};

export type Forecast = {
  vehicle_id: string;
  city: string;
  window_label: "7d" | "14d" | "30d";
  avg_price: number | null;
  min_price: number | null;
  max_price: number | null;
  window_start: string;
  window_end: string;
  scraped_at: string;
};

export type ScrapeRun = {
  id: string;
  city: string;
  status: string;
  vehicles_count: number | null;
  segments_run: number | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
};

export type City = {
  slug: string;
  name: string;
  country: string;
  region: string | null;
  latitude: number;
  longitude: number;
  place_id: string | null;
  active: boolean;
};

// ---------- Supabase-backed reads ----------
async function fetchAllListings(): Promise<Listing[]> {
  const PAGE = 1000;
  let from = 0;
  const all: Listing[] = [];
  while (true) {
    const { data, error } = await supabase
      .from("listings_current")
      .select("*")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as Listing[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function fetchSnapshots(): Promise<Snapshot[]> {
  // Limit to last 90 days to stay manageable
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const PAGE = 1000;
  let from = 0;
  const all: Snapshot[] = [];
  while (true) {
    const { data, error } = await supabase
      .from("listings_snapshots")
      .select("vehicle_id, city, make, model, year, vehicle_type, fuel_type, avg_daily_price, completed_trips, scraped_at")
      .gte("scraped_at", since)
      .order("scraped_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as Snapshot[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function fetchForecasts(): Promise<Forecast[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("price_forecasts")
    .select("*")
    .gte("scraped_at", since)
    .order("scraped_at", { ascending: false })
    .limit(5000);
  if (error) throw error;
  return (data ?? []) as Forecast[];
}

async function fetchRuns(): Promise<ScrapeRun[]> {
  const { data, error } = await supabase
    .from("scrape_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as ScrapeRun[];
}

export type CalendarScrapeRun = {
  id: string;
  city: string;
  status: string;
  vehicles_attempted: number | null;
  vehicles_ok: number | null;
  vehicles_failed: number | null;
  source_api_count: number | null;
  source_html_count: number | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
};

async function fetchScrapeRuns(limit = 200): Promise<ScrapeRun[]> {
  const { data, error } = await supabase
    .from("scrape_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ScrapeRun[];
}

async function fetchCalendarScrapeRuns(limit = 200): Promise<CalendarScrapeRun[]> {
  const { data, error } = await supabase
    .from("calendar_scrape_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as CalendarScrapeRun[];
}

async function fetchCities(): Promise<City[]> {
  const { data, error } = await supabase
    .from("cities")
    .select("*")
    .order("name");
  if (error) throw error;
  return (data ?? []) as City[];
}

export type ScrapeFilters = {
  vehicle_types: string[];
  fuel_types: string[];
  min_daily_price: number | null;
  max_daily_price: number | null;
  min_year: number | null;
  max_year: number | null;
  min_trips: number | null;
  min_rating: number | null;
  enabled: boolean;
  updated_at?: string;
};

export const ALL_FUEL_TYPES = ["GAS", "HYBRID", "ELECTRIC", "DIESEL"] as const;

export const ALL_VEHICLE_TYPES = [
  "car-rental",
  "suv-rental",
  "truck-rental",
  "minivan-rental",
  "van-rental",
  "sports-rental",
  "exotic-luxury-rental",
  "convertible-rental",
  "electric-vehicle-rental",
] as const;

async function fetchScrapeFilters(): Promise<ScrapeFilters> {
  const { data, error } = await supabase
    .from("scrape_filters")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return { vehicle_types: [], fuel_types: [], min_daily_price: null, max_daily_price: null, min_year: null, max_year: null, min_trips: null, min_rating: null, enabled: true };
  }
  return data as ScrapeFilters;
}

async function saveScrapeFilters(f: Omit<ScrapeFilters, "updated_at">) {
  const { error } = await supabase
    .from("scrape_filters")
    .update({ ...f, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw error;
}

export type PriceAnomaly = {
  id: string;
  vehicle_id: string;
  city: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  attempted_price: number | null;
  previous_price: number | null;
  kept_price: number | null;
  reason: string;
  source: string | null;
  listing_url: string | null;
  detected_at: string;
  reviewed: boolean;
  reviewed_at: string | null;
};

async function fetchPriceAnomalies(opts: { onlyUnreviewed?: boolean; limit?: number } = {}): Promise<PriceAnomaly[]> {
  let q = supabase
    .from("price_anomalies")
    .select("*")
    .order("detected_at", { ascending: false })
    .limit(opts.limit ?? 500);
  if (opts.onlyUnreviewed) q = q.eq("reviewed", false);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as PriceAnomaly[];
}

async function setAnomalyReviewed(id: string, reviewed: boolean) {
  const { error } = await supabase
    .from("price_anomalies")
    .update({ reviewed, reviewed_at: reviewed ? new Date().toISOString() : null })
    .eq("id", id);
  if (error) throw error;
}

// Occupancy per vehicle from the scraped Turo calendar, split into two views:
//
//  • ACTUAL  — measured from confirmed bookings. Because we re-scrape the
//    calendar every day, we can watch a future day flip from available -> booked
//    while we observe it. Each such transition is a real booking that happened.
//    actualPct = booked days / observed past days (day < today).
//
//  • PROJECTED — the current forward-looking snapshot. For upcoming days
//    (day >= today) we take the most recent capture and count how many are
//    already marked unavailable. This includes bookings already on the books
//    plus host-blocked days, so it's an estimate of near-term demand.
export type Occupancy = {
  actualPct: number;
  actualObserved: number;
  projectedPct: number;
  projectedObserved: number;
  // Back-compat: existing callers read occupancyPct/observedDays.
  occupancyPct: number;
  observedDays: number;
};

async function fetchOccupancyByVehicle(windowDays = 30): Promise<Record<string, Occupancy>> {
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const end = new Date(Date.now() + windowDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const pageSize = 1000;
  let from = 0;
  type Row = { vehicle_id: string; day: string; is_available: boolean | null; captured_on: string };
  const rows: Row[] = [];
  // Paginate so we don't silently truncate at 1000 rows.
  for (;;) {
    const { data, error } = await supabase
      .from("listing_calendar_days")
      .select("vehicle_id, day, is_available, captured_on")
      .gte("day", start)
      .lte("day", end)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  // Group every capture by vehicle+day so we can both look at the latest state
  // (projected) and replay the capture history to detect bookings (actual).
  const byDay = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.vehicle_id}|${r.day}`;
    const list = byDay.get(key);
    if (list) list.push(r);
    else byDay.set(key, [r]);
  }

  type Agg = { actualBooked: number; actualObs: number; projBooked: number; projObs: number };
  const agg = new Map<string, Agg>();
  const get = (id: string) => {
    let a = agg.get(id);
    if (!a) { a = { actualBooked: 0, actualObs: 0, projBooked: 0, projObs: 0 }; agg.set(id, a); }
    return a;
  };

  for (const [key, list] of byDay) {
    const [vehicle_id, day] = key.split("|");
    list.sort((x, y) => (x.captured_on < y.captured_on ? -1 : 1));
    const a = get(vehicle_id);

    if (day < today) {
      // ACTUAL: a real booking = a day we watched flip from available -> booked.
      a.actualObs += 1;
      let sawAvailable = false;
      let booked = false;
      for (const r of list) {
        if (r.is_available === true) sawAvailable = true;
        else if (r.is_available === false && sawAvailable) booked = true;
      }
      if (booked) a.actualBooked += 1;
    } else {
      // PROJECTED: latest known state of an upcoming day.
      const latest = list[list.length - 1];
      if (latest.is_available != null) {
        a.projObs += 1;
        if (latest.is_available === false) a.projBooked += 1;
      }
    }
  }

  const out: Record<string, Occupancy> = {};
  for (const [vehicle_id, a] of agg) {
    if (a.actualObs === 0 && a.projObs === 0) continue;
    const actualPct = a.actualObs ? Math.round((a.actualBooked / a.actualObs) * 100) : 0;
    const projectedPct = a.projObs ? Math.round((a.projBooked / a.projObs) * 100) : 0;
    out[vehicle_id] = {
      actualPct,
      actualObserved: a.actualObs,
      projectedPct,
      projectedObserved: a.projObs,
      // Prefer actual when we have a meaningful sample, else fall back to projected.
      occupancyPct: a.actualObs >= 7 ? actualPct : projectedPct,
      observedDays: a.actualObs >= 7 ? a.actualObs : a.projObs,
    };
  }
  return out;
}

export const ds = {
  listings: () => fetchAllListings(),
  snapshots: () => fetchSnapshots(),
  forecasts: () => fetchForecasts(),
  runs: () => fetchRuns(),
  scrapeRuns: (limit?: number) => fetchScrapeRuns(limit),
  calendarScrapeRuns: (limit?: number) => fetchCalendarScrapeRuns(limit),
  cities: () => fetchCities(),
  scrapeFilters: () => fetchScrapeFilters(),
  saveScrapeFilters,
  priceAnomalies: (opts?: { onlyUnreviewed?: boolean; limit?: number }) => fetchPriceAnomalies(opts),
  setAnomalyReviewed,
  occupancyByVehicle: (windowDays?: number) => fetchOccupancyByVehicle(windowDays),

  async addCity(city: Omit<City, "active"> & { active?: boolean }) {
    const { error } = await supabase.from("cities").insert({
      ...city,
      active: city.active ?? true,
    });
    if (error) throw error;
  },
  async removeCity(slug: string) {
    const { error } = await supabase.from("cities").delete().eq("slug", slug);
    if (error) throw error;
  },
  async setCityActive(slug: string, active: boolean) {
    const { error } = await supabase
      .from("cities")
      .update({ active })
      .eq("slug", slug);
    if (error) throw error;
  },
  async triggerScrape(citySlug?: string) {
    const body = citySlug
      ? { city: citySlug, background: true }
      : { all: true, background: true };
    const { data, error } = await supabase.functions.invoke("scrape-turo", { body });
    if (error) throw error;
    return data;
  },
};

// ---------- LocalStorage-backed user state ----------
const LS_WATCHLIST = "turo:watchlist:v1";
const LS_OVERRIDES = "turo:overrides:v1";
const LS_GLOBAL = "turo:global:v1";

function readLS<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch { return fallback; }
}
function writeLS(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

export type WatchEntry = { vehicle_id: string; added_at: string; notes?: string | null };
export type CostOverrideRecord = {
  vehicle_id: string;
  acquisition_mode?: AcquisitionMode | null;
  utilization_pct?: number | null;
  turo_fee_pct?: number | null;
  insurance_monthly?: number | null;
  maintenance_monthly?: number | null;
  cleaning_per_trip?: number | null;
  depreciation_pct_annual?: number | null;
  registration_monthly?: number | null;
  tires_monthly?: number | null;
  purchase_price?: number | null;
  lease_monthly?: number | null;
  lease_down?: number | null;
  lease_term_months?: number | null;
  mileage_cap_monthly?: number | null;
  mileage_overage_per_mi?: number | null;
  avg_miles_per_trip?: number | null;
  avg_miles_per_day?: number | null;
  notes?: string | null;
  updated_at: string;
};

export const userStore = {
  getWatchlist(): WatchEntry[] {
    return readLS<WatchEntry[]>(LS_WATCHLIST, []);
  },
  isWatched(id: string): boolean {
    return this.getWatchlist().some(w => w.vehicle_id === id);
  },
  addWatch(id: string) {
    const list = this.getWatchlist();
    if (list.some(w => w.vehicle_id === id)) return;
    list.unshift({ vehicle_id: id, added_at: new Date().toISOString() });
    writeLS(LS_WATCHLIST, list);
  },
  removeWatch(id: string) {
    writeLS(LS_WATCHLIST, this.getWatchlist().filter(w => w.vehicle_id !== id));
  },

  getOverrides(): Record<string, CostOverrideRecord> {
    return readLS<Record<string, CostOverrideRecord>>(LS_OVERRIDES, {});
  },
  getOverride(id: string): CostOverrideRecord | null {
    return this.getOverrides()[id] ?? null;
  },
  setOverride(id: string, patch: Omit<CostOverrideRecord, "vehicle_id" | "updated_at">) {
    const all = this.getOverrides();
    all[id] = { vehicle_id: id, ...patch, updated_at: new Date().toISOString() };
    writeLS(LS_OVERRIDES, all);
  },

  getGlobal(): GlobalCosts {
    return readLS<GlobalCosts>(LS_GLOBAL, DEFAULT_GLOBAL);
  },
  setGlobal(g: GlobalCosts) {
    writeLS(LS_GLOBAL, g);
  },
};
