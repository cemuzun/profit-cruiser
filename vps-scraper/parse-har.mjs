#!/usr/bin/env node
// Track B — Parse a HAR file exported from Chrome DevTools and extract
// Turo /api/ requests with full headers, cookies, and body shape.
//
// Usage:
//   node parse-har.mjs path/to/turo.har > turo-api.json
//
// In Chrome:
//   1. Open https://turo.com/us/en/search?... in a normal window (logged-in OK)
//   2. DevTools → Network tab → filter "api"
//   3. Reload, scroll, change filters to trigger requests
//   4. Right-click any row → "Save all as HAR with content"

import { readFile } from "node:fs/promises";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node parse-har.mjs <file.har>");
  process.exit(2);
}

const har = JSON.parse(await readFile(file, "utf8"));
const entries = har?.log?.entries ?? [];

const apiEntries = entries.filter((e) =>
  /turo\.com\/api\//.test(e.request?.url ?? ""),
);

const summarized = apiEntries.map((e) => {
  const req = e.request ?? {};
  const res = e.response ?? {};
  const headers = Object.fromEntries(
    (req.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]),
  );
  const respHeaders = Object.fromEntries(
    (res.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]),
  );

  // Build a curl example
  const headerArgs = Object.entries(headers)
    .filter(([k]) => !["host", "content-length", ":authority", ":method", ":path", ":scheme"].includes(k))
    .map(([k, v]) => `  -H ${JSON.stringify(`${k}: ${v}`)}`)
    .join(" \\\n");

  const bodyText = req.postData?.text ?? "";
  const dataArg = bodyText ? ` \\\n  --data ${JSON.stringify(bodyText)}` : "";
  const methodArg = req.method && req.method !== "GET" ? ` -X ${req.method}` : "";
  const curl = `curl${methodArg} ${JSON.stringify(req.url)} \\\n${headerArgs}${dataArg}`;

  return {
    method: req.method,
    url: req.url,
    status: res.status,
    requestHeaders: headers,
    responseHeaders: respHeaders,
    requestBody: bodyText || null,
    responseBodyPreview: (res.content?.text ?? "").slice(0, 4000),
    responseSize: res.content?.size ?? null,
    curl,
  };
});

const summary = {
  source: file,
  totalEntries: entries.length,
  apiEntries: summarized.length,
  uniqueEndpoints: [...new Set(summarized.map((s) => `${s.method} ${s.url.split("?")[0]}`))],
  importantHeaders: [...new Set(
    summarized.flatMap((s) =>
      Object.keys(s.requestHeaders).filter((h) =>
        /^(x-|cookie|authorization|csrf|apikey|api-key)/i.test(h),
      ),
    ),
  )],
  entries: summarized,
};

console.log(JSON.stringify(summary, null, 2));
console.error(
  `\nFound ${summarized.length} /api/ requests across ${summary.uniqueEndpoints.length} unique endpoints.`,
);
console.error(`Important header families: ${summary.importantHeaders.join(", ") || "(none)"}`);
