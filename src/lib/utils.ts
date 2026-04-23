import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Build the public Turo listing URL for a given vehicle id.
 *  Prefer the full discovered URL (stored as `listing_url`) when available,
 *  since Turo's `/car-details/{id}` shorthand does not always resolve. */
export function turoCarUrl(vehicleId: string | number, listingUrl?: string | null): string {
  if (listingUrl && listingUrl.startsWith("http")) return listingUrl;
  return `https://turo.com/us/en/car-details/${vehicleId}`;
}
