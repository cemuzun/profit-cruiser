import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { ds, type PriceAnomaly } from "@/lib/dataSource";
import { ExternalLink, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "@/hooks/use-toast";

function fmtPrice(v: number | null) {
  if (v == null) return "—";
  return `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function fmtDate(s: string) {
  return new Date(s).toLocaleString();
}

export default function Admin() {
  const [rows, setRows] = useState<PriceAnomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(true);
  const [search, setSearch] = useState("");

  async function load() {
    setLoading(true);
    try {
      const data = await ds.priceAnomalies({ onlyUnreviewed, limit: 500 });
      setRows(data);
    } catch (e) {
      toast({ title: "Failed to load anomalies", description: String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyUnreviewed]);

  async function toggleReviewed(a: PriceAnomaly) {
    try {
      await ds.setAnomalyReviewed(a.id, !a.reviewed);
      setRows((rs) =>
        rs
          .map((r) => (r.id === a.id ? { ...r, reviewed: !a.reviewed } : r))
          .filter((r) => (onlyUnreviewed ? !r.reviewed : true)),
      );
    } catch (e) {
      toast({ title: "Update failed", description: String(e), variant: "destructive" });
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.make, r.model, r.city, r.reason, r.vehicle_id]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [rows, search]);

  const stats = useMemo(() => {
    const total = rows.length;
    const byReason = rows.reduce<Record<string, number>>((acc, r) => {
      const key = r.reason.split(" ")[0];
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    return { total, byReason };
  }, [rows]);

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <main className="container mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <ShieldAlert className="h-6 w-6 text-primary" />
              Price Anomaly Review
            </h1>
            <p className="text-sm text-muted-foreground">
              Listings whose scraped daily price was rejected or corrected by the anomaly guards.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Total {onlyUnreviewed ? "unreviewed" : ""}</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{stats.total}</CardContent>
          </Card>
          {Object.entries(stats.byReason).slice(0, 2).map(([k, v]) => (
            <Card key={k}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">{k}</CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-semibold">{v}</CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <CardTitle className="text-base">Anomalies</CardTitle>
            <div className="flex items-center gap-4">
              <Input
                placeholder="Search make / model / city / id…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-64"
              />
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Switch checked={onlyUnreviewed} onCheckedChange={setOnlyUnreviewed} />
                Only unreviewed
              </label>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>
            ) : filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No anomalies 🎉</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Detected</TableHead>
                      <TableHead>Vehicle</TableHead>
                      <TableHead>City</TableHead>
                      <TableHead className="text-right">Attempted</TableHead>
                      <TableHead className="text-right">Previous</TableHead>
                      <TableHead className="text-right">Kept</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Links</TableHead>
                      <TableHead className="text-right">Reviewed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((a) => (
                      <TableRow key={a.id} className={a.reviewed ? "opacity-60" : ""}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {fmtDate(a.detected_at)}
                        </TableCell>
                        <TableCell className="font-medium">
                          {[a.year, a.make, a.model].filter(Boolean).join(" ") || a.vehicle_id}
                          <div className="text-xs text-muted-foreground">{a.vehicle_id}</div>
                        </TableCell>
                        <TableCell>{a.city ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-destructive">
                          {fmtPrice(a.attempted_price)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtPrice(a.previous_price)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtPrice(a.kept_price)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">{a.reason}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Link
                              to={`/car/${a.vehicle_id}`}
                              className="text-xs text-primary hover:underline"
                            >
                              detail
                            </Link>
                            {a.listing_url && (
                              <a
                                href={a.listing_url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
                              >
                                turo <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Switch
                            checked={a.reviewed}
                            onCheckedChange={() => toggleReviewed(a)}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
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
