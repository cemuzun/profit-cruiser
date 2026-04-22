// Fetches an estimated average listing price from CarGurus for a given
// year/make/model (+ optional trim) using the Firecrawl API.
//
// Strategy: ask Firecrawl to scrape CarGurus' national used-car search
// results page with JSON extraction so we get back a structured number
// (avg/median listing price) regardless of CarGurus DOM changes.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FIRECRAWL_V2 = "https://api.firecrawl.dev/v2";

type Body = {
  year?: number | string;
  make?: string;
  model?: string;
  trim?: string | null;
};

function buildSearchUrl(b: Body): string {
  const q = [b.year, b.make, b.model, b.trim].filter(Boolean).join(" ").trim();
  // Public CarGurus search; we let Firecrawl render and extract.
  const params = new URLSearchParams({
    sourceContext: "untrackedExternal_false_0",
    entitySelectingHelper: "true",
    searchKeyword: q,
  });
  return `https://www.cargurus.com/Cars/inventorylisting/viewDetailsFilterViewInventoryListing.action?${params.toString()}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const apiKey = Deno.env.get("FIRECRAWL_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "FIRECRAWL_API_KEY not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    if (!body.make || !body.model) {
      return new Response(JSON.stringify({ error: "make and model are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = buildSearchUrl(body);

    const fcRes = await fetch(`${FIRECRAWL_V2}/scrape`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        onlyMainContent: true,
        waitFor: 3000,
        formats: [
          {
            type: "json",
            prompt:
              "From this CarGurus used-car search results page, extract the typical asking price in US dollars for a " +
              [body.year, body.make, body.model, body.trim].filter(Boolean).join(" ") +
              ". Return JSON with: avg_price (number, the average asking price across visible listings), " +
              "min_price (number), max_price (number), sample_size (integer, how many listings you saw), " +
              "currency (string, e.g. 'USD'). If the page shows no relevant inventory, return all numeric fields as null.",
            schema: {
              type: "object",
              properties: {
                avg_price: { type: ["number", "null"] },
                min_price: { type: ["number", "null"] },
                max_price: { type: ["number", "null"] },
                sample_size: { type: ["integer", "null"] },
                currency: { type: ["string", "null"] },
              },
              required: ["avg_price"],
            },
          },
        ],
      }),
    });

    const fcData = await fcRes.json().catch(() => null) as any;
    if (!fcRes.ok) {
      return new Response(
        JSON.stringify({ error: fcData?.error ?? `Firecrawl error ${fcRes.status}`, source_url: url }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Firecrawl v2 may return either { data: { json: ... } } or top-level json
    const json = fcData?.data?.json ?? fcData?.json ?? null;
    if (!json || (json.avg_price == null && json.min_price == null && json.max_price == null)) {
      return new Response(
        JSON.stringify({
          error: "No price found on CarGurus for this vehicle",
          source_url: url,
          raw: json,
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        avg_price: json.avg_price ?? null,
        min_price: json.min_price ?? null,
        max_price: json.max_price ?? null,
        sample_size: json.sample_size ?? null,
        currency: json.currency ?? "USD",
        source_url: url,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message ?? "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
