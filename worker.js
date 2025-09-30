
// Cloudflare Worker for Unusual Options Activity Viewer
export default {
  fetch: handleFetch
};

async function handleFetch(request, env, ctx) {
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
  const minPremium = params.get("min_premium") ?? params.get("min_total_trade_value");
  const sweepOnlyParam = params.get("sweep_only") ?? params.get("sweepOnly") ?? "false";
  const sweepOnly = String(sweepOnlyParam).toLowerCase() === "true";
  const page = params.get("page") || params.get("page_number") || "1";
  const pageSize =
    params.get("page_size") ||
    params.get("pagesize") ||
    params.get("pageSize") ||
    params.get("limit") ||
    "50";
  const dateFrom = params.get("date_from") || "";
  const dateTo = params.get("date_to") || "";

  const useHeaderAuth = env.BENZINGA_USE_AUTH_HEADER === "true";
  const apiUrl = buildBenzingaURL({
    baseUrl: env.BENZINGA_BASE_URL || "https://api.benzinga.com/api/v1/signal/option_activity",
    token: useHeaderAuth ? undefined : env.BENZINGA_API_KEY,
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
    const upstream = await fetch(apiUrl.toString(), {
      cf: { cacheTtl: 0, cacheEverything: false },
      headers: buildBenzingaHeaders(env)
    });
    const data = await upstream.json().catch(() => ({ error: "Upstream decode failed" }));
    const normalized = upstream.ok ? normalizeBenzingaPayload(data) : [];

    const payload = upstream.ok
      ? {
          ok: true,
          source_status: upstream.status,
          page: Number(page),
          page_size: Number(pageSize),
          count: normalized.length,
          results: normalized
        }
      : {
          ok: false,
          source_status: upstream.status,
          error: extractUpstreamError(data, upstream.statusText),
          error_details: typeof data === "object" ? data : { raw: data }
        };
    const status = upstream.ok ? 200 : upstream.status;
    const headers = {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders()
    };
    const body = JSON.stringify(payload);
    res = new Response(body, { status, headers });

    if (upstream.ok) {
      const cachedCopy = new Response(body, {
        status,
        headers: { ...headers, "cache-control": `public, max-age=${ttl}` }
      });
      ctx.waitUntil(cache.put(cacheKey, cachedCopy));
    }
  }
  return res;
}

function buildBenzingaHeaders(env) {
  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("user-agent", env.BENZINGA_USER_AGENT || "UOA Worker/1.0");
  if (env.BENZINGA_API_KEY && env.BENZINGA_USE_AUTH_HEADER === "true") {
    headers.set("authorization", `Bearer ${env.BENZINGA_API_KEY}`);
  }
  return headers;
}

function buildBenzingaURL({ baseUrl, token, tickers, sentiment, minPremium, sweepOnly, page, pageSize, dateFrom, dateTo }) {
  const u = new URL(baseUrl);
  if (token) {
    u.searchParams.set("token", token);
  }
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

function extractUpstreamError(data, fallback) {
  if (!data || typeof data !== "object") {
    return fallback || "Upstream request failed";
  }

  if (typeof data.error === "string" && data.error) {
    return data.error;
  }

  if (typeof data.message === "string" && data.message) {
    return data.message;
  }

  if (Array.isArray(data.errors) && data.errors.length > 0) {
    const first = data.errors[0];
    if (typeof first === "string") return first;
    if (first && typeof first.message === "string") return first.message;
  }

  return fallback || "Upstream request failed";
}

function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unusual Options Activity Viewer</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg-gradient: radial-gradient(circle at top left, #1f5ff5, #111827 55%);
      --panel-bg: rgba(17, 24, 39, 0.82);
      --panel-border: rgba(255, 255, 255, 0.12);
      --accent: #38bdf8;
      --accent-strong: #0ea5e9;
      --text-muted: rgba(255, 255, 255, 0.7);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", "Inter", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-gradient);
      color: #f9fafb;
      display: flex;
      align-items: stretch;
      justify-content: center;
      padding: 32px 20px 48px;
    }

    .app {
      width: min(1080px, 100%);
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    header {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    h1 {
      font-size: clamp(2rem, 4vw, 2.8rem);
      margin: 0;
      letter-spacing: 0.02em;
      text-shadow: 0 14px 32px rgba(8, 47, 73, 0.66);
    }

    header p {
      margin: 0;
      max-width: 720px;
      line-height: 1.6;
      color: var(--text-muted);
    }

    .panel {
      border-radius: 18px;
      border: 1px solid var(--panel-border);
      background: var(--panel-bg);
      box-shadow: 0 30px 60px rgba(15, 23, 42, 0.45);
      backdrop-filter: blur(12px);
      padding: 24px;
    }

    form {
      display: grid;
      gap: 18px;
    }

    .filters {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }

    label {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
    }

    .checkbox-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-self: end;
    }

    .checkbox-caption {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
    }

    .checkbox-control {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.95rem;
    }

    .checkbox-control label {
      margin: 0;
      font-size: 0.95rem;
      text-transform: none;
      letter-spacing: 0;
      color: #f8fafc;
    }

    input[type="text"],
    input[type="number"],
    input[type="date"],
    select {
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(15, 23, 42, 0.74);
      color: #f8fafc;
      padding: 12px;
      font-size: 1rem;
      transition: border 0.2s ease, box-shadow 0.2s ease;
    }

    input:focus,
    select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.24);
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      justify-content: space-between;
      align-items: center;
    }

    .controls-left {
      display: flex;
      gap: 12px;
      align-items: center;
    }

    button {
      appearance: none;
      border: none;
      padding: 12px 20px;
      border-radius: 999px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
      background: linear-gradient(135deg, var(--accent), var(--accent-strong));
      color: #0f172a;
      box-shadow: 0 16px 24px rgba(8, 145, 178, 0.35);
    }

    button:hover {
      transform: translateY(-1px);
      box-shadow: 0 22px 40px rgba(8, 145, 178, 0.45);
    }

    button.secondary {
      background: transparent;
      color: var(--text-muted);
      border: 1px solid rgba(148, 163, 184, 0.36);
      box-shadow: none;
    }

    button.secondary:hover {
      border-color: var(--accent);
      color: #fff;
    }

    button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none !important;
      box-shadow: none !important;
    }

    .status {
      font-size: 0.95rem;
      color: var(--text-muted);
    }

    .summary {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      margin-top: 12px;
    }

    .summary-card {
      padding: 16px;
      border-radius: 14px;
      border: 1px solid rgba(148, 163, 184, 0.2);
      background: rgba(15, 23, 42, 0.6);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .summary-card span:first-child {
      font-size: 0.8rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    .summary-card strong {
      font-size: 1.35rem;
    }

    .table-container {
      overflow-x: auto;
      border-radius: 18px;
      border: 1px solid var(--panel-border);
      background: rgba(15, 23, 42, 0.7);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 720px;
    }

    thead {
      background: rgba(15, 23, 42, 0.74);
    }

    th,
    td {
      padding: 14px 18px;
      text-align: left;
      border-bottom: 1px solid rgba(148, 163, 184, 0.18);
      font-size: 0.95rem;
    }

    tbody tr:hover {
      background: rgba(30, 64, 175, 0.2);
    }

    .badge {
      display: inline-flex;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(59, 130, 246, 0.2);
      color: #bae6fd;
      font-size: 0.75rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      font-weight: 600;
    }

    .badge-bullish {
      background: rgba(74, 222, 128, 0.22);
      color: #bbf7d0;
    }

    .badge-bearish {
      background: rgba(248, 113, 113, 0.22);
      color: #fecaca;
    }

    .badge-neutral {
      background: rgba(148, 163, 184, 0.28);
      color: #f8fafc;
    }

    .badge-sweep {
      background: rgba(16, 185, 129, 0.22);
      color: #bbf7d0;
    }

    .cell-inline {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .ticker {
      font-weight: 700;
      letter-spacing: 0.05em;
      font-size: 1.05rem;
    }

    .pager {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 20px;
    }

    .pager-info {
      color: var(--text-muted);
      font-size: 0.9rem;
    }

    .empty-state {
      padding: 60px 24px;
      text-align: center;
      color: var(--text-muted);
    }

    @media (max-width: 720px) {
      body {
        padding: 24px 14px;
      }

      .panel {
        padding: 20px;
      }

      th,
      td {
        padding: 12px;
      }
    }
  </style>
</head>
<body>
  <main class="app">
    <header>
      <h1>Unusual Options Activity Radar</h1>
      <p>Scan the latest flow in real-time. Apply filters, spotlight premium trades, and explore sentiment without leaving this page.</p>
    </header>

    <section class="panel">
      <form id="filters">
        <div class="filters">
          <label>Tickers
            <input type="text" name="tickers" placeholder="AAPL, TSLA" autocomplete="off">
          </label>
          <label>Sentiment
            <select name="sentiment">
              <option value="">Any</option>
              <option value="bullish">Bullish</option>
              <option value="bearish">Bearish</option>
              <option value="neutral">Neutral</option>
            </select>
          </label>
          <label>Minimum Premium ($)
            <input type="number" name="min_premium" min="0" step="1000" placeholder="50000">
          </label>
          <label>From Date
            <input type="date" name="date_from">
          </label>
          <label>To Date
            <input type="date" name="date_to">
          </label>
          <div class="checkbox-field">
            <span class="checkbox-caption">Sweep Focus</span>
            <div class="checkbox-control">
              <input type="checkbox" name="sweep_only" id="sweep_only">
              <label for="sweep_only">Sweep only</label>
            </div>
          </div>
        </div>

        <div class="controls">
          <div class="controls-left">
            <button type="submit">Scan Flow</button>
            <button type="button" class="secondary" id="resetBtn">Reset</button>
          </div>
          <div class="status" id="status">Ready to scan.</div>
        </div>
      </form>

      <div class="summary" id="summary" hidden>
        <div class="summary-card">
          <span>Total Results</span>
          <strong id="summary-count">0</strong>
        </div>
        <div class="summary-card">
          <span>Highlighted Premium</span>
          <strong id="summary-premium">$0</strong>
        </div>
        <div class="summary-card">
          <span>Bullish vs Bearish</span>
          <strong id="summary-sentiment">0 / 0</strong>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="table-container" id="tableWrapper">
        <table>
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Sentiment</th>
              <th>Type</th>
              <th>Premium</th>
              <th>Strike</th>
              <th>Expiry</th>
              <th>Trade Price</th>
              <th>Qty</th>
              <th>Time</th>
              <th>Underlying</th>
            </tr>
          </thead>
          <tbody id="results">
            <tr><td colspan="10" class="empty-state">Run a scan to explore live option flow.</td></tr>
          </tbody>
        </table>
      </div>
      <div class="pager" id="pager" hidden>
        <button type="button" class="secondary" id="prevPage">Previous</button>
        <div class="pager-info" id="pagerInfo"></div>
        <button type="button" class="secondary" id="nextPage">Next</button>
      </div>
    </section>
  </main>

  <script>
    const form = document.getElementById('filters');
    const status = document.getElementById('status');
    const summary = document.getElementById('summary');
    const summaryCount = document.getElementById('summary-count');
    const summaryPremium = document.getElementById('summary-premium');
    const summarySentiment = document.getElementById('summary-sentiment');
    const resultsBody = document.getElementById('results');
    const pager = document.getElementById('pager');
    const pagerInfo = document.getElementById('pagerInfo');
    const prevPageBtn = document.getElementById('prevPage');
    const nextPageBtn = document.getElementById('nextPage');
    const resetBtn = document.getElementById('resetBtn');

    let page = 1;
    const pageSize = 25;

    async function fetchFlow(requestedPage = 1) {
      page = requestedPage;
      const params = new URLSearchParams();
      const formData = new FormData(form);

      const tickers = (formData.get('tickers') || '').trim();
      if (tickers) params.set('tickers', tickers.replace(/\s+/g, ''));

      const sentiment = formData.get('sentiment');
      if (sentiment) params.set('sentiment', sentiment);

      const minPremium = formData.get('min_premium');
      if (minPremium) params.set('min_premium', minPremium);

      const dateFrom = formData.get('date_from');
      if (dateFrom) params.set('date_from', dateFrom);

      const dateTo = formData.get('date_to');
      if (dateTo) params.set('date_to', dateTo);

      if (formData.get('sweep_only')) params.set('sweep_only', 'true');

      params.set('page', String(page));
      params.set('page_size', String(pageSize));

      status.textContent = 'Scanning the tape…';
      pager.hidden = true;

      try {
        const res = await fetch('/api/uoa?' + params.toString());
        if (!res.ok) throw new Error('API responded with ' + res.status);
        const data = await res.json();
        renderResults(data);
      } catch (error) {
        status.textContent = 'Something went wrong: ' + error.message;
        resultsBody.innerHTML = '<tr><td colspan="10" class="empty-state">Unable to load data.</td></tr>';
        summary.hidden = true;
      }
    }

    function renderResults(payload) {
      const rows = Array.isArray(payload?.results) ? payload.results : [];
      const currentPage = Number(payload?.page) || page;
      if (!rows.length) {
        resultsBody.innerHTML = '<tr><td colspan="10" class="empty-state">No flow matched your filters. Try broadening them.</td></tr>';
        pager.hidden = true;
        summary.hidden = true;
        status.textContent = 'No matches found. Tweak your filters and try again.';
        return;
      }

      resultsBody.innerHTML = rows.map((row) => {
        const sentiment = (row.side || '').toLowerCase();
        const sentimentClassMap = { bullish: 'badge-bullish', bearish: 'badge-bearish', neutral: 'badge-neutral' };
        const sentimentClass = sentimentClassMap[sentiment] || '';
        const sentimentClassSuffix = sentimentClass ? ' ' + sentimentClass : '';
        const normalizedSide = row.side ? String(row.side).toUpperCase() : '';
        const sentimentBadge = row.side
          ? '<span class="badge' + sentimentClassSuffix + '">' + escapeHtml(normalizedSide) + '</span>'
          : '';
        const sweepBadge = row.sweep ? '<span class="badge badge-sweep">Sweep</span>' : '';
        return '<tr>' +
            '<td><span class="cell-inline"><span class="ticker">' + escapeHtml(row.ticker || '-') + '</span>' + sweepBadge + '</span></td>' +
            '<td>' + sentimentBadge + '</td>' +
            '<td>' + escapeHtml(row.type || '-') + '</td>' +
            '<td>' + formatCurrency(row.premium) + '</td>' +
            '<td>' + formatNumber(row.strike) + '</td>' +
            '<td>' + escapeHtml(row.expiry || '-') + '</td>' +
            '<td>' + formatCurrency(row.trade_price) + '</td>' +
            '<td>' + formatNumber(row.quantity) + '</td>' +
            '<td>' + escapeHtml(row.time || '-') + '</td>' +
            '<td>' + formatCurrency(row.underlying_price) + '</td>' +
          '</tr>';
      }).join('');

      pager.hidden = false;
      const totalLabel = typeof payload?.count === 'number' ? ' of ' + payload.count : '';
      pagerInfo.textContent = 'Page ' + currentPage + ' • Showing ' + rows.length + totalLabel + ' results';
      prevPageBtn.disabled = currentPage <= 1;
      nextPageBtn.disabled = rows.length < pageSize;

      const totals = rows.reduce((acc, row) => {
        acc.premium += Number(row.premium || 0);
        if ((row.side || '').toLowerCase() === 'bullish') acc.bullish += 1;
        if ((row.side || '').toLowerCase() === 'bearish') acc.bearish += 1;
        return acc;
      }, { premium: 0, bullish: 0, bearish: 0 });

      summaryCount.textContent = typeof payload?.count === 'number' ? payload.count : rows.length;
      summaryPremium.textContent = formatCurrency(totals.premium);
      summarySentiment.textContent = totals.bullish + ' / ' + totals.bearish;
      summary.hidden = false;
      status.textContent = 'Loaded fresh flow. Tap next to continue exploring.';
    }

    function formatCurrency(value) {
      const number = Number(value || 0);
      return number.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    }

    function formatNumber(value) {
      const number = Number(value || 0);
      return number ? number.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '-';
    }

    function escapeHtml(value) {
      const replacements = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      };
      return String(value ?? '').replace(/[&<>'"]+/g, (match) => replacements[match] ?? match);
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      fetchFlow(1);
    });

    prevPageBtn.addEventListener('click', () => {
      if (page > 1) fetchFlow(page - 1);
    });

    nextPageBtn.addEventListener('click', () => {
      fetchFlow(page + 1);
    });

    resetBtn.addEventListener('click', () => {
      form.reset();
      page = 1;
      status.textContent = 'Ready to scan.';
      summary.hidden = true;
      resultsBody.innerHTML = '<tr><td colspan="10" class="empty-state">Run a scan to explore live option flow.</td></tr>';
      pager.hidden = true;
    });

    fetchFlow(1);
  </script>
</body>
</html>`;
}
// Cloudflare Worker code goes here (see previous full script)

addEventListener("fetch", (event) => {
  event.respondWith(handleFetch(event.request, event.target ?? {}, event));
});
