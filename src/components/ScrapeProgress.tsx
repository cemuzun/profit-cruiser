import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { ds } from "@/lib/dataSource";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, AlertCircle, Clock } from "lucide-react";

/** Live indicator for in-flight scrape runs. Polls every 5 s while any
 *  run started in the last 15 minutes is still in `running` status. */
export function ScrapeProgress() {
  const qc = useQueryClient();

  const { data: runs } = useQuery({
    queryKey: ["scrape-runs"],
    queryFn: () => ds.runs(),
    refetchOnMount: "always",
    staleTime: 0,
    refetchInterval: (q) => {
      const data = q.state.data as Awaited<ReturnType<typeof ds.runs>> | undefined;
      const hasActive = (data ?? []).some(
        (r) =>
          r.status === "running" &&
          Date.now() - new Date(r.started_at).getTime() < 15 * 60 * 1000,
      );
      // Always poll every 5s — even if no active runs are visible yet, a
      // freshly-clicked "Save & run" needs a moment for the row to appear.
      return hasActive ? 5000 : 5000;
    },
  });

  // Live total car count, also auto-refreshing while runs are active.
  const { data: liveCount } = useQuery({
    queryKey: ["listings-live-count"],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("listings_current")
        .select("vehicle_id", { count: "exact", head: true });
      if (error) throw error;
      return count ?? 0;
    },
    refetchInterval: (q) => {
      const data = (qc.getQueryData(["scrape-runs"]) as Awaited<ReturnType<typeof ds.runs>> | undefined) ?? [];
      const hasActive = data.some(
        (r) =>
          r.status === "running" &&
          Date.now() - new Date(r.started_at).getTime() < 15 * 60 * 1000,
      );
      return hasActive ? 5000 : false;
    },
  });

  // Group most-recent run per city within the active "batch" window.
  const batch = useMemo(() => {
    if (!runs?.length) return null;
    // A batch = all runs whose started_at is within 5 min of the newest.
    const newest = new Date(runs[0].started_at).getTime();
    if (Date.now() - newest > 15 * 60 * 1000) return null; // too old to surface
    const windowMs = 5 * 60 * 1000;
    const inWindow = runs.filter(
      (r) => Math.abs(newest - new Date(r.started_at).getTime()) < windowMs,
    );
    // Keep the most recent row per city
    const byCity = new Map<string, (typeof runs)[number]>();
    for (const r of inWindow) {
      const cur = byCity.get(r.city);
      if (!cur || new Date(cur.started_at) < new Date(r.started_at)) {
        byCity.set(r.city, r);
      }
    }
    const list = [...byCity.values()].sort((a, b) => a.city.localeCompare(b.city));
    const total = list.length;
    const done = list.filter((r) => r.status === "ok").length;
    const failed = list.filter((r) => r.status === "error" || r.status === "timeout").length;
    const running = list.filter((r) => r.status === "running").length;
    const vehiclesSoFar = list.reduce((a, r) => a + (r.vehicles_count ?? 0), 0);
    return { list, total, done, failed, running, vehiclesSoFar };
  }, [runs]);

  // When a run flips to a terminal state, invalidate downstream queries
  // so cards/tables on the page refresh automatically.
  useEffect(() => {
    if (!batch) return;
    if (batch.running === 0) {
      qc.invalidateQueries({ queryKey: ["listings-current"] });
      qc.invalidateQueries({ queryKey: ["price-movers"] });
      qc.invalidateQueries({ queryKey: ["price-history"] });
    }
  }, [batch?.running, batch, qc]);

  if (!batch || batch.running === 0) return null;

  const pct = batch.total ? Math.round(((batch.done + batch.failed) / batch.total) * 100) : 0;

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="font-medium text-sm">
              Scraping {batch.total} {batch.total === 1 ? "city" : "cities"}…
            </span>
            <span className="text-xs text-muted-foreground">
              {batch.done} done · {batch.running} running
              {batch.failed ? ` · ${batch.failed} failed` : ""}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            <span className="font-semibold text-foreground tabular-nums">
              {liveCount ?? "—"}
            </span>{" "}
            cars in DB · auto-updating
          </div>
        </div>

        <Progress value={pct} className="h-2" />

        <div className="flex flex-wrap gap-1.5">
          {batch.list.map((r) => (
            <Badge
              key={r.id}
              variant="outline"
              className={
                r.status === "ok"
                  ? "border-green-500/60 text-green-600 dark:text-green-400"
                  : r.status === "running"
                    ? "border-primary/60 text-primary"
                    : "border-destructive/60 text-destructive"
              }
            >
              {r.status === "ok" && <CheckCircle2 className="h-3 w-3 mr-1" />}
              {r.status === "running" && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              {(r.status === "error" || r.status === "timeout") && <AlertCircle className="h-3 w-3 mr-1" />}
              {r.city}
              {r.vehicles_count != null && r.status === "ok" ? ` · ${r.vehicles_count}` : ""}
            </Badge>
          ))}
        </div>

        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Clock className="h-3 w-3" /> Each city takes ~2-4 minutes. The dashboard refreshes automatically when finished.
        </p>
      </CardContent>
    </Card>
  );
}
