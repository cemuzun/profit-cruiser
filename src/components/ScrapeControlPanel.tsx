import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ds, ALL_FUEL_TYPES, type ScrapeFilters } from "@/lib/dataSource";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, Play, Settings as SettingsIcon } from "lucide-react";
import { toast } from "sonner";

const EMPTY_FILTERS: ScrapeFilters = {
  vehicle_types: [],
  fuel_types: [],
  min_daily_price: null,
  max_daily_price: null,
  min_year: null,
  max_year: null,
  min_trips: null,
  min_rating: null,
  enabled: true,
};

/** Compact scrape-control panel for the Dashboard. Edits the same
 *  scrape_filters singleton row that Settings → Scrape filters uses,
 *  plus a "Run scrape" button that targets a city or all active. */
export function ScrapeControlPanel() {
  const qc = useQueryClient();

  const { data: filters } = useQuery({
    queryKey: ["scrape-filters"],
    queryFn: () => ds.scrapeFilters(),
  });
  const { data: cities } = useQuery({
    queryKey: ["cities"],
    queryFn: () => ds.cities(),
  });

  const [form, setForm] = useState<ScrapeFilters>(EMPTY_FILTERS);
  const [target, setTarget] = useState<string>("__all__");
  useEffect(() => { if (filters) setForm(filters); }, [filters]);

  const setNum = (k: keyof ScrapeFilters) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    // Strip non-numeric characters defensively (validation happens server-side too).
    const cleaned = raw.replace(/[^\d.]/g, "");
    setForm({ ...form, [k]: cleaned === "" ? null : Number(cleaned) } as ScrapeFilters);
  };

  const toggleFuel = (f: string) => {
    const cur = form.fuel_types ?? [];
    const has = cur.includes(f);
    setForm({ ...form, fuel_types: has ? cur.filter(x => x !== f) : [...cur, f] });
  };

  const saveAndRun = useMutation({
    mutationFn: async () => {
      // Basic client-side validation
      const ratingOk = form.min_rating == null || (form.min_rating >= 0 && form.min_rating <= 5);
      const tripsOk = form.min_trips == null || form.min_trips >= 0;
      const yearOk =
        (form.min_year == null || (form.min_year >= 1980 && form.min_year <= 2100)) &&
        (form.max_year == null || (form.max_year >= 1980 && form.max_year <= 2100));
      const priceOk =
        (form.min_daily_price == null || form.min_daily_price >= 0) &&
        (form.max_daily_price == null || form.max_daily_price >= 0);
      if (!ratingOk) throw new Error("Min rating must be between 0 and 5");
      if (!tripsOk) throw new Error("Min trips must be ≥ 0");
      if (!yearOk) throw new Error("Year must be between 1980 and 2100");
      if (!priceOk) throw new Error("Price values must be ≥ 0");

      await ds.saveScrapeFilters({
        vehicle_types: form.vehicle_types ?? [],
        fuel_types: form.fuel_types ?? [],
        min_daily_price: form.min_daily_price,
        max_daily_price: form.max_daily_price,
        min_year: form.min_year,
        max_year: form.max_year,
        min_trips: form.min_trips,
        min_rating: form.min_rating,
        enabled: form.enabled,
      });
      const citySlug = target === "__all__" ? undefined : target;
      await ds.triggerScrape(citySlug);
    },
    onSuccess: () => {
      toast.success(
        target === "__all__"
          ? "Filters saved — scraping all active cities…"
          : `Filters saved — scraping ${cities?.find(c => c.slug === target)?.name ?? target}…`,
      );
      qc.invalidateQueries({ queryKey: ["scrape-filters"] });
      qc.invalidateQueries({ queryKey: ["scrape-runs"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to start scrape"),
  });

  const runOnly = useMutation({
    mutationFn: async () => {
      const citySlug = target === "__all__" ? undefined : target;
      await ds.triggerScrape(citySlug);
    },
    onSuccess: () => {
      toast.success("Scrape queued");
      qc.invalidateQueries({ queryKey: ["scrape-runs"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to start scrape"),
  });

  const isPending = saveAndRun.isPending || runOnly.isPending;

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="font-semibold text-sm">Scrape controls</h2>
            <p className="text-xs text-muted-foreground">
              Pre-scrape filters applied before listings are saved. Manage vehicle types and year range in <Link to="/settings" className="underline">Settings</Link>.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="dash-filters-enabled" className="text-xs text-muted-foreground">Filters enabled</Label>
            <Switch
              id="dash-filters-enabled"
              checked={form.enabled}
              onCheckedChange={(v) => setForm({ ...form, enabled: v })}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Compact label="Min $/day" value={form.min_daily_price} onChange={setNum("min_daily_price")} placeholder="0" />
          <Compact label="Max $/day" value={form.max_daily_price} onChange={setNum("max_daily_price")} placeholder="∞" />
          <Compact label="Min trips" value={form.min_trips} onChange={setNum("min_trips")} placeholder="0" />
          <Compact label="Min rating (0–5)" value={form.min_rating} onChange={setNum("min_rating")} placeholder="0" />
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">Fuel types</Label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-1">
            {ALL_FUEL_TYPES.map((f) => (
              <label key={f} className="flex items-center gap-2 text-xs border border-border rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/40">
                <Checkbox
                  checked={(form.fuel_types ?? []).includes(f)}
                  onCheckedChange={() => toggleFuel(f)}
                />
                <span>{f.toLowerCase()}</span>
              </label>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">
            Empty = all fuels. Listings with unknown fuel always pass through.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2 pt-1 border-t border-border">
          <div className="flex-1 min-w-[160px]">
            <Label className="text-xs text-muted-foreground">Target</Label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All active cities</SelectItem>
                {(cities ?? []).filter(c => c.active).map((c) => (
                  <SelectItem key={c.slug} value={c.slug}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={() => saveAndRun.mutate()}
            disabled={isPending}
            className="gap-1.5"
          >
            {saveAndRun.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Save & run
          </Button>
          <Button
            variant="outline"
            onClick={() => runOnly.mutate()}
            disabled={isPending}
            className="gap-1.5"
          >
            {runOnly.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Run only
          </Button>
          <Button asChild variant="ghost" size="sm" className="gap-1.5">
            <Link to="/settings"><SettingsIcon className="h-4 w-4" /> More options</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Compact({
  label, value, onChange, placeholder,
}: {
  label: string;
  value: number | null;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type="text"
        inputMode="decimal"
        value={value ?? ""}
        onChange={onChange}
        placeholder={placeholder}
      />
    </div>
  );
}
