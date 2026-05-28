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
import { format } from "date-fns";
import { toast } from "sonner";
import { VerdictBadge } from "./Dashboard";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

function PriceTile({ label, value, sub }: { label: string; value: number | null | undefined; sub?: string | null }) {
  return (
    <div className="border border-border rounded-md p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold">{fmtUSD(value)}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}


type HistoryRow = { day: string; ts: number; price?: number; trips?: number; utilization?: number; avg30?: number };

function HistoryTable({ rows }: { rows: HistoryRow[] }) {
  const sorted = useMemo(() => [...rows].sort((a, b) => b.ts - a.ts), [rows]);
  if (!sorted.length) return null;

  const downloadCsv = () => {
    const header = ["Date", "Listing price", "30d cal avg", "Utilization %", "Completed trips"];
    const lines = [header.join(",")];
    for (const r of sorted) {
      lines.push([
        format(new Date(r.ts), "yyyy-MM-dd"),
        r.price ?? "",
        r.avg30 != null ? r.avg30.toFixed(2) : "",
        r.utilization ?? "",
        r.trips ?? "",
      ].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `car-history-${sorted[0]?.ts ?? Date.now()}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold">Daily data — listing price & utilization</h3>
        <Button variant="outline" size="sm" onClick={downloadCsv}>
          <Download className="h-3.5 w-3.5 mr-1" /> CSV
        </Button>
      </div>
      <div className="border border-border rounded-md max-h-80 overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-muted/80 backdrop-blur">
            <TableRow>
              <TableHead className="h-8 px-3 text-xs">Date</TableHead>
              <TableHead className="h-8 px-3 text-xs text-right">Listing $/day</TableHead>
              <TableHead className="h-8 px-3 text-xs text-right">30d cal avg</TableHead>
              <TableHead className="h-8 px-3 text-xs text-right">Util % (last 30d)</TableHead>
              <TableHead className="h-8 px-3 text-xs text-right">Trips</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r) => (
              <TableRow key={r.ts}>
                <TableCell className="py-1.5 px-3 text-xs font-mono">{format(new Date(r.ts), "yyyy-MM-dd")}</TableCell>
                <TableCell className="py-1.5 px-3 text-xs text-right tabular-nums">{r.price != null ? fmtUSD(r.price) : "—"}</TableCell>
                <TableCell className="py-1.5 px-3 text-xs text-right tabular-nums">{r.avg30 != null ? fmtUSD(r.avg30) : "—"}</TableCell>
                <TableCell className="py-1.5 px-3 text-xs text-right tabular-nums">{r.utilization != null ? `${r.utilization}%` : "—"}</TableCell>
                <TableCell className="py-1.5 px-3 text-xs text-right tabular-nums">{r.trips ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}


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
      // Pull ALL snapshots for THIS vehicle directly (server-side filter).
      // The old code fetched every vehicle's history through ds.snapshots()
      // and capped at 1000 rows, which dropped most of the daily trend.
      const { data, error } = await supabase
        .from("listings_snapshots")
        .select("vehicle_id, avg_daily_price, completed_trips, rating, scraped_at")
        .eq("vehicle_id", id!)
        .order("scraped_at", { ascending: true })
        .limit(1000);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!id,
  });

  // Backward-looking utilization: for each capture date, what % of the last 30
  // actual days (ending on that date) were booked? Uses the most recent scrape
  // observation available for each calendar day.
  const { data: utilizationHistory } = useQuery({
    queryKey: ["car-utilization-history", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("listing_calendar_days")
        .select("day, is_available, daily_price, captured_on")
        .eq("vehicle_id", id!)
        .order("captured_on", { ascending: true })
        .limit(10000);
      if (error) throw error;

      const byCapture = new Map<string, { day: string; is_available: boolean | null; daily_price: number | null }[]>();
      for (const r of (data ?? []) as any[]) {
        const arr = byCapture.get(r.captured_on) ?? [];
        arr.push(r);
        byCapture.set(r.captured_on, arr);
      }

      // Index by day → capture → row for backward-looking lookup
      const byDay = new Map<string, Map<string, { is_available: boolean | null; daily_price: number | null }>>();
      for (const r of (data ?? []) as any[]) {
        if (!byDay.has(r.day)) byDay.set(r.day, new Map());
        byDay.get(r.day)!.set(r.captured_on, { is_available: r.is_available, daily_price: r.daily_price });
      }

      const MS_PER_DAY = 86400000;

      return Array.from(byCapture.entries())
        .map(([captured_on, rows]) => {
          // Forward-looking: avg price for next 30 days (for chart avg30 line)
          const fwd = rows
            .filter((r) => r.day >= captured_on)
            .sort((a, b) => a.day.localeCompare(b.day))
            .slice(0, 30);
          const fwdPrices = fwd.map((r) => Number(r.daily_price)).filter((n) => Number.isFinite(n) && n > 0);
          const avgPrice30 = fwdPrices.length ? fwdPrices.reduce((a, b) => a + b, 0) / fwdPrices.length : null;

          // Backward-looking: how many of last 30 actual days were booked?
          const endTs = new Date(captured_on + "T00:00:00").getTime();
          const startTs = endTs - 29 * MS_PER_DAY;
          let booked = 0;
          let observed = 0;
          for (let ts = startTs; ts <= endTs; ts += MS_PER_DAY) {
            const dayStr = new Date(ts).toISOString().slice(0, 10);
            const dayCaptures = byDay.get(dayStr);
            if (!dayCaptures) continue;

            let bestCap: string | null = null;
            let bestRow: { is_available: boolean | null; daily_price: number | null } | null = null;
            for (const [capOn, row] of dayCaptures.entries()) {
              if (capOn <= dayStr && (!bestCap || capOn > bestCap)) {
                bestCap = capOn;
                bestRow = row;
              }
            }
            if (!bestRow) continue;

            observed++;
            if (bestRow.is_available === false) booked++;
          }

          if (observed === 0) return null;
          return {
            captured_on,
            utilization_pct: Math.round((booked / observed) * 100),
            booked_days: booked,
            observed_days: observed,
            avg_price_30d: avgPrice30,
          };
        })
        .filter(Boolean) as { captured_on: string; utilization_pct: number; booked_days: number; observed_days: number; avg_price_30d: number | null }[];
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

  const { data: calendarDays } = useQuery({
    queryKey: ["car-calendar", id],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from("listing_calendar_days")
        .select("day, is_available, daily_price, captured_on")
        .eq("vehicle_id", id!)
        .gte("day", today)
        .order("day", { ascending: true })
        .limit(120);
      if (error) throw error;
      // de-dup by day, keeping the most recent capture
      const byDay = new Map<string, { day: string; is_available: boolean | null; daily_price: number | null; captured_on: string }>();
      for (const r of (data ?? []) as any[]) {
        const existing = byDay.get(r.day);
        if (!existing || r.captured_on > existing.captured_on) byDay.set(r.day, r);
      }
      return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
    },
    enabled: !!id,
  });

  const calendarAverages = useMemo(() => {
    const days = calendarDays ?? [];
    const avg = (n: number) => {
      const slice = days.slice(0, n).map(d => Number(d.daily_price)).filter(v => Number.isFinite(v) && v > 0);
      if (!slice.length) return null;
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    };
    const availability = (n: number) => {
      const slice = days.slice(0, n);
      if (!slice.length) return null;
      const booked = slice.filter(d => d.is_available === false).length;
      return Math.round((booked / slice.length) * 100);
    };
    return {
      d7: avg(7), d14: avg(14), d30: avg(30),
      booked7: availability(7), booked14: availability(14), booked30: availability(30),
      hasData: days.length > 0,
    };
  }, [calendarDays]);

  const triggerCalendar = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.functions.invoke("scrape-calendar", { body: { vehicleId: id } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Calendar scrape started — refresh in ~30s");
      setTimeout(() => qc.invalidateQueries({ queryKey: ["car-calendar", id] }), 30_000);
    },
    onError: (e: Error) => toast.error(e.message ?? "Calendar scrape failed"),
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
      throw new Error("Price lookup is not configured yet.");
    },
    onError: (e: Error) => toast.error(e.message ?? "Price lookup failed"),
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

  // Merge daily price snapshots + utilization captures into one chart series.
  const histMap = new Map<string, { day: string; ts: number; price?: number; trips?: number; utilization?: number; avg30?: number }>();
  for (const h of (history ?? []) as any[]) {
    const d = new Date(h.scraped_at);
    const key = format(d, "yyyy-MM-dd");
    const row = histMap.get(key) ?? { day: format(d, "MMM d"), ts: d.getTime() };
    row.price = Number(h.avg_daily_price) || undefined;
    row.trips = h.completed_trips ?? undefined;
    histMap.set(key, row);
  }
  for (const u of (utilizationHistory ?? [])) {
    const d = new Date(u.captured_on);
    const key = format(d, "yyyy-MM-dd");
    const row = histMap.get(key) ?? { day: format(d, "MMM d"), ts: d.getTime() };
    row.utilization = u.utilization_pct;
    row.avg30 = u.avg_price_30d ?? undefined;
    histMap.set(key, row);
  }
  const chartData = Array.from(histMap.values()).sort((a, b) => a.ts - b.ts);
  const snapshotCount = (history ?? []).length;
  const captureCount = (utilizationHistory ?? []).length;

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
                    href={turoCarUrl(car.vehicle_id, (car as any).listing_url, { city: car.location_city ?? car.city, make: car.make, model: car.model, vehicle_type: car.vehicle_type })}
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
                      href={turoCarUrl(car.vehicle_id, (car as any).listing_url, { city: car.location_city ?? car.city, make: car.make, model: car.model, vehicle_type: car.vehicle_type })}
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
                    <PriceTile
                      label="Next 7 days"
                      value={calendarAverages.d7 ?? (car as any).price_7d_avg}
                      sub={calendarAverages.booked7 != null ? `${calendarAverages.booked7}% booked` : (calendarAverages.d7 != null ? "calendar" : "listing avg")}
                    />
                    <PriceTile
                      label="Next 14 days"
                      value={calendarAverages.d14 ?? (car as any).price_14d_avg}
                      sub={calendarAverages.booked14 != null ? `${calendarAverages.booked14}% booked` : (calendarAverages.d14 != null ? "calendar" : "listing avg")}
                    />
                    <PriceTile
                      label="Next 30 days"
                      value={calendarAverages.d30 ?? (car as any).price_30d_avg}
                      sub={calendarAverages.booked30 != null ? `${calendarAverages.booked30}% booked` : (calendarAverages.d30 != null ? "calendar" : "listing avg")}
                    />
                  </div>
                      <Line yAxisId="util" type="monotone" dataKey="utilization" name="Booked % (last 30d)" stroke="hsl(var(--warning))" strokeWidth={2} dot={false} connectNulls />
                    <Button
                      variant="outline" size="sm"
                      onClick={() => toggleWatch.mutate()}
                    >
                      {inWatchlist ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
                      {inWatchlist ? "In watchlist" : "Save to watchlist"}
                    </Button>
                    <Button
                      variant="outline" size="sm"
                      disabled={triggerCalendar.isPending}
                      onClick={() => triggerCalendar.mutate()}
                      title="Fetch 90-day availability & pricing for this car"
                    >
                      {triggerCalendar.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      {calendarAverages.hasData ? "Refresh calendar" : "Fetch calendar"}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between mt-4 mb-1">
                <h3 className="text-sm font-semibold">Historical price & utilization</h3>
                <p className="text-[11px] text-muted-foreground">
                  {snapshotCount} price snapshot{snapshotCount === 1 ? "" : "s"} · {captureCount} calendar capture{captureCount === 1 ? "" : "s"}
                </p>
              </div>
              <div className="h-56">
                {chartData.length > 1 ? (
                  <ResponsiveContainer>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="day" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                      <YAxis yAxisId="price" stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={(v) => `$${v}`} />
                      <YAxis yAxisId="util" orientation="right" stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={(v) => `${v}%`} domain={[0, 100]} />
                      <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Line yAxisId="price" type="monotone" dataKey="price" name="Listing price" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} connectNulls />
                      <Line yAxisId="price" type="monotone" dataKey="avg30" name="30d cal. avg" stroke="hsl(var(--accent))" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls />
                      <Line yAxisId="util" type="monotone" dataKey="utilization" name="Booked % (last 30d)" stroke="hsl(var(--warning))" strokeWidth={2} dot={false} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-sm text-muted-foreground text-center px-4">
                    <p>Only {snapshotCount} price snapshot and {captureCount} calendar capture so far.</p>
                    <p className="text-xs mt-1">Daily scrapes will fill in the trend — check back tomorrow, or click "Refresh calendar" above to add a capture now.</p>
                  </div>
                )}
              </div>

              <HistoryTable rows={chartData} />
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

          <Card className="lg:col-span-3">
            <CardContent className="pt-4">
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <div>
                  <h2 className="font-semibold">Daily availability & pricing — next 90 days</h2>
                  <p className="text-xs text-muted-foreground">
                    Captured directly from Turo's calendar. Greyed cells are booked/unavailable.
                  </p>
                </div>
                {calendarDays && calendarDays.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {calendarDays.length} days · last captured {format(new Date(calendarDays[0].captured_on), "MMM d")}
                  </p>
                )}
              </div>
              {calendarDays && calendarDays.length > 0 ? (
                <>
                  <div className="h-48 mb-4">
                    <ResponsiveContainer>
                      <LineChart data={calendarDays.map(d => ({
                        day: format(new Date(d.day), "MMM d"),
                        price: d.is_available === false ? null : Number(d.daily_price) || null,
                      }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="day" stroke="hsl(var(--muted-foreground))" fontSize={10} interval={6} />
                        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={(v) => `$${v}`} />
                        <Tooltip
                          contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
                          formatter={(val: any) => (val == null ? "Booked" : `$${Number(val).toFixed(0)}`)}
                        />
                        <Line type="monotone" dataKey="price" name="Daily price" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} connectNulls={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="grid grid-cols-7 sm:grid-cols-10 md:grid-cols-15 gap-1">
                    {calendarDays.map((d) => {
                      const booked = d.is_available === false;
                      const price = Number(d.daily_price);
                      return (
                        <div
                          key={d.day}
                          className={`text-center rounded-sm border px-1 py-1.5 text-[10px] ${
                            booked
                              ? "bg-muted/50 border-border text-muted-foreground"
                              : "bg-card border-primary/30"
                          }`}
                          title={`${d.day}${booked ? " — booked" : Number.isFinite(price) ? ` — $${price.toFixed(0)}` : ""}`}
                        >
                          <div className="font-medium">{format(new Date(d.day), "d")}</div>
                          <div className="text-[9px] text-muted-foreground">{format(new Date(d.day), "MMM")}</div>
                          <div className="text-[10px] mt-0.5">
                            {booked ? "—" : Number.isFinite(price) ? `$${Math.round(price)}` : "—"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="py-12 text-center text-sm text-muted-foreground space-y-3">
                  <p>No calendar data yet for this car.</p>
                  <Button
                    size="sm"
                    onClick={() => triggerCalendar.mutate()}
                    disabled={triggerCalendar.isPending}
                  >
                    {triggerCalendar.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                    Fetch calendar now
                  </Button>
                </div>
              )}
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
