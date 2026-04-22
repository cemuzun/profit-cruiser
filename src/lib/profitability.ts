// Profitability math, shared across screens.

export type AcquisitionMode = "buy" | "lease";

export type GlobalCosts = {
  utilization_pct: number;
  turo_fee_pct: number;
  insurance_monthly: number;
  maintenance_monthly: number;
  cleaning_per_trip: number;
  depreciation_pct_annual: number;
  registration_monthly: number;
  tires_monthly: number;
  default_purchase_price: number;
  trips_per_month_estimate: number;
  // Lease + mileage defaults
  default_acquisition_mode: AcquisitionMode;
  default_lease_monthly: number;
  default_lease_down: number;
  default_lease_term_months: number;
  default_mileage_cap_monthly: number;
  default_mileage_overage_per_mi: number;
  default_avg_miles_per_trip: number;
  default_avg_miles_per_day?: number | null;
};

export type CostOverride = Partial<GlobalCosts> & {
  purchase_price?: number | null;
  acquisition_mode?: AcquisitionMode | null;
  lease_monthly?: number | null;
  lease_down?: number | null;
  lease_term_months?: number | null;
  mileage_cap_monthly?: number | null;
  mileage_overage_per_mi?: number | null;
  avg_miles_per_trip?: number | null;
  avg_miles_per_day?: number | null;
};

export type CarLike = {
  vehicle_id: string;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  avg_daily_price?: number | null;
};

export const DEFAULT_GLOBAL: GlobalCosts = {
  utilization_pct: 60,
  turo_fee_pct: 25,
  insurance_monthly: 200,
  maintenance_monthly: 150,
  cleaning_per_trip: 25,
  depreciation_pct_annual: 15,
  registration_monthly: 25,
  tires_monthly: 30,
  default_purchase_price: 25000,
  trips_per_month_estimate: 8,
  default_acquisition_mode: "buy",
  default_lease_monthly: 450,
  default_lease_down: 3000,
  default_lease_term_months: 36,
  default_mileage_cap_monthly: 1000,
  default_mileage_overage_per_mi: 0.25,
  default_avg_miles_per_trip: 80,
  default_avg_miles_per_day: null,
};

// Smart estimate of purchase price based on year/make (very rough fallback).
export function estimatePurchasePrice(car: CarLike, fallback: number): number {
  const year = car.year ?? new Date().getFullYear() - 5;
  const age = Math.max(0, new Date().getFullYear() - year);
  const luxuryMakes = ["tesla", "porsche", "bmw", "mercedes", "audi", "lexus", "land rover", "jaguar", "maserati"];
  const isLuxury = luxuryMakes.includes((car.make ?? "").toLowerCase());
  const base = isLuxury ? 65000 : 30000;
  const depreciated = base * Math.pow(0.85, age);
  return Math.max(8000, Math.round(depreciated));
}

export function effectiveCosts(global: GlobalCosts, override?: CostOverride | null): GlobalCosts & {
  purchase_price: number | null;
  acquisition_mode: AcquisitionMode;
  lease_monthly: number;
  lease_down: number;
  lease_term_months: number;
  mileage_cap_monthly: number;
  mileage_overage_per_mi: number;
  avg_miles_per_trip: number;
  avg_miles_per_day: number | null;
} {
  const merged: any = { ...global };
  if (override) {
    for (const k of Object.keys(global) as (keyof GlobalCosts)[]) {
      if ((override as any)[k] != null) merged[k] = (override as any)[k];
    }
  }
  merged.purchase_price = override?.purchase_price ?? null;
  merged.acquisition_mode = (override?.acquisition_mode ?? global.default_acquisition_mode) as AcquisitionMode;
  merged.lease_monthly = override?.lease_monthly ?? global.default_lease_monthly;
  merged.lease_down = override?.lease_down ?? global.default_lease_down;
  merged.lease_term_months = override?.lease_term_months ?? global.default_lease_term_months;
  merged.mileage_cap_monthly = override?.mileage_cap_monthly ?? global.default_mileage_cap_monthly;
  merged.mileage_overage_per_mi = override?.mileage_overage_per_mi ?? global.default_mileage_overage_per_mi;
  merged.avg_miles_per_trip = override?.avg_miles_per_trip ?? global.default_avg_miles_per_trip;
  merged.avg_miles_per_day = override?.avg_miles_per_day ?? global.default_avg_miles_per_day ?? null;
  return merged;
}

