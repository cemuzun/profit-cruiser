import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Build the public Turo listing URL for a given vehicle id. */
export function turoCarUrl(vehicleId: string | number): string {
  return `https://turo.com/us/en/car-details/${vehicleId}/r`;
}
