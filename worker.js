const EXCHANGES = new Set(["gate", "kucoin", "binance"]);
const LIMITS = new Set(["5", "10", "20", "50", "100"]);

function envValue(env, key, fallback = "") {
  return env && env[key] !== undefined ? String(env[key]) : fallback;
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  const raw = envValue(env, "ALLOWED_ORIGINS", "*");
  if (raw.trim() === "*") return { ok: true, origin: origin || "*" };
  const allowed = raw.split(",").map(x => x.trim()).filter(Boolean);
  if (!origin) return { ok: envValue(env, "ALLOW_DIRECT", "true") === "true", origin: allowed[0] || "*" };
  return { ok: allowed.includes(origin), origin };
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" }
  });
}

function normalizeExchange(exchange, env) {
  exchange = String(exchange || envValue(env, "DEFAULT_EXCHANGE", "gate")).toLowerCase();
  return EXCHANGES.has(exchange) ? exchange : "gate";
}

function normalizePair(pair, exchange, env) {
  pair = String(pair || envValue(env, "DEFAULT_PAIR", "EQTY_USDT")).trim().toUpperCase();
  if (!pair) pair = exchange === "binance" ? "BTCUSDT" : exchange === "kucoin" ? "EQTY-USDT" : "EQTY_USDT";
  if (exchange === "gate") return pair.replace(/[-/]/g, "_");
  if (exchange === "kucoin") return pair.replace(/[_/]/g, "-");
  if (exchange === "binance") return pair.replace(/[-_/]/g, "");
  return pair;
}

function validatePair(pair, exchange) {
  if (exchange === "gate") return /^[A-Z0-9]+_[A-Z0-9]+$/.test(pair);
  if (exchange === "kucoin") return /^[A-Z0-9]+-[A-Z0-9]+$/.test(pair);
  if (exchange === "binance") return /^[A-Z0-9]{5,30}$/.test(pair);
  return false;
}

function displayPair(pair) {
  return pair.includes("_") ? pair.replace("_", "/") : pair.includes("-") ? pair.replace("-", "/") : pair;
}

function clampLimit(limit) {
  limit = String(limit || "100");
  return LIMITS.has(limit) ? limit : "100";
}

async function fetchOrderbook(exchange, pair, limit) {
  let url;
  if (exchange === "gate") {
    url = "https://api.gateio.ws/api/v4/spot/order_book" +
      "?currency_pair=" + encodeURIComponent(pair) +
      "&interval=0&limit=" + encodeURIComponent(limit) +
      "&with_id=true";
  } else if (exchange === "kucoin") {
    const endpoint = Number(limit) <= 20 ? "level2_20" : "level2_100";
    url = "https://api.kucoin.com/api/v1/market/orderbook/" + endpoint +
      "?symbol=" + encodeURIComponent(pair);
  } else if (exchange === "binance") {
    url = "https://api.binance.com/api/v3/depth" +
      "?symbol=" + encodeURIComponent(pair) +
      "&limit=" + encodeURIComponent(limit);
  } else {
    throw new Error("Unsupported exchange");
  }

  const resp = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "crypto-orderbook-depth-viewer/1.0"
    }
  });
  const body = await resp.json();
  if (!resp.ok) return { status: resp.status, body };

  if (exchange === "gate") {
    return {
      status: 200,
      body: {
        exchange, pair, displayPair: displayPair(pair),
        bids: body.bids || [], asks: body.asks || [],
        timestamp: Number(body.current || body.update || Date.now()),
        orderbookId: body.id
      }
    };
  }

  if (exchange === "kucoin") {
    if (body.code && body.code !== "200000") return { status: 502, body };
    const data = body.data || {};
    return {
      status: 200,
      body: {
        exchange, pair, displayPair: displayPair(pair),
        bids: data.bids || [], asks: data.asks || [],
        timestamp: Number(data.time || Date.now()),
        orderbookId: data.sequence
      }
    };
  }

  if (exchange === "binance") {
    return {
      status: 200,
      body: {
        exchange, pair, displayPair: displayPair(pair),
        bids: body.bids || [], asks: body.asks || [],
        timestamp: Date.now(),
        orderbookId: body.lastUpdateId
      }
    };
  }
}

async function fetchMarkets(exchange) {
  if (exchange === "gate") {
    const resp = await fetch("https://api.gateio.ws/api/v4/spot/currency_pairs", { headers: { Accept: "application/json" } });
    const data = await resp.json();
    const markets = (Array.isArray(data) ? data : []).map(m => ({
      exchange,
      id: m.id,
      base: m.base,
      quote: m.quote,
      tradeStatus: m.trade_status
    })).filter(m => m.id && (!m.tradeStatus || m.tradeStatus === "tradable"));
    return markets;
  }

  if (exchange === "kucoin") {
    const resp = await fetch("https://api.kucoin.com/api/v1/symbols", { headers: { Accept: "application/json" } });
    const data = await resp.json();
    const arr = data.data || [];
    return arr.map(m => ({
      exchange,
      id: m.symbol,
      base: m.baseCurrency,
      quote: m.quoteCurrency,
      tradeStatus: m.enableTrading ? "tradable" : "disabled"
    })).filter(m => m.id && m.tradeStatus === "tradable");
  }

  if (exchange === "binance") {
    const resp = await fetch("https://api.binance.com/api/v3/exchangeInfo", { headers: { Accept: "application/json" } });
    const data = await resp.json();
    const arr = data.symbols || [];
    return arr.map(m => ({
      exchange,
      id: m.symbol,
      base: m.baseAsset,
      quote: m.quoteAsset,
      tradeStatus: m.status
    })).filter(m => m.id && m.tradeStatus === "TRADING");
  }

  return [];
}

export default {
  async fetch(request, env) {
    const originCheck = allowedOrigin(request, env);
    const headers = corsHeaders(originCheck.origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (!originCheck.ok) {
      return json({ error: "Origin not allowed" }, 403, headers);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/orderbook";
    const exchange = normalizeExchange(url.searchParams.get("exchange"), env);

    try {
      if (path === "/health") {
        return json({ status: "ok", exchange }, 200, headers);
      }

      if (path === "/markets") {
        const markets = await fetchMarkets(exchange);
        return json({ exchange, markets }, 200, headers);
      }

      if (path === "/orderbook" || path === "/") {
        const pair = normalizePair(url.searchParams.get("pair"), exchange, env);
        const limit = clampLimit(url.searchParams.get("limit"));
        if (!validatePair(pair, exchange)) {
          return json({ error: "Invalid pair format for exchange", exchange, pair }, 400, headers);
        }
        const result = await fetchOrderbook(exchange, pair, limit);
        return json(result.body, result.status, headers);
      }

      return json({ error: "Not found. Use /orderbook, /markets, or /health." }, 404, headers);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 502, headers);
    }
  }
};
