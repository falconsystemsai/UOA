
// Cloudflare Worker for Unusual Options Activity Viewer
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+/, "/");

    if (path === "/" || path === "/index.html") {
      return new Response(getHTML(), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    if (path === "/api/uoa") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405, corsHeaders());
      }
      return handleUOARequest(url, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  }
};

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Content-Type"
  };
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

async function handleUOARequest(url, env, ctx) {
  const params = url.searchParams;
  const tickers = (params.get("tickers") || "").trim();
  const sentiment = (params.get("sentiment") || "").trim();
  const minPremium = params.get("min_premium");
  const sweepOnly = params.get("sweep_only") === "true";
  const page = params.get("page") || "1";
  const pageSize = params.get("page_size") || "50";
  const dateFrom = params.get("date_from") || "";
  const dateTo = params.get("date_to") || "";

  const apiUrl = buildBenzingaURL({
    baseUrl: env.BENZINGA_BASE_URL || "https://api.benzinga.com/api/v1/signal/option_activity",
    token: env.BENZINGA_API_KEY,
    tickers, sentiment, minPremium, sweepOnly, page, pageSize, dateFrom, dateTo
  });

  if (!env.BENZINGA_API_KEY) {
    return json({ error: "Missing BENZINGA_API_KEY secret" }, 500, corsHeaders());
  }

  const cache = caches.default;
  const cacheKey = new Request(apiUrl.toString(), { method: "GET" });
  const ttl = parseInt(env.CACHE_TTL_SECONDS || "30", 10);

  let res = await cache.match(cacheKey);
  if (!res) {
    const upstream = await fetch(apiUrl.toString(), { cf: { cacheTtl: 0, cacheEverything: false } });
    const data = await upstream.json().catch(() => ({ error: "Upstream decode failed" }));
    const normalized = normalizeBenzingaPayload(data);

    res = json({ ok: !data.error, source_status: upstream.status, page: Number(page),
      page_size: Number(pageSize), count: normalized.length, results: normalized
    }, upstream.ok ? 200 : upstream.status, corsHeaders());

    if (upstream.ok) {
      ctx.waitUntil(cache.put(cacheKey, new Response(res.body, {
        headers: { ...Object.fromEntries(res.headers), "cache-control": `public, max-age=${ttl}` },
        status: res.status
      })));
    }
  }
  return res;
}

function buildBenzingaURL({ baseUrl, token, tickers, sentiment, minPremium, sweepOnly, page, pageSize, dateFrom, dateTo }) {
  const u = new URL(baseUrl);
  u.searchParams.set("token", token);
  if (tickers) u.searchParams.set("tickers", tickers);
  if (sentiment) u.searchParams.set("sentiment", sentiment);
  if (minPremium) u.searchParams.set("min_total_trade_value", String(minPremium));
  if (sweepOnly) u.searchParams.set("sweep_only", "true");
  if (dateFrom) u.searchParams.set("date_from", dateFrom);
  if (dateTo) u.searchParams.set("date_to", dateTo);
  u.searchParams.set("page", page);
  u.searchParams.set("pagesize", pageSize);
  return u;
}

function normalizeBenzingaPayload(data) {
  const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  return rows.map((row) => ({
    id: row.id ?? `${row.ticker || row.underlying_ticker}-${row.trade_time || Date.now()}`,
    ticker: row.ticker || row.underlying_ticker || "", type: row.option_type || "", side: row.sentiment || "",
    sweep: Boolean(row.sweep ?? row.is_sweep),
    premium: Number(row.total_trade_value || row.premium || 0),
    trade_price: Number(row.price || row.trade_price || 0),
    quantity: Number(row.size || row.quantity || 0),
    strike: Number(row.strike || 0), expiry: row.expiration_date || "", time: row.time || "",
    iv: Number(row.iv || 0), underlying_price: Number(row.underlying_price || 0)
  }));
}

function getHTML() {
  return `<!DOCTYPE html><html><head><meta charset='utf-8'><title>UOA Viewer</title></head>
  <body><h1>Unusual Options Activity</h1><p>Use /api/uoa endpoint with query params.</p></body></html>`;
}
// Cloudflare Worker code goes here (see previous full script)
