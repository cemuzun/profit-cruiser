// Receives normalized Turo listings from the browser and persists them.
// Browser does the scraping (no proxy needed); this function just writes to DB.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const city: string = body.city;
    const rows: any[] = Array.isArray(body.rows) ? body.rows : [];
    const segments: number = body.segments ?? 0;
    const errorMsg: string | null = body.error ?? null;

    if (!city) {
      return new Response(JSON.stringify({ error: "city required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: runRow } = await supabase
      .from("scrape_runs")
      .insert({ city, status: "running" })
      .select()
      .single();
    const runId = runRow?.id;

    const chunkSize = 200;
    if (rows.length > 0) {
      const snapshots = rows.map((r) => ({ ...r, scraped_at: new Date().toISOString() }));
      for (let i = 0; i < snapshots.length; i += chunkSize) {
        await supabase.from("listings_snapshots").insert(snapshots.slice(i, i + chunkSize));
      }
      const currentRows = rows.map(({ raw, ...r }) => ({
        ...r,
        last_scraped_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));
      for (let i = 0; i < currentRows.length; i += chunkSize) {
        await supabase
          .from("listings_current")
          .upsert(currentRows.slice(i, i + chunkSize), { onConflict: "vehicle_id" });
      }
    }

    await supabase
      .from("scrape_runs")
      .update({
        status: rows.length > 0 ? "success" : (errorMsg ? "failed" : "empty"),
        vehicles_count: rows.length,
        segments_run: segments,
        error_message: errorMsg,
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);

    return new Response(
      JSON.stringify({ ok: true, count: rows.length, city }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
