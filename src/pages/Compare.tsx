import { useMemo, useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AppNav } from "@/components/AppNav";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useGlobalCosts } from "@/hooks/useGlobalCosts";
import { computeProfit, fmtUSD, fmtPct, verdict } from "@/lib/profitability";
import { VerdictBadge } from "./Dashboard";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, Tooltip, XAxis, YAxis,
} from "recharts";
import { Trophy, Bookmark, X } from "lucide-react";
import { format } from "date-fns";

const MAX_COMPARE = 4;

export default function Compare() {
  const [params, setParams] = useSearchParams();
  const idsParam = params.get("ids") ?? "";
  const [selected, setSelected] = useState<string[]>(idsParam ? idsParam.split(",").filter(Boolean) : []);

  useEffect(() => {
    if (selected.length) setParams({ ids: selected.join(",") }, { replace: true });
    else setParams({}, { replace: true });
  }, [selected, setParams]);

  const { data: globalCosts } = useGlobalCosts();

  const { data: watchlistCars } = useQuery({
    queryKey: ["watchlist-compare-pool"],
    queryFn: async () => {
      const { data: w } = await supabase.from("watchlist").select("vehicle_id, added_at").order("added_at", { ascending: false });
      if (!w?.length) return [];
      const ids = w.map((x) => x.vehicle_id);
      const { data: cars } = await supabase.from("listings_current").select("*").in("vehicle_id", ids);
      return cars ?? [];
    },
  });

  // Default-select first 3 if nothing chosen
  useEffect(() => {
    if (!selected.length && watchlistCars && watchlistCars.length >= 2) {
      setSelected(watchlistCars.slice(0, Math.min(3, watchlistCars.length)).map((c: any) => c.vehicle_id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlistCars]);

  const cars = useMemo(
    () => (watchlistCars ?? []).filter((c: any) => selected.includes(c.vehicle_id)).slice(0, MAX_COMPARE),
    [watchlistCars, selected],
  );

  const { data: snaps } = useQuery({
    queryKey: ["compare-snapshots", selected.join(",")],
    enabled: selected.length > 0,
    queryFn: async () => {
      const since = new Date();
      since.setDate(since.getDate() - 30);
      const { data, error } = await supabase
        .from("listings_snapshots")
        .select("vehicle_id, scraped_at, avg_daily_price")
        .in("vehicle_id", selected)
        .gte("scraped_at", since.toISOString())
        .order("scraped_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const enriched = useMemo(() => {
    if (!globalCosts) return [];
    return cars.map((c: any) => {
      const profit = computeProfit(c, globalCosts);
      const v = verdict(profit);
      const sparkline = (snaps ?? [])
        .filter((s: any) => s.vehicle_id === c.vehicle_id)
        .map((s: any) => ({ day: s.scraped_at, price: Number(s.avg_daily_price) || 0 }));
      const breakdown = [
        { name: "Insur", v: profit.costInsurance },
        { name: "Maint", v: profit.costMaintenance },
        { name: "Clean", v: profit.costCleaning },
        { name: "Depr", v: profit.costDepreciation },
        { name: "Reg", v: profit.costRegistration },
        { name: "Tires", v: profit.costTires },
      ];
      return { car: c, profit, v, sparkline, breakdown };
    });
  }, [cars, globalCosts, snaps]);

  const winner = useMemo(() => {
    if (enriched.length < 2) return null;
    return [...enriched].sort((a, b) => b.profit.monthlyProfit - a.profit.monthlyProfit)[0];
  }, [enriched]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_COMPARE) return prev;
      return [...prev, id];
    });
  };

  if (watchlistCars && watchlistCars.length < 2) {
    return (
      <div className="min-h-screen bg-background">
        <AppNav />
        <main className="container mx-auto px-4 py-6 space-y-4">
          <h1 className="text-2xl font-bold">Compare cars</h1>
          <Card>
            <CardContent className="pt-6 text-center space-y-3">
              <Bookmark className="h-8 w-8 mx-auto text-muted-foreground" />
              <p className="text-muted-foreground">Add at least 2 cars to your watchlist to compare them.</p>
              <Link to="/"><Button variant="outline">Browse dashboard</Button></Link>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <main className="container mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold">Compare cars</h1>
          <p className="text-sm text-muted-foreground">Pick 2–{MAX_COMPARE} watchlist cars to evaluate side-by-side.</p>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Watchlist ({selected.length}/{MAX_COMPARE} selected)</div>
            <div className="flex flex-wrap gap-2">
              {(watchlistCars ?? []).map((c: any) => {
                const on = selected.includes(c.vehicle_id);
                const disabled = !on && selected.length >= MAX_COMPARE;
                return (
                  <button
                    key={c.vehicle_id}
                    onClick={() => toggle(c.vehicle_id)}
                    disabled={disabled}
                    className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                      on
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background hover:bg-secondary border-border text-muted-foreground hover:text-foreground"
                    } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
                  >
                    {c.year} {c.make} {c.model}
                    {on && <X className="inline h-3 w-3 ml-1" />}
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {winner && (
          <Card className="border-success/40 bg-success/5">
            <CardContent className="pt-4 flex items-center gap-3">
              <Trophy className="h-5 w-5 text-success" />
              <div className="text-sm">
                <span className="text-muted-foreground">Highest monthly profit:</span>{" "}
                <span className="font-semibold">{winner.car.year} {winner.car.make} {winner.car.model}</span>{" "}
                <span className="text-success font-semibold">{fmtUSD(winner.profit.monthlyProfit)}/mo</span>
                {winner.profit.paybackMonths != null && (
                  <span className="text-muted-foreground"> · payback in ~{Math.round(winner.profit.paybackMonths)} mo</span>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {enriched.length === 0 ? (
          <Card><CardContent className="pt-6 text-center text-muted-foreground">Select cars above to compare.</CardContent></Card>
        ) : (
          <div className={`grid gap-4 grid-cols-1 ${gridCols(enriched.length)}`}>
            {enriched.map(({ car, profit, v, sparkline, breakdown }) => {
              const isWinner = winner && winner.car.vehicle_id === car.vehicle_id;
              return (
                <Card key={car.vehicle_id} className={isWinner ? "ring-2 ring-success/60" : ""}>
                  <CardContent className="pt-4 space-y-3">
                    {car.image_url && (
                      <img src={car.image_url} alt="" className="w-full h-32 object-cover rounded-md" loading="lazy" />
                    )}
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold">{car.year} {car.make} {car.model}</div>
                        <div className="text-xs text-muted-foreground">{car.city}</div>
                      </div>
                      <VerdictBadge tone={v.tone} label={v.label} />
                    </div>

                    <dl className="text-sm space-y-1">
                      <Row label="Daily price" value={fmtUSD(profit.dailyPrice)} />
                      <Row label="Utilization" value={fmtPct(profit.utilizationPct)} />
                      <Row label="Gross rev/mo" value={fmtUSD(profit.monthlyRevenueGross)} />
                      <Row label="Turo fee" value={`-${fmtUSD(profit.turoFee)}`} />
                      <Row label="Total costs" value={`-${fmtUSD(profit.totalCost)}`} />
                      <hr className="my-1 border-border" />
                      <Row
                        label="Monthly profit"
                        value={fmtUSD(profit.monthlyProfit)}
                        bold
                        tone={profit.monthlyProfit > 0 ? "success" : "danger"}
                      />
                      <Row label="Margin" value={fmtPct(profit.marginPct, 1)} />
                      <Row label="Payback" value={profit.paybackMonths ? `${Math.round(profit.paybackMonths)} mo` : "—"} />
                      <Row label="Purchase price" value={fmtUSD(profit.purchasePrice)} />
                    </dl>

                    <div>
                      <div className="text-xs text-muted-foreground mb-1">Price trend (30d)</div>
                      <div className="h-16">
                        {sparkline.length > 1 ? (
                          <ResponsiveContainer>
                            <LineChart data={sparkline}>
                              <Tooltip
                                contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 11 }}
                                labelFormatter={(d) => format(new Date(d), "MMM d")}
                                formatter={(v: any) => fmtUSD(Number(v))}
                              />
                              <Line type="monotone" dataKey="price" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                            </LineChart>
                          </ResponsiveContainer>
                        ) : (
                          <div className="h-full flex items-center text-xs text-muted-foreground">Need 2+ snapshots</div>
                        )}
                      </div>
                    </div>

                    <div>
                      <div className="text-xs text-muted-foreground mb-1">Cost breakdown</div>
                      <div className="h-20">
                        <ResponsiveContainer>
                          <BarChart data={breakdown}>
                            <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={9} interval={0} />
                            <Tooltip
                              contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 11 }}
                              formatter={(v: any) => fmtUSD(Number(v))}
                            />
                            <Bar dataKey="v" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    <Link to={`/car/${car.vehicle_id}`}>
                      <Button variant="outline" size="sm" className="w-full">Open detail</Button>
                    </Link>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function gridCols(n: number): string {
  if (n >= 4) return "md:grid-cols-2 lg:grid-cols-4";
  if (n === 3) return "md:grid-cols-3";
  return "md:grid-cols-2";
}

function Row({ label, value, bold, tone }: { label: string; value: string; bold?: boolean; tone?: "success" | "danger" }) {
  const toneClass = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "";
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""} ${toneClass}`}>
      <dt className={tone ? "" : "text-muted-foreground"}>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
