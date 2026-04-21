// Client-side data source backed by static JSON served from the VPS scraper
// (Caddy at https://187-124-69-23.sslip.io/data/*.json) plus localStorage for
// user-owned state (watchlist, cost overrides, global settings).
//
// All previous pages used `supabase.from(...).select()` against Lovable Cloud.
// They now go through this module instead. Lovable Cloud is no longer involved
// in scraping or reads; this file is the single source of truth on the client.

import { DEFAULT_GLOBAL, type GlobalCosts, type AcquisitionMode } from "./profitability";

const DATA_BASE = (import.meta.env.VITE_DATA_BASE_URL as string | undefined)?.replace(/\/+$/, "")
  ?? "https://187-124-69-23.sslip.io";

// ---------- Types mirroring the JSON shape produced by scraper.mjs ----------
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

// ---------- Cached fetchers (module-level memoization) ----------
const cache = new Map<string, Promise<any>>();

function fetchJson<T>(file: string): Promise<T> {
  if (!cache.has(file)) {
    cache.set(
      file,
      fetch(`${DATA_BASE}/data/${file}`, { cache: "no-store" })
        .then(r => {
          if (!r.ok) throw new Error(`Failed to load ${file}: ${r.status}`);
          return r.json();
        })
        .catch(e => {
          // Don't poison the cache on failure — let next call retry.
          cache.delete(file);
          throw e;
        }),
    );
  }
  return cache.get(file) as Promise<T>;
}

export const ds = {
  listings: () => fetchJson<Listing[]>("listings.json"),
  snapshots: () => fetchJson<Snapshot[]>("snapshots.json"),
  forecasts: () => fetchJson<Forecast[]>("forecasts.json"),
  runs: () => fetchJson<ScrapeRun[]>("runs.json"),
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
  notes?: string | null;
  updated_at: string;
};

export const userStore = {
  // ----- Watchlist -----
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

  // ----- Per-car cost overrides -----
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

  // ----- Global cost settings -----
  getGlobal(): GlobalCosts {
    return readLS<GlobalCosts>(LS_GLOBAL, DEFAULT_GLOBAL);
  },
  setGlobal(g: GlobalCosts) {
    writeLS(LS_GLOBAL, g);
  },
};
