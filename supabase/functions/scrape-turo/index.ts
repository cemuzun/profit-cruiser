// Turo scraper trigger — the actual scraping runs on a separate VPS worker
// (see vps-scraper/) on a cron schedule and writes directly to the database
// with the service role key. This edge function used to call Apify, but Apify
// is no longer used.
//
// What this function now does:
//   - Acknowledges manual "Scrape now" requests from the dashboard
//   - Inserts a scrape_runs row with status = 'pending' so the VPS worker
//     can pick it up on its next poll (every minute)
//   - Returns 202 immediately
//
// Trigger:
//   POST /scrape-turo                          → all active cities
//   POST /scrape-turo  body { city: "los-angeles" }  → one city
//   POST /scrape-turo  body { all: true }      → all active cities
//   POST /scrape-turo  body { test_proxy: true } → connectivity check

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {}

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Connectivity test — just confirm we can reach the database.
  if (body.test_proxy) {
    const { error } = await supa.from("cities").select("slug").limit(1);
    if (error) {
      return jsonResponse({
        ok: false,
        error: `Database check failed: ${error.message}`,
      });
    }
    return jsonResponse({
      ok: true,
      message:
        "Edge function reachable. Scraping runs on the VPS worker on a cron schedule (every 12h). Use the VPS to trigger ad-hoc runs.",
    });
  }

  // Resolve target cities.
  let cities: { slug: string; name: string }[] = [];
  if (body.city && typeof body.city === "string") {
    const { data } = await supa
      .from("cities")
      .select("slug,name")
      .eq("slug", body.city)
      .maybeSingle();
    if (data) cities = [data as any];
  } else {
    const { data } = await supa
      .from("cities")
      .select("slug,name")
      .eq("active", true);
    cities = (data ?? []) as any;
  }

  if (cities.length === 0) {
    return jsonResponse({ ok: false, error: "No matching active cities found" });
  }

  // Insert pending scrape_runs rows. The VPS worker (vps-scraper) polls this
  // table and runs any pending entries.
  const inserts = cities.map((c) => ({
    city: c.slug,
    status: "pending",
  }));
  const { data: rows, error } = await supa
    .from("scrape_runs")
    .insert(inserts)
    .select("id,city");

  if (error) {
    return jsonResponse(
      {
        ok: false,
        error: `Failed to queue scrape: ${error.message}`,
      },
      500,
    );
  }

  return jsonResponse(
    {
      ok: true,
      queued: true,
      cities: cities.map((c) => c.slug),
      runs: rows,
      message:
        "Scrape queued. The VPS worker will pick it up on its next poll. Watch the runs list for live status.",
    },
    202,
  );
});
