import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { ds, userStore } from "@/lib/dataSource";
import { AppNav } from "@/components/AppNav";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useGlobalCosts } from "@/hooks/useGlobalCosts";
import { computeProfit, fmtUSD, fmtPct, verdict } from "@/lib/profitability";
import { turoCarUrl } from "@/lib/utils";
import { VerdictBadge } from "./Dashboard";
import { Trash2, ExternalLink, GitCompare, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const MAX_COMPARE = 4;

export default function Watchlist() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: globalCosts } = useGlobalCosts();
  const [selected, setSelected] = useState<string[]>([]);

  const { data: items } = useQuery({
    queryKey: ["watchlist-full"],
    queryFn: async () => {
      const w = userStore.getWatchlist();
      if (!w.length) return [];
      const all = await ds.listings();
      return w
        .map((entry) => {
          const car = all.find((l) => l.vehicle_id === entry.vehicle_id);
          return car ? { ...car, added_at: entry.added_at } : null;
        })
        .filter(Boolean) as Array<any>;
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => { userStore.removeWatch(id); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watchlist-full"] }),
  });

  const refreshPricing = useMutation({
    mutationFn: async () => {
      throw new Error("Pricing refresh is not configured yet.");
    },
    onError: (e: any) => toast.error(`Refresh failed: ${e.message ?? e}`),
  });

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_COMPARE) return prev;
      return [...prev, id];
    });
  };

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <main className="container mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h1 className="text-2xl font-bold">Watchlist</h1>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => refreshPricing.mutate()}
              disabled={refreshPricing.isPending || !items?.length}
            >
              <RefreshCw className={`h-4 w-4 ${refreshPricing.isPending ? "animate-spin" : ""}`} />
              {refreshPricing.isPending ? "Refreshing…" : "Refresh pricing"}
            </Button>
            {selected.length >= 2 && (
              <Button onClick={() => navigate(`/compare?ids=${selected.join(",")}`)}>
                <GitCompare className="h-4 w-4" /> Compare selected ({selected.length})
              </Button>
            )}
          </div>
        </div>
        {!items || items.length === 0 ? (
          <Card><CardContent className="pt-6 text-center text-muted-foreground">
            No saved cars yet. Open a car from the dashboard and click "Save to watchlist".
          </CardContent></Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((c: any) => {
              const profit = globalCosts ? computeProfit(c, globalCosts) : null;
              const v = profit ? verdict(profit) : null;
              const isSelected = selected.includes(c.vehicle_id);
              const disabled = !isSelected && selected.length >= MAX_COMPARE;
              return (
                <Card key={c.vehicle_id} className={isSelected ? "ring-2 ring-primary" : ""}>
                  <CardContent className="pt-4 space-y-2">
                    <div className="flex items-start gap-2">
                      <Checkbox
                        checked={isSelected}
                        disabled={disabled}
                        onCheckedChange={() => toggle(c.vehicle_id)}
                        aria-label="Select to compare"
                      />
                      <div className="flex-1">
                        {c.image_url && (
                          <a
                            href={turoCarUrl(c.vehicle_id, (c as any).listing_url, { city: c.location_city ?? c.city, make: c.make, model: c.model, vehicle_type: c.vehicle_type })}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open on Turo"
                          >
                            <img src={c.image_url} alt={`${c.year ?? ""} ${c.make ?? ""} ${c.model ?? ""}`.trim()} className="w-full h-32 object-cover rounded-md hover:opacity-80 transition" />
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <a
                        href={turoCarUrl(c.vehicle_id, (c as any).listing_url, { city: c.location_city ?? c.city, make: c.make, model: c.model, vehicle_type: c.vehicle_type })}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold hover:underline"
                        title="Open on Turo"
                      >
                        {c.year} {c.make} {c.model}
                      </a>
                      {v && <VerdictBadge tone={v.tone} label={v.label} />}
                    </div>
                    <div className="text-xs text-muted-foreground">{c.city} · {c.completed_trips ?? 0} trips · {c.rating?.toFixed(2) ?? "—"}★</div>
                    {profit && (
                      <div className="text-sm space-y-0.5">
                        <div className="flex justify-between"><span className="text-muted-foreground">Daily</span><span>{fmtUSD(profit.dailyPrice)}</span></div>
                        <div className="flex justify-between font-semibold"><span>Profit/mo</span><span>{fmtUSD(profit.monthlyProfit)}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Margin</span><span>{fmtPct(profit.marginPct)}</span></div>
                      </div>
                    )}
                    <div className="flex gap-2 pt-1">
                      <Link to={`/car/${c.vehicle_id}`} className="flex-1">
                        <Button variant="outline" size="sm" className="w-full"><ExternalLink className="h-3.5 w-3.5" />Open</Button>
                      </Link>
                      <Button variant="ghost" size="sm" onClick={() => remove.mutate(c.vehicle_id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
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
