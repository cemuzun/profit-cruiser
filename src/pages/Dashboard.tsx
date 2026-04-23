import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ds, type Listing } from "@/lib/dataSource";
import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useGlobalCosts } from "@/hooks/useGlobalCosts";
import { computeProfit, fmtUSD, fmtPct, verdict } from "@/lib/profitability";
import { turoCarUrl } from "@/lib/utils";
import { Loader2, ExternalLink, TrendingUp, DollarSign, Car as CarIcon, Trophy } from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, BarChart, Bar, CartesianGrid,
} from "recharts";
import { format } from "date-fns";
import { CitiesManager } from "@/components/CitiesManager";

type SortKey = "vehicle" | "city" | "price" | "p7" | "p14" | "p30" | "trips" | "rating" | "profit" | "margin";
type SortDir = "asc" | "desc";

export default function Dashboard() {
  const [city, setCity] = useState("all");
  const [search, setSearch] = useState("");
  const [fuelType, setFuelType] = useState("all");
  const [cityFilter, setCityFilter] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("profit");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir(k === "vehicle" || k === "city" ? "asc" : "desc"); }
  };

  const { data: globalCosts } = useGlobalCosts();

  const { data: cityList } = useQuery({
    queryKey: ["cities"],
    queryFn: () => ds.cities(),
  });

  const cityOptions = useMemo(
    () => [{ value: "all", label: "All cities" }, ...(cityList ?? []).map(c => ({ value: c.slug, label: c.name }))],
    [cityList],
  );

  const { data: listings, isLoading } = useQuery({
    queryKey: ["listings-current"],
    queryFn: async () => ds.listings(),
  });

  const { data: priceHistory } = useQuery({
    queryKey: ["price-history", city],
    queryFn: async () => {
      const snaps = await ds.snapshots();
      const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const filtered = snaps.filter(s => {
        if (new Date(s.scraped_at).getTime() < since) return false;
        if (city !== "all" && s.city !== city) return false;
        return true;
      });
      const buckets = new Map<string, { sum: number; n: number }>();
      for (const r of filtered) {
        const day = r.scraped_at.slice(0, 10);
        const b = buckets.get(day) ?? { sum: 0, n: 0 };
        b.sum += Number(r.avg_daily_price) || 0;
        b.n += 1;
        buckets.set(day, b);
      }
      return Array.from(buckets.entries()).sort()
        .map(([day, b]) => ({ day, avgPrice: b.n ? b.sum / b.n : 0 }));
    },
  });

  const cityListings = useMemo<Listing[]>(() => {
    if (!listings) return [];
    return city === "all" ? listings : listings.filter(l => l.city === city);
  }, [listings, city]);

  const enriched = useMemo(() => {
    if (!cityListings.length || !globalCosts) return [];
    const filtered = cityListings.filter((l) => {
      if (search) {
        const q = search.toLowerCase();
        const blob = `${l.make ?? ""} ${l.model ?? ""} ${l.year ?? ""}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      if (fuelType !== "all" && (l.fuel_type ?? "").toUpperCase() !== fuelType) return false;
      return true;
    });
    const withProfit = filtered.map((l) => ({
      ...l,
      profit: computeProfit(l as any, globalCosts),
    }));
    withProfit.sort((a, b) => {
      if (sortBy === "profit") return b.profit.monthlyProfit - a.profit.monthlyProfit;
      if (sortBy === "price") return (b.avg_daily_price ?? 0) - (a.avg_daily_price ?? 0);
      if (sortBy === "trips") return (b.completed_trips ?? 0) - (a.completed_trips ?? 0);
      return (b.rating ?? 0) - (a.rating ?? 0);
    });
    return withProfit;
  }, [cityListings, globalCosts, search, fuelType, sortBy]);

  const kpis = useMemo(() => {
    if (!enriched.length) return null;
    const avgPrice = enriched.reduce((a, l) => a + (l.avg_daily_price ?? 0), 0) / enriched.length;
    const avgProfit = enriched.reduce((a, l) => a + l.profit.monthlyProfit, 0) / enriched.length;
    const top = enriched[0];
    return { count: enriched.length, avgPrice, avgProfit, top };
  }, [enriched]);

  const profitByMake = useMemo(() => {
    if (!enriched.length) return [];
    const m = new Map<string, { sum: number; n: number }>();
    for (const l of enriched) {
      const k = l.make ?? "Unknown";
      const b = m.get(k) ?? { sum: 0, n: 0 };
      b.sum += l.profit.monthlyProfit;
      b.n += 1;
      m.set(k, b);
    }
    return Array.from(m.entries())
      .map(([make, b]) => ({ make, avgProfit: Math.round(b.sum / b.n) }))
      .sort((a, b) => b.avgProfit - a.avgProfit)
      .slice(0, 10);
  }, [enriched]);

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <main className="container mx-auto px-4 py-6 space-y-6">
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div>
            <h1 className="text-2xl font-bold">Market Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Most profitable Turo cars across your active markets, ranked by estimated monthly profit. Auto-refreshed daily, or run manually below.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={city} onValueChange={setCity}>
              <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {cityOptions.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <CitiesManager />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi icon={CarIcon} label="Listings tracked" value={kpis?.count ?? 0} />
          <Kpi icon={DollarSign} label="Avg daily price" value={fmtUSD(kpis?.avgPrice)} />
          <Kpi icon={TrendingUp} label="Avg monthly profit" value={fmtUSD(kpis?.avgProfit)} />
          <Kpi
            icon={Trophy}
            label="Top performer"
            value={kpis?.top ? `${kpis.top.make ?? ""} ${kpis.top.model ?? ""}` : "—"}
            sub={kpis?.top ? fmtUSD(kpis.top.profit.monthlyProfit) + "/mo" : undefined}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardContent className="pt-4">
              <div className="text-sm font-medium mb-2">Avg daily price — last 30 days</div>
              <div className="h-56">
                {priceHistory && priceHistory.length > 0 ? (
                  <ResponsiveContainer>
                    <LineChart data={priceHistory}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="day" tickFormatter={(d) => format(new Date(d), "MMM d")} stroke="hsl(var(--muted-foreground))" fontSize={11} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                      <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                      <Line type="monotone" dataKey="avgPrice" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyChart label="No price history yet — waiting for first scrape" />
                )}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-sm font-medium mb-2">Avg monthly profit by make (top 10)</div>
              <div className="h-56">
                {profitByMake.length > 0 ? (
                  <ResponsiveContainer>
                    <BarChart data={profitByMake}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="make" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                      <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                      <Bar dataKey="avgProfit" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyChart label="No data yet" />
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                placeholder="Search make, model, year…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="max-w-xs"
              />
              <Select value={fuelType} onValueChange={setFuelType}>
                <SelectTrigger className="w-[140px]"><SelectValue placeholder="Fuel" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All fuels</SelectItem>
                  <SelectItem value="GAS">Gas</SelectItem>
                  <SelectItem value="HYBRID">Hybrid</SelectItem>
                  <SelectItem value="ELECTRIC">Electric</SelectItem>
                  <SelectItem value="DIESEL">Diesel</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={(v: any) => setSortBy(v)}>
                <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="profit">Sort: Monthly profit</SelectItem>
                  <SelectItem value="price">Sort: Daily price</SelectItem>
                  <SelectItem value="trips">Sort: Trips completed</SelectItem>
                  <SelectItem value="rating">Sort: Rating</SelectItem>
                </SelectContent>
              </Select>
              <div className="ml-auto text-xs text-muted-foreground">
                {enriched.length} cars
              </div>
            </div>

            {isLoading ? (
              <div className="py-12 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin inline" /></div>
            ) : enriched.length === 0 ? (
              <div className="py-16 text-center space-y-3">
                <p className="text-muted-foreground">No listings yet — click <strong>Run all active</strong> above to start your first scrape, or wait for the daily auto-refresh at 09:00 UTC.</p>
              </div>
            ) : (
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Vehicle</TableHead>
                      <TableHead>City</TableHead>
                      <TableHead className="text-right">Now $/day</TableHead>
                      <TableHead className="text-right">7d avg</TableHead>
                      <TableHead className="text-right">14d avg</TableHead>
                      <TableHead className="text-right">30d avg</TableHead>
                      <TableHead className="text-right">Trips</TableHead>
                      <TableHead className="text-right">Rating</TableHead>
                      <TableHead className="text-right">Monthly profit</TableHead>
                      <TableHead className="text-right">Margin</TableHead>
                      <TableHead>Verdict</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {enriched.slice(0, 100).map((l) => {
                      const v = verdict(l.profit);
                      return (
                        <TableRow key={l.vehicle_id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {l.image_url && (
                                <a
                                  href={turoCarUrl(l.vehicle_id)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title="Open on Turo"
                                >
                                  <img src={l.image_url} alt={`${l.year ?? ""} ${l.make ?? ""} ${l.model ?? ""}`.trim()} className="h-8 w-12 object-cover rounded hover:opacity-80 transition" loading="lazy" />
                                </a>
                              )}
                              <div>
                                <a
                                  href={turoCarUrl(l.vehicle_id)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-medium hover:underline"
                                  title="Open on Turo"
                                >
                                  {l.year} {l.make} {l.model}
                                </a>
                                <div className="text-xs text-muted-foreground">{l.vehicle_type ?? "—"} · {l.fuel_type ?? "—"}</div>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs">{l.city}</TableCell>
                          <TableCell className="text-right">{fmtUSD(l.avg_daily_price)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">{fmtUSD(l.price_7d_avg)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">{fmtUSD(l.price_14d_avg)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">{fmtUSD(l.price_30d_avg)}</TableCell>
                          <TableCell className="text-right">{l.completed_trips ?? 0}</TableCell>
                          <TableCell className="text-right">{l.rating?.toFixed(2) ?? "—"}</TableCell>
                          <TableCell className="text-right font-semibold">{fmtUSD(l.profit.monthlyProfit)}</TableCell>
                          <TableCell className="text-right">{fmtPct(l.profit.marginPct)}</TableCell>
                          <TableCell><VerdictBadge tone={v.tone} label={v.label} /></TableCell>
                          <TableCell>
                            <Link to={`/car/${l.vehicle_id}`}>
                              <Button variant="ghost" size="sm"><ExternalLink className="h-3.5 w-3.5" /></Button>
                            </Link>
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

export function VerdictBadge({ tone, label }: { tone: string; label: string }) {
  const map: Record<string, string> = {
    excellent: "bg-success text-success-foreground hover:bg-success/90",
    good: "bg-info text-info-foreground hover:bg-info/90 bg-primary text-primary-foreground",
    marginal: "bg-warning text-warning-foreground hover:bg-warning/90",
    avoid: "bg-danger text-danger-foreground hover:bg-danger/90",
  };
  return <Badge className={map[tone]}>{label}</Badge>;
}

function EmptyChart({ label }: { label: string }) {
  return <div className="h-full flex items-center justify-center text-sm text-muted-foreground">{label}</div>;
}
