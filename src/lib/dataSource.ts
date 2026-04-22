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

async function fetchCities(): Promise<City[]> {
  const { data, error } = await supabase
    .from("cities")
    .select("*")
    .order("name");
  if (error) throw error;
  return (data ?? []) as City[];
}

export const ds = {
  listings: () => fetchAllListings(),
  snapshots: () => fetchSnapshots(),
  forecasts: () => fetchForecasts(),
  runs: () => fetchRuns(),
  cities: () => fetchCities(),

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
    const { data, error } = await supabase.functions.invoke("scrape-turo", {
      body: citySlug ? { city: citySlug } : { all: true },
    });
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
