import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { AppNav } from "@/components/AppNav";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useGlobalCosts } from "@/hooks/useGlobalCosts";
import { computeProfit, fmtUSD, fmtPct, verdict } from "@/lib/profitability";
import { VerdictBadge } from "./Dashboard";
import { Trash2, ExternalLink } from "lucide-react";

export default function Watchlist() {
  const qc = useQueryClient();
  const { data: globalCosts } = useGlobalCosts();

  const { data: items } = useQuery({
    queryKey: ["watchlist-full"],
    queryFn: async () => {
      const { data: w } = await supabase.from("watchlist").select("vehicle_id, added_at").order("added_at", { ascending: false });
      if (!w?.length) return [];
      const ids = w.map((x) => x.vehicle_id);
      const { data: cars } = await supabase.from("listings_current").select("*").in("vehicle_id", ids);
      return (cars ?? []).map((c: any) => ({ ...c, added_at: w.find((x) => x.vehicle_id === c.vehicle_id)?.added_at }));
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await supabase.from("watchlist").delete().eq("vehicle_id", id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watchlist-full"] }),
  });

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <main className="container mx-auto px-4 py-6 space-y-4">
        <h1 className="text-2xl font-bold">Watchlist</h1>
        {!items || items.length === 0 ? (
          <Card><CardContent className="pt-6 text-center text-muted-foreground">
            No saved cars yet. Open a car from the dashboard and click "Save to watchlist".
          </CardContent></Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((c: any) => {
              const profit = globalCosts ? computeProfit(c, globalCosts) : null;
              const v = profit ? verdict(profit) : null;
              return (
                <Card key={c.vehicle_id}>
                  <CardContent className="pt-4 space-y-2">
                    {c.image_url && <img src={c.image_url} alt="" className="w-full h-32 object-cover rounded-md" />}
                    <div className="flex items-center justify-between">
                      <div className="font-semibold">{c.year} {c.make} {c.model}</div>
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
