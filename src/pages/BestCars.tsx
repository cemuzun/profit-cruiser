import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ds, type Listing } from "@/lib/dataSource";
import { AppNav } from "@/components/AppNav";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useGlobalCosts } from "@/hooks/useGlobalCosts";
import { computeProfit, fmtUSD, fmtPct, verdict } from "@/lib/profitability";
import { Trophy, Loader2, ExternalLink, CalendarRange, CalendarIcon } from "lucide-react";
import { turoCarUrl, cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { format, addDays, differenceInCalendarDays } from "date-fns";

type Condition =
  | "max_profit"
  | "fast_payback"
  | "best_margin"
  | "best_value_luxury"
  | "budget_workhorse"
  | "ev_only"
  | "top_rated"
  | "high_demand"
  | "cheap_entry";

const CONDITIONS: { value: Condition; label: string; desc: string }[] = [
  { value: "max_profit",        label: "Maximum monthly profit", desc: "Highest estimated $/month after costs." },
  { value: "fast_payback",      label: "Fastest payback",        desc: "Shortest months to recover upfront cost." },
  { value: "best_margin",       label: "Best profit margin",     desc: "Highest profit % of revenue." },
  { value: "best_value_luxury", label: "Best value luxury",      desc: "Premium cars (≥$150/day) with strong profit." },
  { value: "budget_workhorse",  label: "Budget workhorse",       desc: "Cheap to buy, steady daily rate, quick payback." },
  { value: "ev_only",           label: "Best electric",          desc: "EVs ranked by profit." },
  { value: "top_rated",         label: "Top rated & proven",     desc: "Rating ≥ 4.8 with 50+ trips, ranked by profit." },
  { value: "high_demand",       label: "High demand",            desc: "Most completed trips — proven booking volume." },
  { value: "cheap_entry",       label: "Cheapest entry",         desc: "Lowest upfront cost, still profitable." },
];

const ymd = (d: Date) => format(d, "yyyy-MM-dd");

function DateField({ label, value, onChange, min, max }: {
  label: string;
  value: Date;
  onChange: (d: Date) => void;
  min?: Date;
  max?: Date;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" className={cn("w-[170px] justify-start text-left font-normal", !value && "text-muted-foreground")}>
            <CalendarIcon className="mr-2 h-4 w-4 opacity-70" />
            {format(value, "MMM d, yyyy")}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={value}
            onSelect={(d) => d && onChange(d)}
            disabled={(d) => (min && d < min) || (max && d > max) ? true : false}
            initialFocus
            className={cn("p-3 pointer-events-auto")}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

export default function BestCars() {
  const qc = useQueryClient();
  const [condition, setCondition] = useState<Condition>("max_profit");
  const [city, setCity] = useState("all");
  const [limit, setLimit] = useState("20");

  // Default pickup = tomorrow, return = +7 days.
  const today = useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d; }, []);
  const [pickup, setPickup] = useState<Date>(() => addDays(new Date(), 1));
  const [dropoff, setDropoff] = useState<Date>(() => addDays(new Date(), 8));

  // Keep return ≥ pickup+1.
  useEffect(() => {
    if (differenceInCalendarDays(dropoff, pickup) < 1) {
      setDropoff(addDays(pickup, 1));
    }
  }, [pickup, dropoff]);

  const { data: globalCosts } = useGlobalCosts();
  const { data: cityList } = useQuery({ queryKey: ["cities"], queryFn: () => ds.cities() });
  const { data: listings, isLoading } = useQuery({
    queryKey: ["listings-current"],
    queryFn: async () => ds.listings(),
  });

  // Pre-rank from listings only (no calendar yet) — used to pick which vehicle
  // IDs to load calendar windows for. Avoids fetching calendar for thousands.
  const preRanked = useMemo(() => {
    if (!listings || !globalCosts) return [];
    let rows: Listing[] = listings;
    // Only include cars whose city is still in the active cities list — once a
    // city is removed in Settings it should disappear from rankings even if old
    // listings_current rows remain in the DB.
    if (cityList && cityList.length) {
      const activeSlugs = new Set(cityList.map((c) => c.slug));
      rows = rows.filter((l) => activeSlugs.has(l.city));
    }
    if (city !== "all") rows = rows.filter((l) => l.city === city);
    const withProfit = rows
      .map((l) => ({ ...l, profit: computeProfit(l as any, globalCosts) }))
      .filter((r) => r.profit.monthlyProfit > 0);
    withProfit.sort((a, b) => b.profit.monthlyProfit - a.profit.monthlyProfit);
    const n = Math.max(1, Math.min(200, (Number(limit) || 20) * 3));
    return withProfit.slice(0, n);
  }, [listings, globalCosts, city, limit, cityList]);


  const candidateIds = useMemo(() => preRanked.map((r) => r.vehicle_id), [preRanked]);

  // Calendar window aggregation: for each candidate, avg price + utilization%
  // across [pickup, dropoff). Refreshes when window or candidates change.
  const { data: windowStats } = useQuery({
    queryKey: ["best-cars-window", ymd(pickup), ymd(dropoff), candidateIds.join(",")],
    enabled: candidateIds.length > 0,
    queryFn: async () => {
      const start = ymd(pickup);
      const end = ymd(dropoff);
      // Page through 1000-row limit to cover up to ~50 cars × 30 days = 1500 rows.
      const stats = new Map<string, { avgPrice: number | null; bookedPct: number | null; days: number }>();
      const PAGE = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("listing_calendar_days")
          .select("vehicle_id, day, is_available, daily_price, captured_on")
          .in("vehicle_id", candidateIds)
          .gte("day", start)
          .lt("day", end)
          .order("captured_on", { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data?.length) break;
        // Keep only the freshest captured_on per (vehicle, day).
        const seen = new Map<string, Set<string>>();
        const grouped = new Map<string, { prices: number[]; total: number; booked: number }>();
        for (const r of data as any[]) {
          const key = `${r.vehicle_id}|${r.day}`;
          const used = seen.get(r.vehicle_id) ?? new Set<string>();
          if (used.has(r.day)) continue;
          used.add(r.day);
          seen.set(r.vehicle_id, used);
          const g = grouped.get(r.vehicle_id) ?? { prices: [], total: 0, booked: 0 };
          g.total += 1;
          if (r.is_available === false) g.booked += 1;
          const p = Number(r.daily_price);
          if (Number.isFinite(p) && p > 0) g.prices.push(p);
          grouped.set(r.vehicle_id, g);
        }
        for (const [vid, g] of grouped) {
          const prev = stats.get(vid) ?? { avgPrice: null, bookedPct: null, days: 0 };
          // Merge: simple replace per page since we ordered desc and dedup per page.
          // For multi-page accuracy, accumulate.
          const prevDays = prev.days;
          const prevAvg = prev.avgPrice ?? 0;
          const allPrices = [...(prev.avgPrice != null ? Array(prevDays).fill(prevAvg) : []), ...g.prices];
          const avgPrice = allPrices.length
            ? allPrices.reduce((a, b) => a + b, 0) / allPrices.length
            : null;
          const totalDays = prevDays + g.total;
          const prevBooked = Math.round(((prev.bookedPct ?? 0) / 100) * prevDays);
          const booked = prevBooked + g.booked;
          stats.set(vid, {
            avgPrice,
            bookedPct: totalDays ? Math.round((booked / totalDays) * 100) : null,
            days: totalDays,
          });
        }
        if (data.length < PAGE) break;
        from += PAGE;
      }
      return stats;
    },
  });

  const ranked = useMemo(() => {
    if (!preRanked.length || !globalCosts) return [];
    const windowDays = Math.max(1, differenceInCalendarDays(dropoff, pickup));
    // Replace listing avg_daily_price + utilization with calendar-derived values
    // for any car with calendar coverage in the chosen window.
    let withProfit = preRanked.map((r) => {
      const s = windowStats?.get(r.vehicle_id);
      const hasWindow = !!s && s.days > 0;
      const overrideCar: any = {
        ...r,
        avg_daily_price: hasWindow && s!.avgPrice != null ? s!.avgPrice : r.avg_daily_price,
      };
      const overrideCosts: any = hasWindow && s!.bookedPct != null
        ? { ...globalCosts, utilization_pct: s!.bookedPct }
        : globalCosts;
      const profit = computeProfit(overrideCar, overrideCosts);
      return {
        ...r,
        profit,
        windowPrice: hasWindow ? s!.avgPrice : null,
        windowUtil: hasWindow ? s!.bookedPct : null,
        windowDays: hasWindow ? s!.days : 0,
      };
    });

    withProfit = withProfit.filter((r) => r.profit.monthlyProfit > 0);

    switch (condition) {
      case "max_profit":
        withProfit.sort((a, b) => b.profit.monthlyProfit - a.profit.monthlyProfit);
        break;
      case "fast_payback":
        withProfit = withProfit.filter((r) => r.profit.paybackMonths != null);
        withProfit.sort((a, b) => (a.profit.paybackMonths ?? 1e9) - (b.profit.paybackMonths ?? 1e9));
        break;
      case "best_margin":
        withProfit.sort((a, b) => b.profit.marginPct - a.profit.marginPct);
        break;
      case "best_value_luxury":
        withProfit = withProfit.filter((r) => (r.avg_daily_price ?? 0) >= 150);
        withProfit.sort((a, b) => b.profit.monthlyProfit - a.profit.monthlyProfit);
        break;
      case "budget_workhorse":
        withProfit = withProfit.filter((r) => (r.profit.purchasePrice ?? 1e9) <= 25000);
        withProfit.sort((a, b) => (a.profit.paybackMonths ?? 1e9) - (b.profit.paybackMonths ?? 1e9));
        break;
      case "ev_only":
        withProfit = withProfit.filter((r) => (r.fuel_type ?? "").toUpperCase() === "ELECTRIC");
        withProfit.sort((a, b) => b.profit.monthlyProfit - a.profit.monthlyProfit);
        break;
      case "top_rated":
        withProfit = withProfit.filter((r) => (r.rating ?? 0) >= 4.8 && (r.completed_trips ?? 0) >= 50);
        withProfit.sort((a, b) => b.profit.monthlyProfit - a.profit.monthlyProfit);
        break;
      case "high_demand":
        withProfit.sort((a, b) => (b.completed_trips ?? 0) - (a.completed_trips ?? 0));
        break;
      case "cheap_entry":
        withProfit.sort((a, b) => (a.profit.purchasePrice ?? 1e9) - (b.profit.purchasePrice ?? 1e9));
        break;
    }
    const n = Math.max(1, Math.min(100, Number(limit) || 20));
    return withProfit.slice(0, n);
  }, [preRanked, windowStats, globalCosts, condition, limit, pickup, dropoff]);

  const cityOptions = useMemo(
    () => [{ value: "all", label: "All cities" }, ...(cityList ?? []).map((c) => ({ value: c.slug, label: c.name }))],
    [cityList],
  );

  const activeCondition = CONDITIONS.find((c) => c.value === condition)!;

  const [pollUntil, setPollUntil] = useState<number | null>(null);

  // Auto-refresh: while pollUntil is set, refetch calendar window every 20s so
  // the table updates as background scrapes land — no manual reload needed.
  useEffect(() => {
    if (!pollUntil) return;
    const tick = () => {
      qc.invalidateQueries({ queryKey: ["best-cars-window"] });
      qc.invalidateQueries({ queryKey: ["best-cars-ranked"] });
      if (Date.now() > pollUntil) setPollUntil(null);
    };
    const id = setInterval(tick, 20_000);
    return () => clearInterval(id);
  }, [pollUntil, qc]);

  // Realtime: invalidate rankings the moment new calendar rows land or a
  // calendar scrape run flips to success/error. Triggers refresh whether the
  // scrape was kicked off here, by cron, or from another tab.
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["best-cars-window"] });
        qc.invalidateQueries({ queryKey: ["best-cars-ranked"] });
      }, 1500);
    };
    const channel = supabase
      .channel("best-cars-live")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "listing_calendar_days" }, bump)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "calendar_scrape_runs" },
        (payload) => {
          const status = (payload.new as { status?: string } | null)?.status;
          if (status && status !== "running") bump();
        },
      )
      .subscribe();
    return () => {
      if (debounce) clearTimeout(debounce);
      supabase.removeChannel(channel);
    };
  }, [qc]);


  const runCalendarAll = useMutation({
    mutationFn: async () => {
      const ids = ranked.map((r) => r.vehicle_id);
      if (!ids.length) throw new Error("No cars in the current list");
      const start = ymd(pickup);
      const end = ymd(dropoff);
      // Fire calendar scrapes in parallel, scoped to the chosen window.
      const results = await Promise.allSettled(
        ids.map((vehicleId) =>
          supabase.functions.invoke("scrape-calendar", {
            body: { vehicleId, background: true, startDate: start, endDate: end },
          }),
        ),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - ok;
      return { ok, failed, total: ids.length };
    },
    onSuccess: ({ ok, failed, total }) => {
      toast.success(
        `Calendar scrape queued for ${ok}/${total} cars${failed ? ` (${failed} failed to queue)` : ""}. Rankings will refresh automatically.`,
      );
      // Auto-refresh window for ~3 min so results land in the table without a reload.
      setPollUntil(Date.now() + 3 * 60 * 1000);
      qc.invalidateQueries({ queryKey: ["best-cars-window"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to start calendar scrapes"),
  });

  const withWindowCount = ranked.filter((r) => r.windowDays > 0).length;

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <main className="container mx-auto px-4 py-6 space-y-6">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-primary/10 p-2"><Trophy className="h-6 w-6 text-primary" /></div>
          <div>
            <h1 className="text-2xl font-bold">Best Cars</h1>
            <p className="text-sm text-muted-foreground">
              Pick a condition and rental window — rankings use real calendar prices &amp; bookings when available.
            </p>
          </div>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Condition</div>
                <Select value={condition} onValueChange={(v) => setCondition(v as Condition)}>
                  <SelectTrigger className="w-[280px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CONDITIONS.map((c) => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">City</div>
                <Select value={city} onValueChange={setCity}>
                  <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {cityOptions.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <DateField label="Pickup" value={pickup} onChange={setPickup} min={today} />
              <DateField label="Return" value={dropoff} onChange={setDropoff} min={addDays(pickup, 1)} />
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Show top</div>
                <Input
                  value={limit}
                  onChange={(e) => setLimit(e.target.value.replace(/[^\d]/g, ""))}
                  className="w-[90px]"
                  inputMode="numeric"
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-sm text-muted-foreground italic">
                {activeCondition.desc}
                {ranked.length > 0 && (
                  <span className="not-italic ml-2 text-foreground/70">
                    · {withWindowCount}/{ranked.length} have calendar data for {format(pickup, "MMM d")} – {format(dropoff, "MMM d")}
                  </span>
                )}
                {pollUntil && (
                  <span className="not-italic ml-2 text-primary inline-flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" /> auto-refreshing…
                  </span>
                )}
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => runCalendarAll.mutate()}
                disabled={runCalendarAll.isPending || ranked.length === 0}
              >
                {runCalendarAll.isPending
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <CalendarRange className="h-4 w-4" />}
                Run calendar for window ({ranked.length})
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            {isLoading ? (
              <div className="py-12 text-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin inline" />
              </div>
            ) : ranked.length === 0 ? (
              <div className="py-16 text-center text-muted-foreground">
                No cars match this condition yet. Try a different city or scrape more data.
              </div>
            ) : (
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">#</TableHead>
                      <TableHead>Vehicle</TableHead>
                      <TableHead>City</TableHead>
                      <TableHead className="text-right">Window $/day</TableHead>
                      <TableHead className="text-right">Window util%</TableHead>
                      <TableHead className="text-right">Trips</TableHead>
                      <TableHead className="text-right">Rating</TableHead>
                      <TableHead className="text-right">Monthly profit</TableHead>
                      <TableHead className="text-right">Margin</TableHead>
                      <TableHead className="text-right">Payback</TableHead>
                      <TableHead>Verdict</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ranked.map((r, i) => {
                      const v = verdict(r.profit);
                      return (
                        <TableRow key={r.vehicle_id}>
                          <TableCell className="font-mono text-muted-foreground">{i + 1}</TableCell>
                          <TableCell>
                            <Link to={`/car/${r.vehicle_id}`} className="font-medium hover:underline">
                              {r.year} {r.make} {r.model}
                            </Link>
                            {r.trim && <div className="text-xs text-muted-foreground">{r.trim}</div>}
                          </TableCell>
                          <TableCell className="text-muted-foreground">{r.city}</TableCell>
                          <TableCell className="text-right">
                            {r.windowPrice != null ? fmtUSD(r.windowPrice) : (
                              <span className="text-muted-foreground">{fmtUSD(r.avg_daily_price)}<span className="text-[10px] ml-1">listing</span></span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {r.windowUtil != null
                              ? <span className={r.windowUtil >= 50 ? "text-success" : ""}>{r.windowUtil}%</span>
                              : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className="text-right">{r.completed_trips ?? "—"}</TableCell>
                          <TableCell className="text-right">{r.rating?.toFixed(2) ?? "—"}</TableCell>
                          <TableCell className="text-right font-semibold">{fmtUSD(r.profit.monthlyProfit)}</TableCell>
                          <TableCell className="text-right">{fmtPct(r.profit.marginPct)}</TableCell>
                          <TableCell className="text-right">
                            {r.profit.paybackMonths != null ? `${r.profit.paybackMonths.toFixed(1)} mo` : "—"}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                v.tone === "excellent" ? "default" :
                                v.tone === "good" ? "secondary" :
                                v.tone === "marginal" ? "outline" : "destructive"
                              }
                            >
                              {v.label}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Button asChild variant="ghost" size="sm">
                              <a
                                href={turoCarUrl(r.vehicle_id, (r as any).listing_url, {
                                  city: r.location_city ?? r.city,
                                  make: r.make,
                                  model: r.model,
                                  vehicle_type: r.vehicle_type,
                                })}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <ExternalLink className="h-4 w-4" />
                              </a>
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
