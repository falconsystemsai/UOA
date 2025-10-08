
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
  const minPremiumRaw = params.get("min_premium") ?? params.get("min_total_trade_value");
  const minPremiumFilter = normalizeNumericFilter(minPremiumRaw);
  const minPremium = minPremiumFilter?.textValue;
  const sweepOnlyParam = params.get("sweep_only") ?? params.get("sweepOnly") ?? "false";
  const sweepOnly = String(sweepOnlyParam).toLowerCase() === "true";
  const volumeGtOiParam =
    params.get("volume_gt_oi") ?? params.get("volumeGtOi") ?? params.get("size_gt_oi") ?? "false";
  const volumeGtOi = String(volumeGtOiParam).toLowerCase() === "true";
  const aggressiveBuyOnlyParam = params.get("aggressive_buy_only") ?? params.get("aggressiveBuyOnly") ?? "false";
  const aggressiveBuyOnly = String(aggressiveBuyOnlyParam).toLowerCase() === "true";
  const aggressiveSellOnlyParam = params.get("aggressive_sell_only") ?? params.get("aggressiveSellOnly") ?? "false";
  const aggressiveSellOnly = String(aggressiveSellOnlyParam).toLowerCase() === "true";
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
    tickers,
    sentiment,
    minPremium,
    sweepOnly,
    page,
    pageSize,
    dateFrom,
    dateTo
  });

  if (!env.BENZINGA_API_KEY) {
    return json({ error: "Missing BENZINGA_API_KEY secret" }, 500, corsHeaders());
  }

  const cache = caches.default;
  const cacheKeyUrl = new URL(apiUrl.toString());
  cacheKeyUrl.searchParams.set("volume_gt_oi", volumeGtOi ? "true" : "false");
  cacheKeyUrl.searchParams.set("aggressive_buy_only", aggressiveBuyOnly ? "true" : "false");
  cacheKeyUrl.searchParams.set("aggressive_sell_only", aggressiveSellOnly ? "true" : "false");
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" });
  const ttl = parseInt(env.CACHE_TTL_SECONDS || "30", 10);

  let res = await cache.match(cacheKey);
  if (!res) {
    const upstream = await fetch(apiUrl.toString(), {
      cf: { cacheTtl: 0, cacheEverything: false },
      headers: buildBenzingaHeaders(env)
    });
    const data = await upstream.json().catch(() => ({ error: "Upstream decode failed" }));
    const normalized = upstream.ok ? normalizeBenzingaPayload(data) : [];
    const minPremiumValue = minPremiumFilter?.numericValue;
    const hasMinPremiumFilter = Number.isFinite(minPremiumValue);
    const premiumFiltered = hasMinPremiumFilter
      ? normalized.filter((row) => Number.isFinite(row.premium) && row.premium >= minPremiumValue)
      : normalized;
    const volumeFiltered = volumeGtOi
      ? premiumFiltered.filter((row) => {
          const quantity = Number(row.quantity);
          const openInterest = Number(row.open_interest);
          return Number.isFinite(quantity) && Number.isFinite(openInterest) && quantity > openInterest;
        })
      : premiumFiltered;

    const aggressionFiltered = volumeFiltered.filter((row) => {
      const posInSpread = Number(
        row?.pos_in_spread ??
          row?.position_in_spread ??
          row?.posInSpread ??
          row?.positionInSpread
      );
      const hasPosInSpread = Number.isFinite(posInSpread);
      const meetsAggressiveBuy = Boolean(row?.aggressive_buy) || row?.at_or_above_ask === true ||
        (hasPosInSpread && posInSpread >= 0.75);
      const meetsAggressiveSell = Boolean(row?.aggressive_sell) || row?.at_or_below_bid === true ||
        (hasPosInSpread && posInSpread <= 0.25);

      if (aggressiveBuyOnly && aggressiveSellOnly) {
        return meetsAggressiveBuy || meetsAggressiveSell;
      }
      if (aggressiveBuyOnly) {
        return meetsAggressiveBuy;
      }
      if (aggressiveSellOnly) {
        return meetsAggressiveSell;
      }
      return true;
    });

    const payload = upstream.ok
      ? {
          ok: true,
          source_status: upstream.status,
          page: Number(page),
          page_size: Number(pageSize),
          count: aggressionFiltered.length,
          results: aggressionFiltered
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

function normalizeNumericFilter(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }

  const cleaned = trimmed.replace(/[^0-9.+-]/g, "");
  if (!cleaned || /^[-+]?$/u.test(cleaned)) {
    return null;
  }

  const numericValue = Number(cleaned);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return { numericValue, textValue: cleaned };
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
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.option_activity)
    ? data.option_activity
    : Array.isArray(data?.data?.option_activity)
    ? data.data.option_activity
    : Array.isArray(data?.data)
    ? data.data
    : [];

  return rows.map((row) => {
    const ticker = row?.ticker || row?.symbol || row?.underlying_symbol || row?.underlying_ticker || "";
    const type = row?.put_call || row?.option_type || "";
    const side = row?.sentiment || row?.side || "";
    const sweepValue = row?.sweep ?? row?.is_sweep ?? row?.order_type ?? row?.option_activity_type;
    const sweep = typeof sweepValue === "boolean"
      ? sweepValue
      : typeof sweepValue === "string"
      ? sweepValue.toLowerCase().includes("sweep")
      : false;
    const premium = Number(
      row?.cost_basis ??
        row?.total_trade_value ??
        row?.total_cost ??
        row?.premium ??
        row?.notional_value ??
        row?.notional ??
        0
    );
    const tradePrice = Number(row?.price ?? row?.trade_price ?? row?.fill_price ?? 0);
    const quantity = Number(row?.size ?? row?.quantity ?? row?.volume ?? 0);
    const openInterest = Number(
      row?.open_interest ??
        row?.open_interest_prior ??
        row?.previous_open_interest ??
        row?.openInterest ??
        row?.oi ??
        0
    );
    const strike = Number(row?.strike_price ?? row?.strike ?? 0);
    const expiry = row?.date_expiration || row?.expiration_date || row?.expiry || "";
    const date = row?.date || row?.trade_date || "";
    const time = row?.time || row?.trade_time || "";
    const timeDisplay = buildDisplayTime(date, time, row?.updated);
    const iv = Number(row?.iv ?? row?.implied_volatility ?? 0);
    const underlyingPrice = Number(
      row?.underlying_price ?? row?.underlying_price_last ?? row?.underlying_last ?? 0
    );
    const id =
      row?.id ||
      row?.identifier ||
      row?.option_symbol ||
      `${ticker || "flow"}-${time || row?.updated || Date.now()}`;

    const posInSpreadCandidates = [
      row?.pos_in_spread,
      row?.posInSpread,
      row?.position_in_spread,
      row?.positionInSpread
    ];
    const posInSpread = extractFirstFiniteNumber(posInSpreadCandidates);

    const priceRelationCandidates = [
      row?.price_relation,
      row?.price_relation_description,
      row?.price_level,
      row?.priceLevel,
      row?.trade_price_relation,
      row?.tradePriceRelation,
      row?.trade_at,
      row?.tradeAt,
      row?.price_condition,
      row?.priceCondition,
      row?.price_condition_detail,
      row?.priceConditionDetail
    ];
    const priceRelation = extractFirstString(priceRelationCandidates);
    const priceRelationLower = priceRelation.toLowerCase();

    const aggressorIndicatorCandidates = [
      row?.aggressor_ind,
      row?.aggressor_indicator,
      row?.aggressorIndicator,
      row?.aggressorInd,
      row?.execution_side,
      row?.executionSide,
      row?.trade_side,
      row?.tradeSide,
      row?.price_at_execution,
      row?.priceAtExecution
    ];
    const aggressorIndicator = extractFirstAggressorIndicator(aggressorIndicatorCandidates);
    const aggressorIsAggressiveBuy = isAggressiveBuyIndicator(aggressorIndicator);
    const aggressorIsAggressiveSell = isAggressiveSellIndicator(aggressorIndicator);

    const atOrAboveAskCandidates = [
      row?.at_or_above_ask,
      row?.atOrAboveAsk,
      row?.at_ask,
      row?.atAsk,
      row?.above_ask,
      row?.aboveAsk,
      row?.is_at_ask,
      row?.isAtAsk,
      row?.is_above_ask,
      row?.isAboveAsk
    ];
    const atOrBelowBidCandidates = [
      row?.at_or_below_bid,
      row?.atOrBelowBid,
      row?.at_bid,
      row?.atBid,
      row?.below_bid,
      row?.belowBid,
      row?.is_at_bid,
      row?.isAtBid,
      row?.is_below_bid,
      row?.isBelowBid
    ];

    let atOrAboveAsk = extractFirstBoolean(atOrAboveAskCandidates);
    let atOrBelowBid = extractFirstBoolean(atOrBelowBidCandidates);

    if (!atOrAboveAsk && aggressorIsAggressiveBuy) {
      atOrAboveAsk = true;
    }

    if (!atOrBelowBid && aggressorIsAggressiveSell) {
      atOrBelowBid = true;
    }

    if (!atOrAboveAsk && priceRelationLower) {
      if (
        priceRelationLower.includes("at ask") ||
        priceRelationLower.includes("above ask") ||
        priceRelationLower.includes("ask side") ||
        priceRelationLower.includes("over ask") ||
        priceRelationLower.includes("take ask")
      ) {
        atOrAboveAsk = true;
      }
    }

    if (!atOrBelowBid && priceRelationLower) {
      if (
        priceRelationLower.includes("at bid") ||
        priceRelationLower.includes("below bid") ||
        priceRelationLower.includes("bid side") ||
        priceRelationLower.includes("under bid") ||
        priceRelationLower.includes("hit bid")
      ) {
        atOrBelowBid = true;
      }
    }

    const aggressiveBuy = Boolean(atOrAboveAsk) || (Number.isFinite(posInSpread) && posInSpread >= 0.75);
    const aggressiveSell = Boolean(atOrBelowBid) || (Number.isFinite(posInSpread) && posInSpread <= 0.25);

    return {
      id,
      ticker,
      type,
      side,
      sweep: Boolean(sweep),
      premium,
      trade_price: tradePrice,
      quantity,
      strike,
      expiry,
      time: timeDisplay,
      iv,
      underlying_price: underlyingPrice,
      open_interest: openInterest,
      pos_in_spread: Number.isFinite(posInSpread) ? posInSpread : null,
      price_relation: priceRelation,
      at_or_above_ask: Boolean(atOrAboveAsk),
      at_or_below_bid: Boolean(atOrBelowBid),
      aggressive_buy: aggressiveBuy,
      aggressive_sell: aggressiveSell,
      aggressor_indicator: aggressorIndicator || null
    };
  });
}

