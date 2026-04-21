import { useQuery } from "@tanstack/react-query";
import { ds, type Snapshot } from "@/lib/dataSource";
import type { SnapshotLite } from "@/lib/seasonality";

export type SeasonalityParams = {
  city?: string; // "all" | city
  make?: string | null;
  model?: string | null;
  vehicle_id?: string | null;
};

// Fetches the full snapshots JSON from the VPS once (React Query caches it),
// then filters in-memory at multiple specificity levels until we have ≥30 rows.
export function useSeasonality(params: SeasonalityParams) {
  const { city, make, model, vehicle_id } = params;
  return useQuery({
    queryKey: ["seasonality", city ?? "all", make ?? null, model ?? null, vehicle_id ?? null],
    queryFn: async () => {
      const all = await ds.snapshots();
      const lite = (rows: Snapshot[]): SnapshotLite[] =>
        rows.map(r => ({ scraped_at: r.scraped_at, avg_daily_price: r.avg_daily_price }));

      let level: "vehicle" | "model" | "city" | "all" = "all";
      let rows: Snapshot[] = [];

      if (vehicle_id) {
        rows = all.filter(r => r.vehicle_id === vehicle_id);
        if (rows.length >= 30) level = "vehicle"; else rows = [];
      }
      if (!rows.length && make && model) {
        const mk = make.toLowerCase(), md = model.toLowerCase();
        rows = all.filter(r =>
          (r.make ?? "").toLowerCase() === mk &&
          (r.model ?? "").toLowerCase() === md);
        if (rows.length >= 30) level = "model"; else rows = [];
      }
      if (!rows.length && city && city !== "all") {
        rows = all.filter(r => r.city === city);
        level = "city";
      }
      if (!rows.length) {
        rows = all;
        level = "all";
      }

      return { rows: lite(rows), level };
    },
  });
}
