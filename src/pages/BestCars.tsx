import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ds, type Listing } from "@/lib/dataSource";
import { AppNav } from "@/components/AppNav";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useGlobalCosts } from "@/hooks/useGlobalCosts";
import { computeProfit, fmtUSD, fmtPct, verdict } from "@/lib/profitability";
import { Trophy, Loader2, ExternalLink, CalendarRange } from "lucide-react";
import { turoCarUrl } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

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

export default function BestCars() {
  const [condition, setCondition] = useState<Condition>("max_profit");
  const [city, setCity] = useState("all");
  const [limit, setLimit] = useState("20");

  const { data: globalCosts } = useGlobalCosts();
  const { data: cityList } = useQuery({ queryKey: ["cities"], queryFn: () => ds.cities() });
  const { data: listings, isLoading } = useQuery({
    queryKey: ["listings-current"],
    queryFn: async () => ds.listings(),
  });

  const ranked = useMemo(() => {
    if (!listings || !globalCosts) return [];
    let rows: Listing[] = listings;
    if (city !== "all") rows = rows.filter((l) => l.city === city);

    let withProfit = rows.map((l) => ({ ...l, profit: computeProfit(l as any, globalCosts) }));

    // Always require positive profit for "best" lists (except cheap_entry which we still want positive).
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
  }, [listings, globalCosts, condition, city, limit]);

  const cityOptions = useMemo(
    () => [{ value: "all", label: "All cities" }, ...(cityList ?? []).map((c) => ({ value: c.slug, label: c.name }))],
    [cityList],
  );

  const activeCondition = CONDITIONS.find((c) => c.value === condition)!;

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <main className="container mx-auto px-4 py-6 space-y-6">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-primary/10 p-2"><Trophy className="h-6 w-6 text-primary" /></div>
          <div>
            <h1 className="text-2xl font-bold">Best Cars</h1>
            <p className="text-sm text-muted-foreground">
              Pick a condition and we'll rank the best cars for it across your tracked listings.
            </p>
          </div>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
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
            <p className="text-sm text-muted-foreground italic">{activeCondition.desc}</p>
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
                      <TableHead className="text-right">$/day</TableHead>
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
                          <TableCell className="text-right">{fmtUSD(r.avg_daily_price)}</TableCell>
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
