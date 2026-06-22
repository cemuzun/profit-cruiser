import { useEffect, useMemo, useState } from "react";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ds, type ScrapeRun, type CalendarScrapeRun } from "@/lib/dataSource";
import { RefreshCw, ScrollText, AlertTriangle } from "lucide-react";
import { toast } from "@/hooks/use-toast";

const STUCK_MS = 30 * 60 * 1000; // 30 min without finishing => likely stuck

function fmtDate(s: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}

function durationMs(start: string, end: string | null) {
  const e = end ? new Date(end).getTime() : Date.now();
  return e - new Date(start).getTime();
}

function fmtDuration(ms: number) {
  if (ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function isRunning(status: string, finished: string | null) {
  return !finished && !["ok", "error", "failed", "done", "complete"].includes(status.toLowerCase());
}

function isStuck(start: string, status: string, finished: string | null) {
  return isRunning(status, finished) && durationMs(start, finished) > STUCK_MS;
}

function StatusBadge({ status, started, finished }: { status: string; started: string; finished: string | null }) {
  if (isStuck(started, status, finished)) {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertTriangle className="h-3 w-3" /> stuck
      </Badge>
    );
  }
  if (isRunning(status, finished)) {
    return <Badge className="bg-amber-500 text-white hover:bg-amber-500">running</Badge>;
  }
  const s = status.toLowerCase();
  if (s === "error" || s === "failed") return <Badge variant="destructive">{status}</Badge>;
  return <Badge variant="secondary">{status}</Badge>;
}

export default function ScrapeLogs() {
  const [vehicleRuns, setVehicleRuns] = useState<ScrapeRun[]>([]);
  const [calendarRuns, setCalendarRuns] = useState<CalendarScrapeRun[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [v, c] = await Promise.all([ds.scrapeRuns(200), ds.calendarScrapeRuns(200)]);
      setVehicleRuns(v);
      setCalendarRuns(c);
    } catch (e) {
      toast({ title: "Failed to load logs", description: String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000); // auto-refresh so you can watch live
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stuck = useMemo(() => {
    const v = vehicleRuns.filter((r) => isStuck(r.started_at, r.status, r.finished_at)).length;
    const c = calendarRuns.filter((r) => isStuck(r.started_at, r.status, r.finished_at)).length;
    return v + c;
  }, [vehicleRuns, calendarRuns]);

  const running = useMemo(() => {
    const v = vehicleRuns.filter((r) => isRunning(r.status, r.finished_at)).length;
    const c = calendarRuns.filter((r) => isRunning(r.status, r.finished_at)).length;
    return v + c;
  }, [vehicleRuns, calendarRuns]);

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <main className="container mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <ScrollText className="h-6 w-6 text-primary" />
              Scrape Logs
            </h1>
            <p className="text-sm text-muted-foreground">
              Every scrape run with start/finish times and results. Auto-refreshes every 30s so you can
              confirm the system finishes and doesn't run forever.
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
              <CardTitle className="text-sm text-muted-foreground">Total runs shown</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">
              {vehicleRuns.length + calendarRuns.length}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Currently running</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{running}</CardContent>
          </Card>
          <Card className={stuck > 0 ? "border-destructive" : ""}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Possibly stuck (&gt;30m)</CardTitle>
            </CardHeader>
            <CardContent className={`text-2xl font-semibold ${stuck > 0 ? "text-destructive" : ""}`}>
              {stuck}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="pt-6">
            <Tabs defaultValue="vehicle">
              <TabsList>
                <TabsTrigger value="vehicle">Vehicle scrapes ({vehicleRuns.length})</TabsTrigger>
                <TabsTrigger value="calendar">Calendar scrapes ({calendarRuns.length})</TabsTrigger>
              </TabsList>

              <TabsContent value="vehicle" className="mt-4">
                {loading && vehicleRuns.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>
                ) : vehicleRuns.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">No runs yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Status</TableHead>
                          <TableHead>City</TableHead>
                          <TableHead>Started</TableHead>
                          <TableHead>Finished</TableHead>
                          <TableHead className="text-right">Duration</TableHead>
                          <TableHead className="text-right">Vehicles</TableHead>
                          <TableHead className="text-right">Segments</TableHead>
                          <TableHead>Error</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {vehicleRuns.map((r) => (
                          <TableRow key={r.id}>
                            <TableCell>
                              <StatusBadge status={r.status} started={r.started_at} finished={r.finished_at} />
                            </TableCell>
                            <TableCell>{r.city}</TableCell>
                            <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtDate(r.started_at)}</TableCell>
                            <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtDate(r.finished_at)}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmtDuration(durationMs(r.started_at, r.finished_at))}</TableCell>
                            <TableCell className="text-right tabular-nums">{r.vehicles_count ?? "—"}</TableCell>
                            <TableCell className="text-right tabular-nums">{r.segments_run ?? "—"}</TableCell>
                            <TableCell className="text-xs text-destructive max-w-[240px] truncate" title={r.error_message ?? ""}>{r.error_message ?? ""}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="calendar" className="mt-4">
                {loading && calendarRuns.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>
                ) : calendarRuns.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">No runs yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Status</TableHead>
                          <TableHead>City</TableHead>
                          <TableHead>Started</TableHead>
                          <TableHead>Finished</TableHead>
                          <TableHead className="text-right">Duration</TableHead>
                          <TableHead className="text-right">Attempted</TableHead>
                          <TableHead className="text-right">OK</TableHead>
                          <TableHead className="text-right">Failed</TableHead>
                          <TableHead className="text-right">API/HTML</TableHead>
                          <TableHead>Error</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {calendarRuns.map((r) => (
                          <TableRow key={r.id}>
                            <TableCell>
                              <StatusBadge status={r.status} started={r.started_at} finished={r.finished_at} />
                            </TableCell>
                            <TableCell>{r.city}</TableCell>
                            <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtDate(r.started_at)}</TableCell>
                            <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtDate(r.finished_at)}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmtDuration(durationMs(r.started_at, r.finished_at))}</TableCell>
                            <TableCell className="text-right tabular-nums">{r.vehicles_attempted ?? "—"}</TableCell>
                            <TableCell className="text-right tabular-nums text-emerald-600">{r.vehicles_ok ?? "—"}</TableCell>
                            <TableCell className="text-right tabular-nums text-destructive">{r.vehicles_failed ?? "—"}</TableCell>
                            <TableCell className="text-right tabular-nums text-xs">{(r.source_api_count ?? 0)}/{(r.source_html_count ?? 0)}</TableCell>
                            <TableCell className="text-xs text-destructive max-w-[240px] truncate" title={r.error_message ?? ""}>{r.error_message ?? ""}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
