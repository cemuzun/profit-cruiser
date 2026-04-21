import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AppNav } from "@/components/AppNav";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useGlobalCosts } from "@/hooks/useGlobalCosts";
import { computeProfit, fmtUSD, fmtPct, verdict, type CostOverride, type AcquisitionMode } from "@/lib/profitability";
import { ArrowLeft, Bookmark, BookmarkCheck, Loader2 } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { format } from "date-fns";
import { toast } from "sonner";
import { VerdictBadge } from "./Dashboard";

export default function CarDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { data: globalCosts } = useGlobalCosts();

  const { data: car } = useQuery({
    queryKey: ["car", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("listings_current").select("*").eq("vehicle_id", id!).maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });

  const { data: history } = useQuery({
    queryKey: ["car-history", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("listings_snapshots")
        .select("scraped_at, avg_daily_price, completed_trips")
        .eq("vehicle_id", id!)
        .order("scraped_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!id,
  });

  const { data: override } = useQuery({
    queryKey: ["override", id],
    queryFn: async () => {
      const { data } = await supabase.from("cost_overrides").select("*").eq("vehicle_id", id!).maybeSingle();
      return data;
    },
    enabled: !!id,
  });

  const { data: inWatchlist } = useQuery({
    queryKey: ["watchlist", id],
    queryFn: async () => {
      const { data } = await supabase.from("watchlist").select("vehicle_id").eq("vehicle_id", id!).maybeSingle();
      return !!data;
    },
    enabled: !!id,
  });

  const [form, setForm] = useState<CostOverride>({});
  useEffect(() => {
    if (override) {
      const o: any = override;
      setForm({
        utilization_pct: o.utilization_pct ?? undefined,
        turo_fee_pct: o.turo_fee_pct ?? undefined,
        insurance_monthly: o.insurance_monthly ?? undefined,
        maintenance_monthly: o.maintenance_monthly ?? undefined,
        cleaning_per_trip: o.cleaning_per_trip ?? undefined,
        depreciation_pct_annual: o.depreciation_pct_annual ?? undefined,
        purchase_price: o.purchase_price ?? undefined,
        acquisition_mode: (o.acquisition_mode ?? undefined) as AcquisitionMode | undefined,
        lease_monthly: o.lease_monthly ?? undefined,
        lease_down: o.lease_down ?? undefined,
        lease_term_months: o.lease_term_months ?? undefined,
        mileage_cap_monthly: o.mileage_cap_monthly ?? undefined,
        mileage_overage_per_mi: o.mileage_overage_per_mi ?? undefined,
        avg_miles_per_trip: o.avg_miles_per_trip ?? undefined,
      });
    }
  }, [override]);

  const profit = useMemo(() => {
    if (!car || !globalCosts) return null;
    return computeProfit(car as any, globalCosts, form);
  }, [car, globalCosts, form]);

  const mode: AcquisitionMode = form.acquisition_mode ?? globalCosts?.default_acquisition_mode ?? "buy";

  const save = useMutation({
    mutationFn: async () => {
      const payload: any = { vehicle_id: id, ...form, updated_at: new Date().toISOString() };
      const { error } = await supabase.from("cost_overrides").upsert(payload, { onConflict: "vehicle_id" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Costs saved");
      qc.invalidateQueries({ queryKey: ["override", id] });
    },
  });

  const toggleWatch = useMutation({
    mutationFn: async () => {
      if (inWatchlist) {
        await supabase.from("watchlist").delete().eq("vehicle_id", id!);
      } else {
        await supabase.from("watchlist").insert({ vehicle_id: id! });
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watchlist", id] }),
  });

  if (!car) {
    return (
      <div className="min-h-screen bg-background">
        <AppNav />
        <div className="container mx-auto px-4 py-12 text-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin inline" />
        </div>
      </div>
    );
  }

  const v = profit ? verdict(profit) : null;
  const chartData = (history ?? []).map((h: any) => ({
    day: format(new Date(h.scraped_at), "MMM d"),
    price: Number(h.avg_daily_price) || 0,
    trips: h.completed_trips ?? 0,
  }));

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <main className="container mx-auto px-4 py-6 space-y-4">
        <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to dashboard
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-start gap-4">
                {car.image_url && (
                  <img src={car.image_url} alt="" className="h-32 w-48 object-cover rounded-md" />
                )}
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h1 className="text-2xl font-bold">{car.year} {car.make} {car.model}</h1>
                    {v && <VerdictBadge tone={v.tone} label={v.label} />}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {car.vehicle_type ?? "—"} · {car.fuel_type ?? "—"} · {car.location_city ?? car.city}
                  </p>
                  <p className="text-sm mt-1">
                    {car.completed_trips ?? 0} trips · {car.rating?.toFixed(2) ?? "—"}★
                    {car.is_all_star_host && <span className="ml-2 text-warning">All-Star host</span>}
                  </p>
                  <Button
                    variant="outline" size="sm" className="mt-3"
                    onClick={() => toggleWatch.mutate()}
                  >
                    {inWatchlist ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
                    {inWatchlist ? "In watchlist" : "Save to watchlist"}
                  </Button>
                </div>
              </div>

              <div className="h-56 mt-4">
                {chartData.length > 1 ? (
                  <ResponsiveContainer>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="day" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                      <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                      <Line type="monotone" dataKey="price" name="Daily price" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                    Need 2+ snapshots to show trend
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4">
              <h2 className="font-semibold mb-3">Profitability</h2>
              {profit && (
                <dl className="text-sm space-y-1.5">
                  <Row label="Mode" value={profit.acquisitionMode === "lease" ? "Lease" : "Buy"} />
                  <Row label="Daily price" value={fmtUSD(profit.dailyPrice)} />
                  <Row label="Utilization" value={fmtPct(profit.utilizationPct)} />
                  <Row label="Gross revenue/mo" value={fmtUSD(profit.monthlyRevenueGross)} />
                  <Row label="Turo fee" value={`-${fmtUSD(profit.turoFee)}`} />
                  <Row label="Net revenue/mo" value={fmtUSD(profit.monthlyRevenueNet)} bold />
                  <hr className="my-2 border-border" />
                  <Row label="Insurance" value={`-${fmtUSD(profit.costInsurance)}`} />
                  <Row label="Maintenance" value={`-${fmtUSD(profit.costMaintenance)}`} />
                  <Row label="Cleaning" value={`-${fmtUSD(profit.costCleaning)}`} />
                  {profit.acquisitionMode === "buy" ? (
                    <Row label="Depreciation" value={`-${fmtUSD(profit.costDepreciation)}`} />
                  ) : (
                    <Row label="Lease (incl. down/mo)" value={`-${fmtUSD(profit.costLease)}`} />
                  )}
                  <Row label="Registration" value={`-${fmtUSD(profit.costRegistration)}`} />
                  <Row label="Tires" value={`-${fmtUSD(profit.costTires)}`} />
                  <Row
                    label={`Mileage overage (~${Math.round(profit.estimatedMilesPerMonth)} mi/mo)`}
                    value={profit.costMileageOverage > 0 ? `-${fmtUSD(profit.costMileageOverage)}` : "$0"}
                  />
                  <Row label="Total costs" value={`-${fmtUSD(profit.totalCost)}`} bold />
                  <hr className="my-2 border-border" />
                  <Row label="Monthly profit" value={fmtUSD(profit.monthlyProfit)} bold />
                  <Row label="Margin" value={fmtPct(profit.marginPct, 1)} />
                  <Row
                    label={profit.acquisitionMode === "lease" ? "Down payback" : "Payback"}
                    value={profit.paybackMonths ? `${profit.paybackMonths.toFixed(0)} mo` : "—"}
                  />
                  <Row
                    label={profit.acquisitionMode === "lease" ? "Lease down" : "Purchase price"}
                    value={fmtUSD(profit.upfrontCost)}
                  />
                </dl>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <h2 className="font-semibold">Edit cost assumptions for this car</h2>
              <Tabs
                value={mode}
                onValueChange={(v) => setForm({ ...form, acquisition_mode: v as AcquisitionMode })}
              >
                <TabsList>
                  <TabsTrigger value="buy">Buy</TabsTrigger>
                  <TabsTrigger value="lease">Lease</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {mode === "buy" ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Field label="Purchase price" value={form.purchase_price} onChange={(v) => setForm({ ...form, purchase_price: v })} />
                <Field label="Depreciation %/yr" value={form.depreciation_pct_annual} onChange={(v) => setForm({ ...form, depreciation_pct_annual: v })} />
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Field label="Lease $/mo" value={form.lease_monthly} onChange={(v) => setForm({ ...form, lease_monthly: v })} />
                <Field label="Down payment $" value={form.lease_down} onChange={(v) => setForm({ ...form, lease_down: v })} />
                <Field label="Term (months)" value={form.lease_term_months} onChange={(v) => setForm({ ...form, lease_term_months: v })} />
              </div>
            )}

            <div>
              <h3 className="text-sm font-medium mb-2 text-muted-foreground">Mileage</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Field label="Mileage cap / mo" value={form.mileage_cap_monthly} onChange={(v) => setForm({ ...form, mileage_cap_monthly: v })} />
                <Field label="Overage $/mile" value={form.mileage_overage_per_mi} onChange={(v) => setForm({ ...form, mileage_overage_per_mi: v })} step="0.01" />
                <Field label="Avg miles per trip" value={form.avg_miles_per_trip} onChange={(v) => setForm({ ...form, avg_miles_per_trip: v })} />
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Estimated miles/mo = trips/mo × avg miles per trip. Overage applies in both buy and lease modes (lease has hard caps; for buys this proxies extra wear).
              </p>
            </div>

            <div>
              <h3 className="text-sm font-medium mb-2 text-muted-foreground">Operating costs</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Field label="Utilization %" value={form.utilization_pct} onChange={(v) => setForm({ ...form, utilization_pct: v })} />
                <Field label="Turo fee %" value={form.turo_fee_pct} onChange={(v) => setForm({ ...form, turo_fee_pct: v })} />
                <Field label="Insurance/mo" value={form.insurance_monthly} onChange={(v) => setForm({ ...form, insurance_monthly: v })} />
                <Field label="Maintenance/mo" value={form.maintenance_monthly} onChange={(v) => setForm({ ...form, maintenance_monthly: v })} />
                <Field label="Cleaning/trip" value={form.cleaning_per_trip} onChange={(v) => setForm({ ...form, cleaning_per_trip: v })} />
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={() => save.mutate()} disabled={save.isPending}>Save overrides</Button>
              <Button variant="ghost" onClick={() => setForm({})}>Reset to global</Button>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Field({
  label, value, onChange, step,
}: { label: string; value: number | undefined | null; onChange: (v: number | undefined) => void; step?: string }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        step={step}
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? undefined : Number(v));
        }}
        placeholder="(global)"
      />
    </div>
  );
}
