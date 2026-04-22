import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppNav } from "@/components/AppNav";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useSeasonality } from "@/hooks/useSeasonality";
import {
  computeMonthlyStats, computeWeekdayStats, weekendPremiumPct,
} from "@/lib/seasonality";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine,
} from "recharts";
import { fmtUSD, fmtPct } from "@/lib/profitability";
import { TrendingUp, TrendingDown, Calendar, Database } from "lucide-react";
import { format } from "date-fns";
import { ds } from "@/lib/dataSource";

export default function Seasonality() {
  const [city, setCity] = useState("all");
  const [makeModel, setMakeModel] = useState("");

  const { data: cityList } = useQuery({ queryKey: ["cities"], queryFn: () => ds.cities() });
  const CITY_OPTIONS = useMemo(
    () => [{ value: "all", label: "All cities" }, ...(cityList ?? []).map(c => ({ value: c.slug, label: c.name }))],
    [cityList],
  );

  const [make, model] = useMemo(() => {
    const t = makeModel.trim();
    if (!t) return [null, null];
    const parts = t.split(/\s+/);
    return [parts[0], parts.slice(1).join(" ") || null];
  }, [makeModel]);

  const { data, isLoading } = useSeasonality({ city, make, model });

  const monthly = useMemo(() => (data ? computeMonthlyStats(data.rows) : []), [data]);
  const weekday = useMemo(() => (data ? computeWeekdayStats(data.rows) : []), [data]);

  const peak = useMemo(() => monthly.filter((m) => m.sampleSize > 0).sort((a, b) => b.median - a.median)[0], [monthly]);
  const low = useMemo(() => monthly.filter((m) => m.sampleSize > 0).sort((a, b) => a.median - b.median)[0], [monthly]);
  const wknd = useMemo(() => (weekday.length ? weekendPremiumPct(weekday) : 0), [weekday]);
  const sample = data?.rows.length ?? 0;
  const earliest = useMemo(() => {
    if (!data?.rows.length) return null;
    return data.rows.reduce<string>((min, r) => (!min || r.scraped_at < min ? r.scraped_at : min), "");
  }, [data]);

  const limited = sample < 30;

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <main className="container mx-auto px-4 py-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Seasonality</h1>
          <p className="text-sm text-muted-foreground">
            How daily prices move by month and weekday. Use the multipliers to refine your utilization assumptions.
          </p>
        </div>

        <Card>
          <CardContent className="pt-4 flex flex-wrap items-center gap-2">
            <Select value={city} onValueChange={setCity}>
              <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CITY_OPTIONS.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input
              placeholder="Filter make + model (e.g. Tesla Model 3)"
              value={makeModel}
              onChange={(e) => setMakeModel(e.target.value)}
              className="max-w-xs"
            />
            <div className="ml-auto text-xs text-muted-foreground flex items-center gap-1">
              <Database className="h-3.5 w-3.5" />
              Scope: <span className="font-medium text-foreground">{data?.level ?? "—"}</span>
            </div>
          </CardContent>
        </Card>

        {limited && earliest && (
          <Card className="border-warning/40">
            <CardContent className="pt-4 text-sm text-warning">
              Limited data — only {sample} snapshots since {format(new Date(earliest), "MMM d, yyyy")}.
              Results will improve as daily snapshots accumulate.
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi icon={TrendingUp} label="Peak month" value={peak ? peak.label : "—"} sub={peak ? `${peak.multiplier.toFixed(2)}× · ${fmtUSD(peak.median)}` : undefined} />
          <Kpi icon={TrendingDown} label="Low month" value={low ? low.label : "—"} sub={low ? `${low.multiplier.toFixed(2)}× · ${fmtUSD(low.median)}` : undefined} />
          <Kpi icon={Calendar} label="Weekend premium" value={fmtPct(wknd, 1)} />
          <Kpi icon={Database} label="Snapshots used" value={sample.toLocaleString()} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardContent className="pt-4">
              <div className="text-sm font-medium mb-2">Median daily price by month</div>
              <div className="h-64">
                {monthly.some((m) => m.sampleSize > 0) ? (
                  <ResponsiveContainer>
                    <BarChart data={monthly}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                      <Tooltip
                        contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
                        formatter={(v: any, n: any) => [fmtUSD(Number(v)), n === "median" ? "Median" : n]}
                      />
                      <Bar dataKey="median" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <Empty />
                )}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-sm font-medium mb-2">Median daily price by weekday</div>
              <div className="h-64">
                {weekday.some((w) => w.sampleSize > 0) ? (
                  <ResponsiveContainer>
                    <BarChart data={weekday}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                      <Tooltip
                        contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
                        formatter={(v: any) => fmtUSD(Number(v))}
                      />
                      <Bar dataKey="median" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <Empty />
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardContent className="pt-4">
              <div className="text-sm font-medium mb-2">Monthly multipliers</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Median</TableHead>
                    <TableHead className="text-right">P25–P75</TableHead>
                    <TableHead className="text-right">Multiplier</TableHead>
                    <TableHead className="text-right">n</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {monthly.map((m) => (
                    <TableRow key={m.monthIndex}>
                      <TableCell>{m.label}</TableCell>
                      <TableCell className="text-right">{m.sampleSize ? fmtUSD(m.median) : "—"}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {m.sampleSize ? `${fmtUSD(m.p25)} – ${fmtUSD(m.p75)}` : "—"}
                      </TableCell>
                      <TableCell className={`text-right font-medium ${multClass(m.multiplier, m.sampleSize)}`}>
                        {m.sampleSize ? `${m.multiplier.toFixed(2)}×` : "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{m.sampleSize}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-sm font-medium mb-2">Weekday multipliers</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Day</TableHead>
                    <TableHead className="text-right">Median</TableHead>
                    <TableHead className="text-right">Multiplier</TableHead>
                    <TableHead className="text-right">n</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {weekday.map((w) => (
                    <TableRow key={w.weekdayIndex}>
                      <TableCell>{w.label}</TableCell>
                      <TableCell className="text-right">{w.sampleSize ? fmtUSD(w.median) : "—"}</TableCell>
                      <TableCell className={`text-right font-medium ${multClass(w.multiplier, w.sampleSize)}`}>
                        {w.sampleSize ? `${w.multiplier.toFixed(2)}×` : "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{w.sampleSize}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
        {isLoading && <div className="text-center text-muted-foreground text-sm">Loading…</div>}
      </main>
    </div>
  );
}

function multClass(m: number, n: number): string {
  if (!n) return "text-muted-foreground";
  if (m >= 1.05) return "text-success";
  if (m <= 0.95) return "text-danger";
  return "";
}

function Kpi({ icon: Icon, label, value, sub }: { icon: any; label: string; value: any; sub?: string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="h-3.5 w-3.5" />{label}</div>
        <div className="text-xl font-bold mt-1">{value}</div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function Empty() {
  return <div className="h-full flex items-center justify-center text-sm text-muted-foreground">No data yet</div>;
}
