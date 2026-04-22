import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useMemo } from "react";
import { ds, userStore } from "@/lib/dataSource";
import { AppNav } from "@/components/AppNav";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useGlobalCosts } from "@/hooks/useGlobalCosts";
import { computeProfit, fmtUSD, fmtPct, verdict, type CostOverride, type AcquisitionMode } from "@/lib/profitability";
import { turoCarUrl } from "@/lib/utils";
import { ArrowLeft, Bookmark, BookmarkCheck, Loader2, ExternalLink, Download } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";

function PriceTile({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="border border-border rounded-md p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold">{fmtUSD(value)}</div>
    </div>
  );
}
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
      const list = await ds.listings();
      return list.find((l) => l.vehicle_id === id) ?? null;
    },
    enabled: !!id,
  });

  const { data: history } = useQuery({
    queryKey: ["car-history", id],
    queryFn: async () => {
      const snaps = await ds.snapshots();
      return snaps
        .filter((s) => s.vehicle_id === id)
        .sort((a, b) => a.scraped_at.localeCompare(b.scraped_at));
    },
    enabled: !!id,
  });

  const { data: forecasts } = useQuery({
    queryKey: ["car-forecasts", id],
    queryFn: async () => {
      const all = await ds.forecasts();
      return all
        .filter((f) => f.vehicle_id === id)
        .sort((a, b) => a.scraped_at.localeCompare(b.scraped_at));
    },
    enabled: !!id,
  });

  const { data: override } = useQuery({
    queryKey: ["override", id],
    queryFn: async () => userStore.getOverride(id!),
    enabled: !!id,
  });

  const { data: inWatchlist } = useQuery({
    queryKey: ["watchlist", id],
    queryFn: async () => userStore.isWatched(id!),
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
        avg_miles_per_day: o.avg_miles_per_day ?? undefined,
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
      userStore.setOverride(id!, form as any);
    },
    onSuccess: () => {
      toast.success("Costs saved (browser-local)");
      qc.invalidateQueries({ queryKey: ["override", id] });
    },
  });

  const toggleWatch = useMutation({
    mutationFn: async () => {
      if (inWatchlist) userStore.removeWatch(id!);
      else userStore.addWatch(id!);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["watchlist", id] });
      qc.invalidateQueries({ queryKey: ["watchlist-full"] });
      qc.invalidateQueries({ queryKey: ["watchlist-compare-pool"] });
    },
  });

  const fetchCarGurus = useMutation({
    mutationFn: async () => {
      if (!car?.make || !car?.model) throw new Error("Vehicle missing make/model");
      const { data, error } = await supabase.functions.invoke("cargurus-price", {
        body: { year: car.year, make: car.make, model: car.model, trim: car.trim },
      });
      if (error) throw new Error(error.message);
      if (!data || data.error) throw new Error(data?.error ?? "No price returned");
      return data as { avg_price: number | null; min_price: number | null; max_price: number | null; sample_size: number | null; source_url: string };
    },
    onSuccess: (data) => {
      const price = data.avg_price ?? data.min_price ?? data.max_price;
      if (price == null) {
        toast.error("CarGurus returned no usable price");
        return;
      }
      setForm((f) => ({ ...f, purchase_price: Math.round(Number(price)) }));
      toast.success(
        `Filled $${Math.round(Number(price)).toLocaleString()} from CarGurus${data.sample_size ? ` (${data.sample_size} listings)` : ""}`,
      );
    },
    onError: (e: Error) => toast.error(e.message ?? "CarGurus fetch failed"),
  });

  const forecastChartData = useMemo(() => {
    const buckets = new Map<string, { day: string; ts: number; "7d"?: number; "14d"?: number; "30d"?: number }>();
    for (const f of (forecasts ?? []) as any[]) {
      const d = new Date(f.scraped_at);
      const key = format(d, "yyyy-MM-dd");
      const existing = buckets.get(key) ?? { day: format(d, "MMM d"), ts: d.getTime() };
      const label = f.window_label as "7d" | "14d" | "30d";
      const price = Number(f.avg_price);
      if (Number.isFinite(price)) (existing as any)[label] = price;
      buckets.set(key, existing);
    }
    return Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
  }, [forecasts]);

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
                  <a
                    href={turoCarUrl(car.vehicle_id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open on Turo"
                  >
                    <img src={car.image_url} alt={`${car.year ?? ""} ${car.make ?? ""} ${car.model ?? ""}`.trim()} className="h-32 w-48 object-cover rounded-md hover:opacity-80 transition" />
                  </a>
                )}
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <a
                      href={turoCarUrl(car.vehicle_id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-2xl font-bold hover:underline inline-flex items-center gap-1.5"
                      title="Open on Turo"
                    >
                      {car.year} {car.make} {car.model}
                      <ExternalLink className="h-4 w-4 opacity-60" />
                    </a>
                    {v && <VerdictBadge tone={v.tone} label={v.label} />}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {car.vehicle_type ?? "—"} · {car.fuel_type ?? "—"} · {car.location_city ?? car.city}
                  </p>
                  <p className="text-sm mt-1">
                    {car.completed_trips ?? 0} trips · {car.rating?.toFixed(2) ?? "—"}★
                    {car.is_all_star_host && <span className="ml-2 text-warning">All-Star host</span>}
                  </p>
                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <PriceTile label="Now" value={car.avg_daily_price} />
                    <PriceTile label="Next 7 days" value={(car as any).price_7d_avg} />
                    <PriceTile label="Next 14 days" value={(car as any).price_14d_avg} />
                    <PriceTile label="Next 30 days" value={(car as any).price_30d_avg} />
                  </div>
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

          <Card className="lg:col-span-3">
            <CardContent className="pt-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-semibold">Forward price trends</h2>
                <p className="text-xs text-muted-foreground">
                  How 7d / 14d / 30d forecast averages have moved across each scrape
                </p>
              </div>
              <div className="h-64">
                {forecastChartData.length > 1 ? (
                  <ResponsiveContainer>
                    <LineChart data={forecastChartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="day" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={(v) => `$${v}`} />
                      <Tooltip
                        contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
                        formatter={(val: any) => (val == null ? "—" : `$${Number(val).toFixed(0)}`)}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Line type="monotone" dataKey="7d" name="Next 7d avg" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} connectNulls />
                      <Line type="monotone" dataKey="14d" name="Next 14d avg" stroke="hsl(var(--accent-foreground))" strokeWidth={2} dot={false} connectNulls />
                      <Line type="monotone" dataKey="30d" name="Next 30d avg" stroke="hsl(var(--muted-foreground))" strokeWidth={2} strokeDasharray="4 4" dot={false} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                    Need 2+ refreshes to show forward trend
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
                <div className="col-span-2">
                  <Label className="text-xs">Purchase price</Label>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      value={form.purchase_price ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        setForm({ ...form, purchase_price: v === "" ? undefined : Number(v) });
                      }}
                      placeholder="(global)"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="default"
                      disabled={fetchCarGurus.isPending || !car.make || !car.model}
                      onClick={() => fetchCarGurus.mutate()}
                      title="Fetch average asking price from CarGurus"
                    >
                      {fetchCarGurus.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      CarGurus
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Pulls the typical asking price for {car.year} {car.make} {car.model}{car.trim ? ` ${car.trim}` : ""} from cargurus.com.
                  </p>
                </div>
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
                <Field label="Avg miles per day" value={form.avg_miles_per_day} onChange={(v) => setForm({ ...form, avg_miles_per_day: v })} />
              </div>
              {form.avg_miles_per_day != null && Number(form.avg_miles_per_day) > 0 && form.avg_miles_per_trip != null && Number(form.avg_miles_per_trip) > 0 && (
                <div className="mt-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                  Both <strong className="text-foreground">Avg miles per day</strong> and <strong className="text-foreground">Avg miles per trip</strong> are set. <strong className="text-foreground">Per day takes precedence</strong> — per trip is ignored until you clear the per-day field.
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-2">
                If <em>avg miles per day</em> is set, miles/mo = 30 × utilization% × miles/day. Otherwise miles/mo = trips/mo × miles/trip. Overage applies in both buy and lease modes.
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
