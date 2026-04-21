import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { DEFAULT_GLOBAL, type GlobalCosts, type AcquisitionMode } from "@/lib/profitability";

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
      const d: any = data;
      return {
        utilization_pct: Number(d.utilization_pct),
        turo_fee_pct: Number(d.turo_fee_pct),
        insurance_monthly: Number(d.insurance_monthly),
        maintenance_monthly: Number(d.maintenance_monthly),
        cleaning_per_trip: Number(d.cleaning_per_trip),
        depreciation_pct_annual: Number(d.depreciation_pct_annual),
        registration_monthly: Number(d.registration_monthly),
        tires_monthly: Number(d.tires_monthly),
        default_purchase_price: Number(d.default_purchase_price),
        trips_per_month_estimate: Number(d.trips_per_month_estimate),
        default_acquisition_mode: (d.default_acquisition_mode ?? "buy") as AcquisitionMode,
        default_lease_monthly: Number(d.default_lease_monthly ?? DEFAULT_GLOBAL.default_lease_monthly),
        default_lease_down: Number(d.default_lease_down ?? DEFAULT_GLOBAL.default_lease_down),
        default_lease_term_months: Number(d.default_lease_term_months ?? DEFAULT_GLOBAL.default_lease_term_months),
        default_mileage_cap_monthly: Number(d.default_mileage_cap_monthly ?? DEFAULT_GLOBAL.default_mileage_cap_monthly),
        default_mileage_overage_per_mi: Number(d.default_mileage_overage_per_mi ?? DEFAULT_GLOBAL.default_mileage_overage_per_mi),
        default_avg_miles_per_trip: Number(d.default_avg_miles_per_trip ?? DEFAULT_GLOBAL.default_avg_miles_per_trip),
      };
    },
  });
}
