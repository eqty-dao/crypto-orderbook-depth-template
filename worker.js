const EXCHANGES = new Set(["gate", "kucoin", "binance"]);
const LIMITS = new Set(["5", "10", "20", "50", "100"]);

const BINANCE_BASES = [
  "https://data-api.binance.vision",
  "https://api-gcp.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com",
  "https://api.binance.com"
];

async function fetchJsonFromUrls(urls) {
  const errors = [];

  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "crypto-orderbook-depth-viewer/1.0"
        }
      });

      const text = await resp.text();
      let body;

      try {
        body = JSON.parse(text);
      } catch (e) {
        errors.push({
          url,
          status: resp.status,
          contentType: resp.headers.get("content-type") || "",
          bodyStart: text.slice(0, 160)
        });
        continue;
      }

if (!resp.ok) {
  errors.push({
    url,
    status: resp.status,
    headers: {
      retryAfter: resp.headers.get("retry-after"),
      gwLimit: resp.headers.get("gw-ratelimit-limit"),
      gwRemaining: resp.headers.get("gw-ratelimit-remaining"),
      gwReset: resp.headers.get("gw-ratelimit-reset")
    },
    body
  });
  continue;
}
      return {
        ok: true,
        status: resp.status,
        body,
        url
      };
    } catch (e) {
      errors.push({
        url,
        error: String(e && e.message ? e.message : e)
      });
    }
  }

  return {
    ok: false,
    status: 502,
    body: {
      error: "All upstream API endpoints failed or returned non-JSON",
      upstreamErrors: errors.slice(0, 8)
    }
  };
}

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

async function fetchOrderbook(exchange, pair, limit, env) {
  let urls;
  let usedKucoinProxy = false;

  if (exchange === "gate") {
    urls = [
      "https://api.gateio.ws/api/v4/spot/order_book" +
      "?currency_pair=" + encodeURIComponent(pair) +
      "&interval=0&limit=" + encodeURIComponent(limit) +
      "&with_id=true"
    ];
  } else if (exchange === "kucoin") {
    const kucoinProxy = envValue(env, "KUCOIN_PROXY_URL", "").replace(/\/$/, "");

    if (kucoinProxy) {
      usedKucoinProxy = true;
      urls = [
        kucoinProxy +
        "/orderbook?pair=" + encodeURIComponent(pair) +
        "&limit=" + encodeURIComponent(limit)
      ];
    } else {
      const endpoint = Number(limit) <= 20 ? "level2_20" : "level2_100";
      urls = [
        "https://api.kucoin.com/api/v1/market/orderbook/" + endpoint +
        "?symbol=" + encodeURIComponent(pair)
      ];
    }
  } else if (exchange === "binance") {
    urls = BINANCE_BASES.map(base =>
      base + "/api/v3/depth" +
      "?symbol=" + encodeURIComponent(pair) +
      "&limit=" + encodeURIComponent(limit)
    );
  } else {
    throw new Error("Unsupported exchange");
  }

  const upstream = await fetchJsonFromUrls(urls);

  if (!upstream.ok && exchange === "kucoin") {
    const first = upstream.body && upstream.body.upstreamErrors
      ? upstream.body.upstreamErrors[0]
      : null;

    if (first && first.status === 429) {
      return {
        status: 429,
        body: {
          error: "KuCoin rate-limited the Worker upstream IP. Try again after the reset time or set KUCOIN_PROXY_URL.",
          exchange,
          pair,
          upstreamStatus: 429,
          resetMs: first.headers && first.headers.gwReset ? Number(first.headers.gwReset) : null,
          remaining: first.headers && first.headers.gwRemaining ? Number(first.headers.gwRemaining) : null,
          limit: first.headers && first.headers.gwLimit ? Number(first.headers.gwLimit) : null,
          upstream: first
        }
      };
    }
  }

  if (!upstream.ok) {
    return {
      status: upstream.status || 502,
      body: upstream.body
    };
  }

  const body = upstream.body;

  if (exchange === "gate") {
    return {
      status: 200,
      body: {
        exchange,
        pair,
        displayPair: displayPair(pair),
        bids: body.bids || [],
        asks: body.asks || [],
        timestamp: Number(body.current || body.update || Date.now()),
        orderbookId: body.id,
        upstreamUrl: upstream.url
      }
    };
  }

  if (exchange === "kucoin") {
    if (body.code && body.code !== "200000") {
      return {
        status: 502,
        body
      };
    }

    const data = body.data || body;

    return {
      status: 200,
      body: {
        exchange,
        pair,
        displayPair: displayPair(pair),
        bids: body.bids || data.bids || [],
        asks: body.asks || data.asks || [],
        timestamp: Number(body.timestamp || data.time || body.time || Date.now()),
        orderbookId: body.orderbookId || data.sequence || body.sequence,
        upstreamUrl: upstream.url,
        proxied: usedKucoinProxy
      }
    };
  }

  if (exchange === "binance") {
    return {
      status: 200,
      body: {
        exchange,
        pair,
        displayPair: displayPair(pair),
        bids: body.bids || [],
        asks: body.asks || [],
        timestamp: Date.now(),
        orderbookId: body.lastUpdateId,
        upstreamUrl: upstream.url
      }
    };
  }
}

async function fetchMarkets(exchange, env) {
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
  const kucoinProxy = envValue(env, "KUCOIN_PROXY_URL", "").replace(/\/$/, "");

  if (kucoinProxy) {
    const upstream = await fetchJsonFromUrls([
      kucoinProxy + "/markets"
    ]);

    if (!upstream.ok) {
      throw new Error("KuCoin proxy markets unavailable: " + JSON.stringify(upstream.body));
    }

    const body = upstream.body;

    // Proxy may return normalized format:
    // { markets: [...] }
    if (Array.isArray(body.markets)) {
      return body.markets;
    }

    // Or raw KuCoin format:
    // { code: "200000", data: [...] }
    const arr = body.data || [];

    return arr.map(m => ({
      exchange,
      id: m.symbol,
      base: m.baseCurrency,
      quote: m.quoteCurrency,
      tradeStatus: m.enableTrading ? "tradable" : "disabled"
    })).filter(m => m.id && m.tradeStatus === "tradable");
  }

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
  const urls = BINANCE_BASES.map(base => base + "/api/v3/exchangeInfo");
  const upstream = await fetchJsonFromUrls(urls);

  if (!upstream.ok) {
    throw new Error("Binance markets unavailable: " + JSON.stringify(upstream.body));
  }

  const data = upstream.body;
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
        const markets = await fetchMarkets(exchange, env);
        return json({ exchange, markets }, 200, headers);
      }

      if (path === "/orderbook" || path === "/") {
        const pair = normalizePair(url.searchParams.get("pair"), exchange, env);
        const limit = clampLimit(url.searchParams.get("limit"));
        if (!validatePair(pair, exchange)) {
          return json({ error: "Invalid pair format for exchange", exchange, pair }, 400, headers);
        }
        const result = await fetchOrderbook(exchange, pair, limit, env);
        return json(result.body, result.status, headers);
      }

      return json({ error: "Not found. Use /orderbook, /markets, or /health." }, 404, headers);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 502, headers);
    }
  }
};
