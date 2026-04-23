import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ds, type City } from "@/lib/dataSource";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Play, Trash2, Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";

export function CitiesManager() {
  const qc = useQueryClient();
  const [scraping, setScraping] = useState<string | null>(null);
  const [scrapingAll, setScrapingAll] = useState(false);

  const { data: cities, isLoading } = useQuery({
    queryKey: ["cities"],
    queryFn: () => ds.cities(),
  });

  const { data: runs } = useQuery({
    queryKey: ["scrape-runs"],
    queryFn: () => ds.runs(),
  });

  const lastRun = runs?.[0];
  const lastRunLabel = lastRun
    ? `${new Date(lastRun.started_at).toLocaleString()} · ${lastRun.status}${
        lastRun.vehicles_count != null ? ` · ${lastRun.vehicles_count} vehicles` : ""
      }`
    : "Never";

  const triggerOne = async (slug: string) => {
    setScraping(slug);
    try {
      await ds.triggerScrape(slug);
      toast.success(`Scrape complete for ${slug}`);
      qc.invalidateQueries({ queryKey: ["listings-current"] });
      qc.invalidateQueries({ queryKey: ["scrape-runs"] });
    } catch (e: any) {
      toast.error(`Scrape failed: ${e.message}`);
    } finally {
      setScraping(null);
    }
  };

  const triggerAll = async () => {
    setScrapingAll(true);
    try {
      await ds.triggerScrape();
      toast.success("Scrape queued for all active cities — refreshing in a few minutes");
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["listings-current"] });
        qc.invalidateQueries({ queryKey: ["scrape-runs"] });
      }, 30_000);
      qc.invalidateQueries({ queryKey: ["scrape-runs"] });
    } catch (e: any) {
      toast.error(`Scrape failed: ${e.message}`);
    } finally {
      setScrapingAll(false);
    }
  };

  const removeCity = useMutation({
    mutationFn: (slug: string) => ds.removeCity(slug),
    onSuccess: () => {
      toast.success("City removed");
      qc.invalidateQueries({ queryKey: ["cities"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const toggleActive = useMutation({
    mutationFn: ({ slug, active }: { slug: string; active: boolean }) =>
      ds.setCityActive(slug, active),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cities"] }),
  });

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h2 className="font-semibold flex items-center gap-2">
              <MapPin className="h-4 w-4" /> Cities
            </h2>
            <p className="text-xs text-muted-foreground">
              Scrapes run automatically daily at 09:00 UTC. Use Run to refresh manually.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={triggerAll}
                disabled={scrapingAll || !cities?.some((c) => c.active)}
              >
                {scrapingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Run all active
              </Button>
              <AddCityDialog onAdded={() => qc.invalidateQueries({ queryKey: ["cities"] })} />
            </div>
            <p className="text-xs text-muted-foreground">Last run: {lastRunLabel}</p>
          </div>
        </div>

        {isLoading ? (
          <div className="py-6 text-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin inline" />
          </div>
        ) : !cities?.length ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No cities yet. Add one to start scraping.
          </p>
        ) : (
          <div className="space-y-2">
            {cities.map((c) => (
              <div
                key={c.slug}
                className="flex items-center justify-between gap-2 border border-border rounded-md px-3 py-2"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Switch
                    checked={c.active}
                    onCheckedChange={(v) => toggleActive.mutate({ slug: c.slug, active: v })}
                  />
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">{c.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {c.slug} · {c.region ?? "—"} · {c.latitude.toFixed(3)}, {c.longitude.toFixed(3)}
                    </div>
                  </div>
                  {!c.active && <Badge variant="secondary" className="text-xs">Paused</Badge>}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => triggerOne(c.slug)}
                    disabled={scraping === c.slug || scrapingAll}
                  >
                    {scraping === c.slug
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Play className="h-3.5 w-3.5" />}
                    Run
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (confirm(`Remove ${c.name}? Existing scraped data is kept.`))
                        removeCity.mutate(c.slug);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

      </CardContent>
    </Card>
  );
}

function AddCityDialog({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    slug: "",
    name: "",
    country: "US",
    region: "",
    latitude: "",
    longitude: "",
    place_id: "",
  });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!form.slug || !form.name || !form.latitude || !form.longitude) {
      toast.error("Slug, name, latitude and longitude are required");
      return;
    }
    setSaving(true);
    try {
      await ds.addCity({
        slug: form.slug.trim().toLowerCase().replace(/\s+/g, "-"),
        name: form.name.trim(),
        country: form.country.trim() || "US",
        region: form.region.trim() || null,
        latitude: Number(form.latitude),
        longitude: Number(form.longitude),
        place_id: form.place_id.trim() || null,
      });
      toast.success("City added");
      onAdded();
      setOpen(false);
      setForm({ slug: "", name: "", country: "US", region: "", latitude: "", longitude: "", place_id: "" });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="h-4 w-4" />Add city</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add city to scrape</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Slug *" hint="e.g. san-francisco"
            value={form.slug} onChange={(v) => setForm({ ...form, slug: v })} />
          <Field label="Display name *" value={form.name}
            onChange={(v) => setForm({ ...form, name: v })} />
          <Field label="Country" value={form.country}
            onChange={(v) => setForm({ ...form, country: v })} />
          <Field label="Region/state" value={form.region}
            onChange={(v) => setForm({ ...form, region: v })} hint="e.g. CA" />
          <Field label="Latitude *" value={form.latitude}
            onChange={(v) => setForm({ ...form, latitude: v })} />
          <Field label="Longitude *" value={form.longitude}
            onChange={(v) => setForm({ ...form, longitude: v })} />
          <div className="col-span-2">
            <Field label="Google place ID" value={form.place_id}
              onChange={(v) => setForm({ ...form, place_id: v })}
              hint="Optional. Improves Turo result accuracy." />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Get latitude/longitude from Google Maps — right-click the city and click the coordinates to copy.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Add city
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label, value, onChange, hint,
}: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}
