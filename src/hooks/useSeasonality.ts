import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { SnapshotLite } from "@/lib/seasonality";

export type SeasonalityParams = {
  city?: string; // "all" | city
  make?: string | null;
  model?: string | null;
  vehicle_id?: string | null;
};

export function useSeasonality(params: SeasonalityParams) {
  const { city, make, model, vehicle_id } = params;
  return useQuery({
    queryKey: ["seasonality", city ?? "all", make ?? null, model ?? null, vehicle_id ?? null],
    queryFn: async () => {
      const since = new Date();
      since.setDate(since.getDate() - 365);

      const baseSelect = "scraped_at, avg_daily_price, city, make, model, vehicle_id";

      // Try most-specific first; fall back if too few rows.
      const tryFetch = async (filter: (q: any) => any) => {
        let q = supabase
          .from("listings_snapshots")
          .select(baseSelect)
          .gte("scraped_at", since.toISOString())
          .limit(5000);
        q = filter(q);
        const { data, error } = await q;
        if (error) throw error;
        return (data ?? []) as SnapshotLite[];
      };

      let level: "vehicle" | "model" | "city" | "all" = "all";
      let rows: SnapshotLite[] = [];

      if (vehicle_id) {
        rows = await tryFetch((q) => q.eq("vehicle_id", vehicle_id));
        if (rows.length >= 30) level = "vehicle";
        else rows = [];
      }
      if (!rows.length && make && model) {
        rows = await tryFetch((q) => q.eq("make", make).eq("model", model));
        if (rows.length >= 30) level = "model";
        else rows = [];
      }
      if (!rows.length && city && city !== "all") {
        rows = await tryFetch((q) => q.eq("city", city));
        level = "city";
      }
      if (!rows.length) {
        rows = await tryFetch((q) => q);
        level = "all";
      }

      return { rows, level };
    },
  });
}
