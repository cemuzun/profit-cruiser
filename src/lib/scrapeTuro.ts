// Browser-side Turo scraper. Runs in the user's browser, so it uses the user's
// home IP — no proxy needed. Uses a public CORS proxy to bypass Turo's CORS restriction.

const CITIES: Record<string, { country: string; name: string }> = {
  "los-angeles": { country: "US", name: "Los Angeles" },
  "miami": { country: "US", name: "Miami" },
};

const PRICE_SEGMENTS: Array<[number, number]> = [
  [0, 50],
  [50, 80],
  [80, 120],
  [120, 180],
  [180, 300],
  [300, 1000],
];

const VEHICLE_TYPES = ["CAR", "SUV", "MINIVAN", "TRUCK", "VAN"];

// Public CORS proxy. If it ever fails we'll surface the error to the user.
const CORS_PROXY = "https://corsproxy.io/?";
const TURO_SEARCH_URL = "https://turo.com/api/v2/search";

function pickupReturnDates() {
  const start = new Date();
  start.setDate(start.getDate() + 7);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 3);
  return {
    pickupDate: start.toISOString().slice(0, 10),
    pickupTime: "10:00",
    dropoffDate: end.toISOString().slice(0, 10),
    dropoffTime: "10:00",
  };
}

async function fetchSegment(citySlug: string, vehicleType: string, minPrice: number, maxPrice: number) {
  const city = CITIES[citySlug];
  if (!city) throw new Error(`Unknown city ${citySlug}`);
  const dates = pickupReturnDates();

  const params = new URLSearchParams({
    country: city.country,
    defaultZoomLevel: "11",
    isMapSearch: "false",
    itemsPerPage: "200",
    location: city.name,
    locationType: "City",
    pickupTime: `${dates.pickupDate}T${dates.pickupTime}`,
    returnTime: `${dates.dropoffDate}T${dates.dropoffTime}`,
    region: city.country,
    sortType: "RELEVANCE",
    types: vehicleType,
    minDailyPriceUSD: String(minPrice),
    maxDailyPriceUSD: String(maxPrice),
  });

  const url = CORS_PROXY + encodeURIComponent(`${TURO_SEARCH_URL}?${params.toString()}`);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Turo ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const list =
    data?.searchResults ??
    data?.vehicles ??
    data?.list ??
    data?.results ??
    [];
  return Array.isArray(list) ? list : [];
}

function normalize(raw: any, citySlug: string) {
  const v = raw?.vehicle ?? raw;
  const id = String(v?.id ?? raw?.id ?? "");
  if (!id) return null;
  const make = v?.make ?? raw?.make ?? null;
  const model = v?.model ?? raw?.model ?? null;
  const year = Number(v?.year ?? raw?.year) || null;
  const trim = v?.trim ?? raw?.trim ?? null;
  const vehicleType = v?.type ?? raw?.type ?? null;
  const fuelType = v?.fuelTypeLabel ?? v?.fuelType ?? raw?.fuelType ?? null;
  const price =
    Number(
      raw?.avgDailyPrice?.amount ??
        raw?.avgDailyPrice ??
        raw?.dailyPrice?.amount ??
        raw?.dailyPriceWithCurrency?.amount ??
        raw?.rate?.amount,
    ) || null;
  const trips = Number(raw?.completedTrips ?? raw?.tripCount ?? v?.completedTrips) || 0;
  const rating = Number(raw?.rating ?? v?.rating ?? raw?.hostRating) || null;
  const allStar = Boolean(raw?.isAllStarHost ?? raw?.host?.allStarHost ?? false);
  const hostId = String(raw?.host?.id ?? raw?.owner?.id ?? "") || null;
  const hostName = raw?.host?.firstName ?? raw?.owner?.firstName ?? null;
  const image =
    raw?.images?.[0]?.originalImageUrl ??
    raw?.images?.[0]?.resizableUrlTemplate ??
    raw?.image?.url ??
    v?.image?.url ??
    null;
  const loc = raw?.location ?? v?.location ?? {};
  return {
    vehicle_id: id,
    city: citySlug,
    make,
    model,
    year,
    trim,
    vehicle_type: vehicleType,
    fuel_type: fuelType,
    avg_daily_price: price,
    currency: "USD",
    completed_trips: trips,
    rating,
    is_all_star_host: allStar,
    host_id: hostId,
    host_name: hostName,
    image_url: typeof image === "string" ? image.replace("{width}", "640").replace("{height}", "480") : null,
    location_city: loc?.city ?? null,
    location_state: loc?.state ?? null,
    latitude: Number(loc?.latitude) || null,
    longitude: Number(loc?.longitude) || null,
    raw,
  };
}

export type ScrapeProgress = {
  city: string;
  done: number;
  total: number;
  found: number;
};

export async function scrapeCityInBrowser(
  citySlug: string,
  onProgress?: (p: ScrapeProgress) => void,
): Promise<{ rows: any[]; segments: number; error: string | null }> {
  const seen = new Map<string, any>();
  const total = VEHICLE_TYPES.length * PRICE_SEGMENTS.length;
  let done = 0;
  let segments = 0;
  let lastErr: string | null = null;

  for (const vt of VEHICLE_TYPES) {
    for (const [minP, maxP] of PRICE_SEGMENTS) {
      try {
        const list = await fetchSegment(citySlug, vt, minP, maxP);
        segments++;
        for (const raw of list) {
          const n = normalize(raw, citySlug);
          if (n && !seen.has(n.vehicle_id)) seen.set(n.vehicle_id, n);
        }
        await new Promise((r) => setTimeout(r, 200));
      } catch (e: any) {
        lastErr = e.message;
        console.error(`Segment ${citySlug}/${vt}/${minP}-${maxP}:`, e.message);
      }
      done++;
      onProgress?.({ city: citySlug, done, total, found: seen.size });
    }
  }
  return { rows: Array.from(seen.values()), segments, error: lastErr };
}
