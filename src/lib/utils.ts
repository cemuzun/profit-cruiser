import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Build the public Turo listing URL for a given vehicle.
 *  Priority:
 *   1. The full URL captured at scrape time (`listing_url`).
 *   2. A reconstructed `/rentals/.../<id>` path from city/make/model when available.
 *   3. The `/car-details/{id}` shorthand (often 404s for delisted cars). */
export function turoCarUrl(
  vehicleId: string | number,
  listingUrl?: string | null,
  ctx?: { city?: string | null; make?: string | null; model?: string | null; vehicle_type?: string | null },
): string {
  if (listingUrl && listingUrl.startsWith("http")) return listingUrl;
  if (ctx?.city && ctx?.make && ctx?.model) {
    const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const typeMap: Record<string, string> = {
      SUV: "suv-rental", TRUCK: "truck-rental", MINIVAN: "minivan-rental",
      VAN: "van-rental", SPORTS: "sports-rental", EXOTIC: "exotic-luxury-rental",
      CONVERTIBLE: "convertible-rental", EV: "electric-vehicle-rental",
    };
    const cat = typeMap[(ctx.vehicle_type ?? "").toUpperCase()] ?? "car-rental";
    return `https://turo.com/us/en/${cat}/united-states/${slugify(ctx.city)}/${slugify(ctx.make)}/${slugify(ctx.model)}/${vehicleId}`;
  }
  return `https://turo.com/us/en/car-details/${vehicleId}`;
}
