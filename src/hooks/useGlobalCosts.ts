import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { DEFAULT_GLOBAL, type GlobalCosts } from "@/lib/profitability";

export function useGlobalCosts() {
  return useQuery({
    queryKey: ["global-costs"],
    queryFn: async (): Promise<GlobalCosts> => {
      const { data, error } = await supabase
        .from("cost_assumptions_global")
        .select("*")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return DEFAULT_GLOBAL;
      return {
        utilization_pct: Number(data.utilization_pct),
        turo_fee_pct: Number(data.turo_fee_pct),
        insurance_monthly: Number(data.insurance_monthly),
        maintenance_monthly: Number(data.maintenance_monthly),
        cleaning_per_trip: Number(data.cleaning_per_trip),
        depreciation_pct_annual: Number(data.depreciation_pct_annual),
        registration_monthly: Number(data.registration_monthly),
        tires_monthly: Number(data.tires_monthly),
        default_purchase_price: Number(data.default_purchase_price),
        trips_per_month_estimate: Number(data.trips_per_month_estimate),
      };
    },
  });
}
