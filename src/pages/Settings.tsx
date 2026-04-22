import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ds, userStore } from "@/lib/dataSource";
import { AppNav } from "@/components/AppNav";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useGlobalCosts } from "@/hooks/useGlobalCosts";
import { DEFAULT_GLOBAL, type GlobalCosts, type AcquisitionMode } from "@/lib/profitability";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { format } from "date-fns";
import { toast } from "sonner";

export default function Settings() {
  const qc = useQueryClient();
  const { data } = useGlobalCosts();
  const [form, setForm] = useState<GlobalCosts>(DEFAULT_GLOBAL);
  useEffect(() => { if (data) setForm(data); }, [data]);

  const save = useMutation({
    mutationFn: async () => { userStore.setGlobal(form); },
    onSuccess: () => {
      toast.success("Settings saved (browser-local)");
      qc.invalidateQueries({ queryKey: ["global-costs"] });
    },
  });

  const { data: runs } = useQuery({
    queryKey: ["scrape-runs"],
    queryFn: async () => ds.runs(),
  });

  const set = (k: keyof GlobalCosts) => (e: any) => {
    const raw = e.target.value;
    setForm({ ...form, [k]: raw === "" ? (null as any) : Number(raw) });
  };
  const setMode = (v: string) => setForm({ ...form, default_acquisition_mode: v as AcquisitionMode });

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <main className="container mx-auto px-4 py-6 space-y-4">
        <h1 className="text-2xl font-bold">Settings</h1>

        <Card>
          <CardContent className="pt-4 space-y-3">
            <h2 className="font-semibold">Global cost assumptions</h2>
            <p className="text-xs text-muted-foreground">Stored in your browser (localStorage). Apply to every car unless overridden on the car detail page.</p>
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
              <Field
                label="Trips/month estimate"
                value={form.trips_per_month_estimate}
                onChange={set("trips_per_month_estimate")}
                hint="How many separate rentals per month at 60% utilization. Drives cleaning cost (cleaning/trip × trips × utilization adjustment) and estimated miles driven."
              />
            </div>

            <div className="pt-2">
              <h3 className="font-medium mb-2">Acquisition (buy vs. lease) defaults</h3>
              <div className="flex items-center gap-3 mb-3">
                <Label className="text-sm">Default mode</Label>
                <Tabs value={form.default_acquisition_mode} onValueChange={setMode}>
                  <TabsList>
                    <TabsTrigger value="buy">Buy</TabsTrigger>
                    <TabsTrigger value="lease">Lease</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <Field label="Default lease $/mo" value={form.default_lease_monthly} onChange={set("default_lease_monthly")} />
                <Field label="Default lease down ($)" value={form.default_lease_down} onChange={set("default_lease_down")} />
                <Field label="Default lease term (mo)" value={form.default_lease_term_months} onChange={set("default_lease_term_months")} />
              </div>
            </div>

            <div className="pt-2">
              <h3 className="font-medium mb-2">Mileage defaults</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <Field label="Mileage cap / month" value={form.default_mileage_cap_monthly} onChange={set("default_mileage_cap_monthly")} hint="Typical lease: 12,000 mi/yr ≈ 1,000/mo. For buys, treat as the threshold beyond which extra wear hits." />
                <Field label="Overage $/mile" value={form.default_mileage_overage_per_mi} onChange={set("default_mileage_overage_per_mi")} />
                <Field label="Avg miles per trip" value={form.default_avg_miles_per_trip} onChange={set("default_avg_miles_per_trip")} hint="Used when 'Avg miles per day' is empty. Estimated miles/mo = trips/mo × avg miles per trip." />
                <Field label="Avg miles per day (optional)" value={form.default_avg_miles_per_day ?? ""} onChange={set("default_avg_miles_per_day" as any)} hint="If set, takes precedence over per-trip. Estimated miles/mo = 30 × utilization% × avg miles per day." />
              </div>
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
            <p className="text-xs text-muted-foreground">Auto-scrape runs daily at 09:00 UTC. You can also trigger runs from the dashboard. Latest 50 runs shown.</p>
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
              )) : <p className="text-sm text-muted-foreground">No scrape runs yet — waiting for first VPS run.</p>}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function Field({ label, value, onChange, hint }: { label: string; value: number | string | null | undefined; onChange: (e: any) => void; hint?: string }) {
  return (
    <div>
      <Label className="flex items-center gap-1">
        {label}
        {hint && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3 w-3 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs"><p className="text-xs">{hint}</p></TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </Label>
      <Input type="number" value={value ?? ""} onChange={onChange} />
    </div>
  );
}
