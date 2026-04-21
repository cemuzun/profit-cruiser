// Profitability math, shared across screens.

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
};

export type CostOverride = Partial<GlobalCosts> & { purchase_price?: number | null };

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

export function effectiveCosts(global: GlobalCosts, override?: CostOverride | null): GlobalCosts & { purchase_price: number } {
  const merged: any = { ...global };
  if (override) {
    for (const k of Object.keys(global) as (keyof GlobalCosts)[]) {
      if (override[k] != null) merged[k] = override[k];
    }
  }
  merged.purchase_price = override?.purchase_price ?? null;
  return merged;
}

export type Profit = {
  monthlyRevenueGross: number;
  turoFee: number;
  monthlyRevenueNet: number;
  costInsurance: number;
  costMaintenance: number;
  costCleaning: number;
  costDepreciation: number;
  costRegistration: number;
  costTires: number;
  totalCost: number;
  monthlyProfit: number;
  marginPct: number;
  paybackMonths: number | null;
  purchasePrice: number;
  utilizationPct: number;
  dailyPrice: number;
};

export function computeProfit(car: CarLike, global: GlobalCosts, override?: CostOverride | null): Profit {
  const eff = effectiveCosts(global, override);
  const dailyPrice = car.avg_daily_price ?? 0;
  const utilizationPct = eff.utilization_pct;
  const monthlyRevenueGross = dailyPrice * 30 * (utilizationPct / 100);
  const turoFee = monthlyRevenueGross * (eff.turo_fee_pct / 100);
  const monthlyRevenueNet = monthlyRevenueGross - turoFee;
  const purchasePrice = eff.purchase_price ?? estimatePurchasePrice(car, eff.default_purchase_price);
  const costDepreciation = (purchasePrice * (eff.depreciation_pct_annual / 100)) / 12;
  const costInsurance = eff.insurance_monthly;
  const costMaintenance = eff.maintenance_monthly;
  const costCleaning = eff.cleaning_per_trip * eff.trips_per_month_estimate * (utilizationPct / 60);
  const costRegistration = eff.registration_monthly;
  const costTires = eff.tires_monthly;
  const totalCost =
    costInsurance + costMaintenance + costCleaning + costDepreciation + costRegistration + costTires;
  const monthlyProfit = monthlyRevenueNet - totalCost;
  const marginPct = monthlyRevenueGross > 0 ? (monthlyProfit / monthlyRevenueGross) * 100 : 0;
  const paybackMonths = monthlyProfit > 0 ? purchasePrice / monthlyProfit : null;
  return {
    monthlyRevenueGross,
    turoFee,
    monthlyRevenueNet,
    costInsurance,
    costMaintenance,
    costCleaning,
    costDepreciation,
    costRegistration,
    costTires,
    totalCost,
    monthlyProfit,
    marginPct,
    paybackMonths,
    purchasePrice,
    utilizationPct,
    dailyPrice,
  };
}

export function verdict(profit: Profit): { label: string; tone: "excellent" | "good" | "marginal" | "avoid" } {
  if (profit.monthlyProfit <= 0) return { label: "Avoid", tone: "avoid" };
  if (profit.paybackMonths == null) return { label: "Avoid", tone: "avoid" };
  if (profit.paybackMonths < 24 && profit.marginPct > 30) return { label: "Excellent", tone: "excellent" };
  if (profit.paybackMonths < 48 && profit.marginPct > 15) return { label: "Good", tone: "good" };
  return { label: "Marginal", tone: "marginal" };
}

export const fmtUSD = (n: number | null | undefined) =>
  n == null ? "—" : `$${Math.round(n).toLocaleString()}`;

export const fmtPct = (n: number | null | undefined, digits = 0) =>
  n == null ? "—" : `${n.toFixed(digits)}%`;