function extractFirstAggressorIndicator(candidates) {
  for (const value of candidates) {
    const normalized = normalizeAggressorIndicator(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function normalizeAggressorIndicator(value) {
  if (value === undefined || value === null) {
    return "";
  }

  const text = String(value).trim();
  if (!text) {
    return "";
  }

  const normalized = text
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toUpperCase();

  if (!normalized) {
    return "";
  }

  const mapping = {
    ATASK: "AT_ASK",
    ASK: "AT_ASK",
    AT_OR_ABOVE_ASK: "AT_ASK",
    OVER_ASK: "ABOVE_ASK",
    ABOVEASK: "ABOVE_ASK",
    ABOVE_THE_ASK: "ABOVE_ASK",
    LIFT: "AT_ASK",
    LIFT_ASK: "AT_ASK",
    TAKE: "AT_ASK",
    TAKE_ASK: "AT_ASK",
    ATBID: "AT_BID",
    BID: "AT_BID",
    HIT_BID: "AT_BID",
    AT_OR_BELOW_BID: "AT_BID",
    UNDER_BID: "BELOW_BID",
    BELOWBID: "BELOW_BID",
    BELOW_THE_BID: "BELOW_BID",
    SELLER: "AT_BID",
    BUYER: "AT_ASK",
    MID: "AT_MIDPOINT",
    ATMID: "AT_MIDPOINT",
    AT_MID: "AT_MIDPOINT",
    ATMIDPOINT: "AT_MIDPOINT"
  };

  return mapping[normalized] || normalized;
}

const AGGRESSIVE_BUY_INDICATORS = new Set([
  "AT_ASK",
  "ABOVE_ASK",
  "AT_OR_ABOVE_ASK",
  "OVER_ASK",
  "BUYER"
]);

const AGGRESSIVE_SELL_INDICATORS = new Set([
  "AT_BID",
  "BELOW_BID",
  "AT_OR_BELOW_BID",
  "UNDER_BID",
  "SELLER",
  "HIT_BID"
]);

function isAggressiveBuyIndicator(value) {
  if (!value) {
    return false;
  }
  const normalized = normalizeAggressorIndicator(value);
  return AGGRESSIVE_BUY_INDICATORS.has(normalized);
}

function isAggressiveSellIndicator(value) {
  if (!value) {
    return false;
  }
  const normalized = normalizeAggressorIndicator(value);
  return AGGRESSIVE_SELL_INDICATORS.has(normalized);
}

function extractFirstFiniteNumber(candidates) {
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
    if (typeof value === "string") {
      const cleaned = value.replace(/[^0-9.+-]/g, "");
      if (cleaned) {
        const parsed = Number(cleaned);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
  }
  return null;
}

function extractFirstString(candidates) {
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function extractFirstBoolean(candidates) {
  for (const value of candidates) {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (!normalized) continue;
      if (["true", "t", "yes", "y", "1"].includes(normalized)) {
        return true;
      }
      if (["false", "f", "no", "n", "0"].includes(normalized)) {
        return false;
      }
    }
  }
  return false;
}

function buildDisplayTime(date, time, updated) {
  if (date && time) {
    return `${date} ${time}`.trim();
  }
  if (time) {
    return time;
  }
  if (date) {
    return date;
  }
  const epochSeconds = Number(updated);
  if (!epochSeconds) {
    return "";
  }
  const ms = epochSeconds > 1e12 ? epochSeconds : epochSeconds * 1000;
  const dateObj = new Date(ms);
  if (Number.isNaN(dateObj.getTime())) {
    return "";
  }
  return dateObj.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
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
      --bg-gradient:
        radial-gradient(circle at 12% 12%, rgba(147, 51, 234, 0.95) 0%, rgba(15, 23, 42, 0.92) 45%),
        radial-gradient(circle at 88% 8%, rgba(236, 72, 153, 0.85) 0%, rgba(15, 23, 42, 0.94) 55%),
        linear-gradient(160deg, #0f172a, #020617 70%);
      --panel-bg: rgba(15, 23, 42, 0.78);
      --panel-border: rgba(236, 72, 153, 0.28);
      --accent: #f472b6;
      --accent-strong: #e11d48;
      --text-muted: rgba(248, 250, 252, 0.72);
      --glow: rgba(236, 72, 153, 0.4);
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
      position: relative;
      overflow-x: hidden;
      overflow-y: auto;
    }

    body::before,
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      mix-blend-mode: screen;
      opacity: 0.85;
      transform-origin: center;
      animation: pulse 16s ease-in-out infinite;
      z-index: 0;
    }

    body::before {
      background:
        radial-gradient(circle at 20% 20%, rgba(236, 72, 153, 0.22), transparent 45%),
        radial-gradient(circle at 80% 15%, rgba(129, 140, 248, 0.24), transparent 40%);
    }

    body::after {
      background:
        radial-gradient(circle at 50% 85%, rgba(244, 114, 182, 0.18), transparent 48%),
        linear-gradient(120deg, rgba(56, 189, 248, 0.14), transparent 65%);
      animation-delay: -8s;
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
      position: relative;
      z-index: 1;
    }

    h1 {
      font-size: clamp(2rem, 4vw, 2.8rem);
      margin: 0;
      letter-spacing: 0.04em;
      color: #fde4ff;
      background: linear-gradient(115deg, #f472b6 0%, #c084fc 45%, #38bdf8 100%);
      -webkit-background-clip: text;
      color: transparent;
      text-shadow: 0 18px 42px rgba(236, 72, 153, 0.45);
    }

    header p {
      margin: 0;
      max-width: 720px;
      line-height: 1.6;
      color: var(--text-muted);
      position: relative;
      z-index: 1;
    }

    header::after {
      content: "";
      position: absolute;
      left: 0;
      bottom: -10px;
      width: 160px;
      height: 2px;
      background: linear-gradient(90deg, transparent, rgba(244, 114, 182, 0.8), transparent);
    }

    .panel {
      border-radius: 18px;
      border: 1px solid var(--panel-border);
      background: var(--panel-bg);
      box-shadow: 0 35px 60px rgba(15, 23, 42, 0.55), 0 0 35px rgba(236, 72, 153, 0.18);
      backdrop-filter: blur(14px);
      padding: 24px;
      position: relative;
      overflow: hidden;
    }

    .panel::before {
      content: "";
      position: absolute;
      inset: -2px;
      border-radius: inherit;
      background: linear-gradient(140deg, rgba(236, 72, 153, 0.45), rgba(56, 189, 248, 0.25));
      opacity: 0.35;
      filter: blur(12px);
      z-index: 0;
      transition: opacity 0.3s ease;
    }

    .panel:hover::before {
      opacity: 0.55;
    }

    .panel > * {
      position: relative;
      z-index: 1;
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
      border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(15, 23, 42, 0.68);
      color: #f8fafc;
      padding: 12px;
      font-size: 1rem;
      transition: border 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
    }

    input:focus,
    select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(244, 114, 182, 0.28);
      transform: translateY(-1px);
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
      transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease, filter 0.2s ease;
      background: linear-gradient(135deg, var(--accent), var(--accent-strong));
      color: #0f172a;
      box-shadow: 0 18px 28px rgba(236, 72, 153, 0.35);
    }

    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 24px 42px rgba(236, 72, 153, 0.45);
      filter: brightness(1.05);
    }

    button.secondary {
      background: rgba(15, 23, 42, 0.7);
      color: var(--text-muted);
      border: 1px solid rgba(236, 72, 153, 0.32);
      box-shadow: none;
    }

    button.secondary:hover {
      border-color: var(--accent);
      color: #fff;
      box-shadow: 0 12px 28px rgba(15, 23, 42, 0.4);
    }

    button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none !important;
      box-shadow: none !important;
    }

    .status {
      font-size: 0.95rem;
      color: rgba(244, 240, 255, 0.7);
      letter-spacing: 0.02em;
    }

    .summary {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      margin-top: 12px;
      position: relative;
      z-index: 1;
    }

    .summary-card {
      padding: 18px;
      border-radius: 16px;
      border: 1px solid rgba(244, 114, 182, 0.25);
      background: linear-gradient(140deg, rgba(15, 23, 42, 0.72), rgba(67, 56, 202, 0.35));
      display: flex;
      flex-direction: column;
      gap: 8px;
      box-shadow: 0 20px 36px rgba(15, 23, 42, 0.45);
      position: relative;
      overflow: hidden;
    }

    .summary-card span:first-child {
      font-size: 0.8rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    .summary-card strong {
      font-size: 1.45rem;
      color: #fdf4ff;
    }

    .table-container {
      overflow-x: auto;
      border-radius: 18px;
      border: 1px solid var(--panel-border);
      background: rgba(15, 23, 42, 0.62);
      box-shadow: inset 0 1px 0 rgba(236, 72, 153, 0.14);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 720px;
    }

    thead {
      background: linear-gradient(90deg, rgba(15, 23, 42, 0.88), rgba(30, 41, 59, 0.8));
    }

    th,
    td {
      padding: 14px 18px;
      text-align: left;
      border-bottom: 1px solid rgba(148, 163, 184, 0.18);
      font-size: 0.95rem;
    }

    tbody tr:hover {
      background: rgba(244, 114, 182, 0.18);
    }

    .badge {
      display: inline-flex;
      padding: 4px 10px;
      border-radius: 999px;
      background: linear-gradient(135deg, rgba(244, 114, 182, 0.25), rgba(129, 140, 248, 0.35));
      color: #fdf2f8;
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

    .badge-volume-dominant {
      background: rgba(248, 250, 252, 0.25);
      color: #facc15;
      box-shadow: 0 0 12px rgba(250, 204, 21, 0.35);
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

    @keyframes pulse {
      0%,
      100% {
        transform: scale(1);
        opacity: 0.65;
      }
      50% {
        transform: scale(1.04);
        opacity: 0.9;
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
          <div class="checkbox-field">
            <span class="checkbox-caption">Volume Signals</span>
            <div class="checkbox-control">
              <input type="checkbox" name="volume_gt_oi" id="volume_gt_oi">
              <label for="volume_gt_oi">Size &gt; Open Interest</label>
            </div>
          </div>
          <div class="checkbox-field">
            <span class="checkbox-caption">Aggression Filters</span>
            <div class="checkbox-control">
              <input type="checkbox" name="aggressive_buy_only" id="aggressive_buy_only">
              <label for="aggressive_buy_only">Aggressive buys only</label>
            </div>
            <div class="checkbox-control">
              <input type="checkbox" name="aggressive_sell_only" id="aggressive_sell_only">
              <label for="aggressive_sell_only">Aggressive sells only</label>
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
              <th>Open Interest</th>
              <th>Time</th>
              <th>Underlying</th>
            </tr>
          </thead>
          <tbody id="results">
            <tr><td colspan="11" class="empty-state">Run a scan to explore live option flow.</td></tr>
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
      if (formData.get('volume_gt_oi')) params.set('volume_gt_oi', 'true');
      if (formData.get('aggressive_buy_only')) params.set('aggressive_buy_only', 'true');
      if (formData.get('aggressive_sell_only')) params.set('aggressive_sell_only', 'true');

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
        resultsBody.innerHTML = '<tr><td colspan="11" class="empty-state">Unable to load data.</td></tr>';
        summary.hidden = true;
      }
    }

    function renderResults(payload) {
      const rows = Array.isArray(payload?.results) ? payload.results : [];
      const currentPage = Number(payload?.page) || page;
      if (!rows.length) {
        resultsBody.innerHTML = '<tr><td colspan="11" class="empty-state">No flow matched your filters. Try broadening them.</td></tr>';
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
        const quantityValue = Number(row.quantity || 0);
        const openInterestValue = Number(row.open_interest || 0);
        const oiBadge = quantityValue > openInterestValue && openInterestValue > 0
          ? '<span class="badge badge-volume-dominant">Vol &gt; OI</span>'
          : '';
        return '<tr>' +
            '<td><span class="cell-inline"><span class="ticker">' + escapeHtml(row.ticker || '-') + '</span>' + sweepBadge + '</span></td>' +
            '<td>' + sentimentBadge + '</td>' +
            '<td>' + escapeHtml(row.type || '-') + '</td>' +
            '<td>' + formatCurrency(row.premium) + '</td>' +
            '<td>' + formatNumber(row.strike) + '</td>' +
            '<td>' + escapeHtml(row.expiry || '-') + '</td>' +
            '<td>' + formatCurrency(row.trade_price) + '</td>' +
            '<td><span class="cell-inline">' + formatNumber(row.quantity) + oiBadge + '</span></td>' +
            '<td>' + formatNumber(row.open_interest) + '</td>' +
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
      const number = Number(value);
      if (!Number.isFinite(number)) {
        return '-';
      }
      if (number === 0) {
        return '0';
      }
      return number.toLocaleString(undefined, { maximumFractionDigits: 2 });
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
      resultsBody.innerHTML = '<tr><td colspan="11" class="empty-state">Run a scan to explore live option flow.</td></tr>';
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
