import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AppNav } from "@/components/AppNav";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useGlobalCosts } from "@/hooks/useGlobalCosts";
import { DEFAULT_GLOBAL, type GlobalCosts } from "@/lib/profitability";
import { format } from "date-fns";
import { toast } from "sonner";

export default function Settings() {
  const qc = useQueryClient();
  const { data } = useGlobalCosts();
  const [form, setForm] = useState<GlobalCosts>(DEFAULT_GLOBAL);
  useEffect(() => { if (data) setForm(data); }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("cost_assumptions_global")
        .update({ ...form, updated_at: new Date().toISOString() })
        .eq("id", 1);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: ["global-costs"] });
    },
  });

  const { data: runs } = useQuery({
    queryKey: ["scrape-runs"],
    queryFn: async () => {
      const { data } = await supabase.from("scrape_runs").select("*").order("started_at", { ascending: false }).limit(20);
      return data ?? [];
    },
  });

  const set = (k: keyof GlobalCosts) => (e: any) => setForm({ ...form, [k]: Number(e.target.value) });

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <main className="container mx-auto px-4 py-6 space-y-4">
        <h1 className="text-2xl font-bold">Settings</h1>

        <Card>
          <CardContent className="pt-4 space-y-3">
            <h2 className="font-semibold">Global cost assumptions</h2>
            <p className="text-xs text-muted-foreground">These defaults apply to every car unless overridden on the car detail page.</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Field label="Utilization %" value={form.utilization_pct} onChange={set("utilization_pct")} />
              <Field label="Turo platform fee %" value={form.turo_fee_pct} onChange={set("turo_fee_pct")} />
              <Field label="Insurance / month ($)" value={form.insurance_monthly} onChange={set("insurance_monthly")} />
              <Field label="Maintenance / month ($)" value={form.maintenance_monthly} onChange={set("maintenance_monthly")} />
              <Field label="Cleaning / trip ($)" value={form.cleaning_per_trip} onChange={set("cleaning_per_trip")} />
              <Field label="Depreciation %/yr" value={form.depreciation_pct_annual} onChange={set("depreciation_pct_annual")} />
              <Field label="Registration / month ($)" value={form.registration_monthly} onChange={set("registration_monthly")} />
              <Field label="Tires / month ($)" value={form.tires_monthly} onChange={set("tires_monthly")} />
              <Field label="Default purchase price ($)" value={form.default_purchase_price} onChange={set("default_purchase_price")} />
              <Field label="Trips/month estimate" value={form.trips_per_month_estimate} onChange={set("trips_per_month_estimate")} />
            </div>
            <div className="flex gap-2 pt-2">
              <Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
              <Button variant="ghost" onClick={() => setForm(DEFAULT_GLOBAL)}>Reset to defaults</Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4 space-y-3">
            <h2 className="font-semibold">Scrape runs</h2>
            <p className="text-xs text-muted-foreground">Daily auto-scrape runs at 9:00 UTC. Use "Refresh now" on the dashboard to trigger manually.</p>
            <div className="space-y-1.5">
              {runs?.length ? runs.map((r: any) => (
                <div key={r.id} className="flex items-center justify-between text-sm border border-border rounded-md px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Badge variant={r.status === "success" ? "default" : r.status === "failed" ? "destructive" : "secondary"}>{r.status}</Badge>
                    <span>{r.city}</span>
                    <span className="text-muted-foreground">{format(new Date(r.started_at), "MMM d, HH:mm")}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {r.vehicles_count ?? 0} vehicles · {r.segments_run ?? 0} segments
                    {r.error_message && <span className="text-destructive ml-2">{r.error_message.slice(0, 60)}</span>}
                  </div>
                </div>
              )) : <p className="text-sm text-muted-foreground">No scrape runs yet.</p>}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: number; onChange: (e: any) => void }) {
  return (
    <div>
      <Label>{label}</Label>
      <Input type="number" value={value} onChange={onChange} />
    </div>
  );
}
