import { useEffect, useState } from "react";
import { AppNav } from "@/components/AppNav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

const STORAGE_KEY = "proxy_settings_v1";

type ProxyForm = {
  protocol: "http" | "https";
  host: string;
  port: string;
  username: string;
  password: string;
};

const EMPTY: ProxyForm = {
  protocol: "http",
  host: "",
  port: "",
  username: "",
  password: "",
};

function buildUrl(f: ProxyForm): string {
  if (!f.host || !f.port) return "";
  const auth =
    f.username || f.password
      ? `${encodeURIComponent(f.username)}:${encodeURIComponent(f.password)}@`
      : "";
  return `${f.protocol}://${auth}${f.host}:${f.port}`;
}

export default function Proxy() {
  const [form, setForm] = useState<ProxyForm>(EMPTY);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setForm({ ...EMPTY, ...JSON.parse(raw) });
    } catch {}
  }, []);

  const update = (k: keyof ProxyForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const handleSave = () => {
    if (!form.host || !form.port) {
      toast.error("Host and port are required");
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    toast.success("Proxy settings saved (browser-local)");
  };

  const handleClear = () => {
    localStorage.removeItem(STORAGE_KEY);
    setForm(EMPTY);
    setResult(null);
    toast.success("Proxy settings cleared");
  };

  const handleTest = async () => {
    const url = buildUrl(form);
    if (!url) {
      toast.error("Fill in host and port first");
      return;
    }
    setTesting(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("scrape-turo", {
        body: { test_proxy: true, proxy_url: url },
      });
      if (error) throw error;
      if (data?.ok) {
        setResult({ ok: true, message: data.message || "Proxy reachable" });
      } else {
        setResult({ ok: false, message: data?.error || "Proxy test failed" });
      }
    } catch (e: any) {
      setResult({ ok: false, message: e?.message || "Request failed" });
    } finally {
      setTesting(false);
    }
  };

  const previewUrl = buildUrl(form);

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <main className="container mx-auto px-4 py-6 space-y-4 max-w-3xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Proxy Settings</h1>
          <Badge variant="secondary">Browser-local</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Manually enter proxy credentials. Saved to your browser only — does not change backend
          edge function secrets.
        </p>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connection</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="protocol">Protocol</Label>
                <select
                  id="protocol"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={form.protocol}
                  onChange={(e) =>
                    setForm({ ...form, protocol: e.target.value as "http" | "https" })
                  }
                >
                  <option value="http">http</option>
                  <option value="https">https</option>
                </select>
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="host">Host</Label>
                <Input
                  id="host"
                  placeholder="res.geonix.com"
                  value={form.host}
                  onChange={update("host")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="port">Port</Label>
                <Input
                  id="port"
                  placeholder="10000"
                  value={form.port}
                  onChange={update("port")}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  autoComplete="off"
                  value={form.username}
                  onChange={update("username")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={form.password}
                  onChange={update("password")}
                />
              </div>
            </div>

            {previewUrl && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Preview URL</Label>
                <code className="block break-all rounded-md bg-muted px-3 py-2 text-xs">
                  {previewUrl}
                </code>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-2">
              <Button onClick={handleSave}>Save</Button>
              <Button variant="outline" onClick={handleTest} disabled={testing}>
                {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Test proxy
              </Button>
              <Button variant="ghost" onClick={handleClear}>
                Clear
              </Button>
            </div>

            {result && (
              <div
                className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
                  result.ok
                    ? "border-primary/30 bg-primary/5 text-foreground"
                    : "border-destructive/30 bg-destructive/5 text-foreground"
                }`}
              >
                {result.ok ? (
                  <ShieldCheck className="h-4 w-4 mt-0.5 text-primary" />
                ) : (
                  <ShieldAlert className="h-4 w-4 mt-0.5 text-destructive" />
                )}
                <div className="break-all">{result.message}</div>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