export type Profit = {
  monthlyRevenueGross: number;
  turoFee: number;
  monthlyRevenueNet: number;
  costInsurance: number;
  costMaintenance: number;
  costCleaning: number;
  costDepreciation: number; // 0 when leasing
  costLease: number;        // monthly lease + amortized down (0 when buying)
  costRegistration: number;
  costTires: number;
  costMileageOverage: number;
  estimatedMilesPerMonth: number;
  totalCost: number;
  monthlyProfit: number;
  marginPct: number;
  paybackMonths: number | null;
  upfrontCost: number;       // purchase price OR lease down
  purchasePrice: number | null;
  utilizationPct: number;
  dailyPrice: number;
  acquisitionMode: AcquisitionMode;
};

export function computeProfit(car: CarLike, global: GlobalCosts, override?: CostOverride | null): Profit {
  const eff = effectiveCosts(global, override);
  const dailyPrice = car.avg_daily_price ?? 0;
  const utilizationPct = eff.utilization_pct;
  const monthlyRevenueGross = dailyPrice * 30 * (utilizationPct / 100);
  const turoFee = monthlyRevenueGross * (eff.turo_fee_pct / 100);
  const monthlyRevenueNet = monthlyRevenueGross - turoFee;

  const tripsPerMonth = eff.trips_per_month_estimate * (utilizationPct / 60);
  // If avg_miles_per_day is set, it takes precedence: miles/mo = 30 * utilization% * miles/day
  // Otherwise fall back to per-trip estimate: miles/mo = trips/mo * miles/trip
  const estimatedMilesPerMonth = eff.avg_miles_per_day != null && eff.avg_miles_per_day > 0
    ? 30 * (utilizationPct / 100) * eff.avg_miles_per_day
    : tripsPerMonth * eff.avg_miles_per_trip;
  const overageMiles = Math.max(0, estimatedMilesPerMonth - eff.mileage_cap_monthly);
  const costMileageOverage = overageMiles * eff.mileage_overage_per_mi;

  let costDepreciation = 0;
  let costLease = 0;
  let upfrontCost = 0;
  let purchasePrice: number | null = null;

  if (eff.acquisition_mode === "lease") {
    const amortizedDown = eff.lease_term_months > 0 ? eff.lease_down / eff.lease_term_months : 0;
    costLease = eff.lease_monthly + amortizedDown;
    upfrontCost = eff.lease_down;
  } else {
    purchasePrice = eff.purchase_price ?? estimatePurchasePrice(car, eff.default_purchase_price);
    costDepreciation = (purchasePrice * (eff.depreciation_pct_annual / 100)) / 12;
    upfrontCost = purchasePrice;
  }

  const costInsurance = eff.insurance_monthly;
  const costMaintenance = eff.maintenance_monthly;
  const costCleaning = eff.cleaning_per_trip * tripsPerMonth;
  const costRegistration = eff.registration_monthly;
  const costTires = eff.tires_monthly;

  const totalCost =
    costInsurance + costMaintenance + costCleaning + costDepreciation + costLease +
    costRegistration + costTires + costMileageOverage;

  const monthlyProfit = monthlyRevenueNet - totalCost;
  const marginPct = monthlyRevenueGross > 0 ? (monthlyProfit / monthlyRevenueGross) * 100 : 0;
  const paybackMonths = monthlyProfit > 0 && upfrontCost > 0 ? upfrontCost / monthlyProfit : null;

  return {
    monthlyRevenueGross,
    turoFee,
    monthlyRevenueNet,
    costInsurance,
    costMaintenance,
    costCleaning,
    costDepreciation,
    costLease,
    costRegistration,
    costTires,
    costMileageOverage,
    estimatedMilesPerMonth,
    totalCost,
    monthlyProfit,
    marginPct,
    paybackMonths,
    upfrontCost,
    purchasePrice,
    utilizationPct,
    dailyPrice,
    acquisitionMode: eff.acquisition_mode,
  };
}

export function verdict(profit: Profit): { label: string; tone: "excellent" | "good" | "marginal" | "avoid" } {
  if (profit.monthlyProfit <= 0) return { label: "Avoid", tone: "avoid" };
  // Lease has no payback (or trivial down-payback) — judge mostly on margin
  if (profit.acquisitionMode === "lease") {
    if (profit.marginPct > 35) return { label: "Excellent", tone: "excellent" };
    if (profit.marginPct > 20) return { label: "Good", tone: "good" };
    return { label: "Marginal", tone: "marginal" };
  }
  if (profit.paybackMonths == null) return { label: "Avoid", tone: "avoid" };
  if (profit.paybackMonths < 24 && profit.marginPct > 30) return { label: "Excellent", tone: "excellent" };
  if (profit.paybackMonths < 48 && profit.marginPct > 15) return { label: "Good", tone: "good" };
  return { label: "Marginal", tone: "marginal" };
}

export const fmtUSD = (n: number | null | undefined) =>
  n == null ? "—" : `$${Math.round(n).toLocaleString()}`;

export const fmtPct = (n: number | null | undefined, digits = 0) =>
  n == null ? "—" : `${n.toFixed(digits)}%`;
