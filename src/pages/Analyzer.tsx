import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AppNav } from "@/components/AppNav";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useGlobalCosts } from "@/hooks/useGlobalCosts";
import { computeProfit, fmtUSD, fmtPct, verdict } from "@/lib/profitability";
import { VerdictBadge } from "./Dashboard";
import { Calculator } from "lucide-react";

export default function Analyzer() {
  const { data: globalCosts } = useGlobalCosts();
  const [make, setMake] = useState("Tesla");
  const [model, setModel] = useState("Model 3");
  const [year, setYear] = useState(2022);
  const [city, setCity] = useState("los-angeles");
  const [purchasePrice, setPurchasePrice] = useState(28000);
  const [utilization, setUtilization] = useState(60);
  const [submitted, setSubmitted] = useState(false);

  const { data: comps } = useQuery({
    queryKey: ["comps", make, model, city, year],
    queryFn: async () => {
      let q = supabase
        .from("listings_current")
        .select("*")
        .eq("city", city)
        .ilike("make", make)
        .ilike("model", `%${model}%`);
      if (year) q = q.gte("year", year - 2).lte("year", year + 2);
      const { data, error } = await q.limit(50);
      if (error) throw error;
      return data ?? [];
    },
    enabled: submitted && !!make && !!model,
  });

  const stats = useMemo(() => {
    if (!comps || comps.length === 0) return null;
    const prices = comps.map((c: any) => Number(c.avg_daily_price) || 0).filter(Boolean).sort((a, b) => a - b);
    if (!prices.length) return null;
    const pick = (p: number) => prices[Math.floor(prices.length * p)];
    return { p25: pick(0.25), p50: pick(0.5), p75: pick(0.75), n: prices.length };
  }, [comps]);

  const profit = useMemo(() => {
    if (!globalCosts || !stats) return null;
    return computeProfit(
      { vehicle_id: "analyzer", make, model, year, avg_daily_price: stats.p50 },
      globalCosts,
      { purchase_price: purchasePrice, utilization_pct: utilization },
    );
  }, [globalCosts, stats, make, model, year, purchasePrice, utilization]);

  const v = profit ? verdict(profit) : null;

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <main className="container mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Calculator className="h-6 w-6" /> Car Analyzer</h1>
          <p className="text-sm text-muted-foreground">Should you buy this car for Turo? Enter details to find out.</p>
        </div>

        <Card>
          <CardContent className="pt-4 grid grid-cols-2 md:grid-cols-6 gap-3">
            <div><Label>Make</Label><Input value={make} onChange={(e) => setMake(e.target.value)} /></div>
            <div><Label>Model</Label><Input value={model} onChange={(e) => setModel(e.target.value)} /></div>
            <div><Label>Year</Label><Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} /></div>
            <div>
              <Label>City</Label>
              <Select value={city} onValueChange={setCity}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="los-angeles">Los Angeles</SelectItem>
                  <SelectItem value="miami">Miami</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>Purchase $</Label><Input type="number" value={purchasePrice} onChange={(e) => setPurchasePrice(Number(e.target.value))} /></div>
            <div><Label>Utilization %</Label><Input type="number" value={utilization} onChange={(e) => setUtilization(Number(e.target.value))} /></div>
            <div className="col-span-2 md:col-span-6">
              <Button onClick={() => setSubmitted(true)}>Analyze</Button>
            </div>
          </CardContent>
        </Card>

        {submitted && (
          <>
            {!stats ? (
              <Card><CardContent className="pt-4 text-sm text-muted-foreground">
                No comparable listings found in our database for {make} {model} in {city}. Try running a scrape on the Dashboard, or adjust the search.
              </CardContent></Card>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <Card className="lg:col-span-2">
                  <CardContent className="pt-4">
                    <h2 className="font-semibold mb-3">Comparable listings ({stats.n})</h2>
                    <div className="grid grid-cols-3 gap-2 mb-3 text-sm">
                      <Stat label="P25 daily" value={fmtUSD(stats.p25)} />
                      <Stat label="Median daily" value={fmtUSD(stats.p50)} />
                      <Stat label="P75 daily" value={fmtUSD(stats.p75)} />
                    </div>
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead>Vehicle</TableHead>
                        <TableHead className="text-right">$/day</TableHead>
                        <TableHead className="text-right">Trips</TableHead>
                        <TableHead className="text-right">Rating</TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {comps!.slice(0, 8).map((c: any) => (
                          <TableRow key={c.vehicle_id}>
                            <TableCell>{c.year} {c.make} {c.model}</TableCell>
                            <TableCell className="text-right">{fmtUSD(c.avg_daily_price)}</TableCell>
                            <TableCell className="text-right">{c.completed_trips ?? 0}</TableCell>
                            <TableCell className="text-right">{c.rating?.toFixed(2) ?? "—"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4">
                    <div className="flex items-center gap-2 mb-2">
                      <h2 className="font-semibold">Verdict</h2>
                      {v && <VerdictBadge tone={v.tone} label={v.label} />}
                    </div>
                    {profit && (
                      <dl className="text-sm space-y-1.5">
                        <Row label="Est. daily price" value={fmtUSD(profit.dailyPrice)} />
                        <Row label="Net revenue/mo" value={fmtUSD(profit.monthlyRevenueNet)} />
                        <Row label="Total costs/mo" value={`-${fmtUSD(profit.totalCost)}`} />
                        <hr className="my-2 border-border" />
                        <Row label="Monthly profit" value={fmtUSD(profit.monthlyProfit)} bold />
                        <Row label="Margin" value={fmtPct(profit.marginPct, 1)} />
                        <Row label="Payback" value={profit.paybackMonths ? `${profit.paybackMonths.toFixed(0)} months` : "—"} />
                        <Row label="ROI yr 1" value={fmtPct((profit.monthlyProfit * 12 / profit.purchasePrice) * 100, 1)} />
                      </dl>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border rounded-md p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}>
      <dt className="text-muted-foreground">{label}</dt><dd>{value}</dd>
    </div>
  );
}
