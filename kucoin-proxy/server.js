const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;
const CACHE_MS = Number(process.env.CACHE_MS || 5000);
const MARKETS_CACHE_MS = Number(process.env.MARKETS_CACHE_MS || 3600000);

const cache = new Map();

function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;

  if (item.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }

  return item.value;
}

function setCached(key, value, ttlMs) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}

function safePair(pair) {
  pair = String(pair || "").trim().toUpperCase();
  return /^[A-Z0-9]+-[A-Z0-9]+$/.test(pair) ? pair : null;
}

function safeLimit(limit) {
  limit = String(limit || "20");
  return ["5", "10", "20", "50", "100"].includes(limit) ? limit : "20";
}

async function fetchKucoinJson(url) {
  const resp = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "kucoin-proxy/1.0"
    }
  });

  const text = await resp.text();

  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      status: resp.status || 502,
      body: {
        error: "KuCoin returned non-JSON",
        status: resp.status,
        contentType: resp.headers.get("content-type"),
        bodyStart: text.slice(0, 200)
      }
    };
  }

  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status || 502,
      body: {
        error: "KuCoin upstream error",
        status: resp.status,
        headers: {
          retryAfter: resp.headers.get("retry-after"),
          gwLimit: resp.headers.get("gw-ratelimit-limit"),
          gwRemaining: resp.headers.get("gw-ratelimit-remaining"),
          gwReset: resp.headers.get("gw-ratelimit-reset")
        },
        body
      }
    };
  }

  return {
    ok: true,
    status: resp.status,
    body
  };
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "kucoin-proxy",
    time: new Date().toISOString()
  });
});

app.get("/orderbook", async (req, res) => {
  try {
    const pair = safePair(req.query.pair);
    const limit = safeLimit(req.query.limit);

    if (!pair) {
      return res.status(400).json({
        error: "Invalid pair. Expected format like BTC-USDT or EQTY-USDT."
      });
    }

    const cacheKey = `orderbook:${pair}:${limit}`;
    const cached = getCached(cacheKey);

    if (cached) {
      return res
        .set("Cache-Control", "public, max-age=5")
        .json({
          ...cached,
          cached: true
        });
    }

    const endpoint = Number(limit) <= 20 ? "level2_20" : "level2_100";

    const url =
      "https://api.kucoin.com/api/v1/market/orderbook/" +
      endpoint +
      "?symbol=" +
      encodeURIComponent(pair);

    const upstream = await fetchKucoinJson(url);

    if (!upstream.ok) {
      return res.status(upstream.status || 502).json(upstream.body);
    }

    const body = upstream.body;

    if (body.code && body.code !== "200000") {
      return res.status(502).json(body);
    }

    const data = body.data || {};

    const normalized = {
      exchange: "kucoin",
      pair,
      displayPair: pair,
      bids: data.bids || [],
      asks: data.asks || [],
      timestamp: Number(data.time || Date.now()),
      orderbookId: data.sequence,
      upstreamUrl: url,
      proxiedBy: "render"
    };

    setCached(cacheKey, normalized, CACHE_MS);

    return res
      .set("Cache-Control", "public, max-age=5")
      .json(normalized);
  } catch (e) {
    return res.status(500).json({
      error: String(e && e.message ? e.message : e)
    });
  }
});

app.get("/markets", async (req, res) => {
  try {
    const cacheKey = "markets";
    const cached = getCached(cacheKey);

    if (cached) {
      return res
        .set("Cache-Control", "public, max-age=3600")
        .json({
          exchange: "kucoin",
          markets: cached,
          cached: true
        });
    }

    const url = "https://api.kucoin.com/api/v1/symbols";
    const upstream = await fetchKucoinJson(url);

    if (!upstream.ok) {
      return res.status(upstream.status || 502).json(upstream.body);
    }

    const body = upstream.body;

    if (body.code && body.code !== "200000") {
      return res.status(502).json(body);
    }

    const arr = body.data || [];

    const markets = arr
      .map(m => ({
        exchange: "kucoin",
        id: m.symbol,
        base: m.baseCurrency,
        quote: m.quoteCurrency,
        tradeStatus: m.enableTrading ? "tradable" : "disabled"
      }))
      .filter(m => m.id && m.tradeStatus === "tradable");

    setCached(cacheKey, markets, MARKETS_CACHE_MS);

    return res
      .set("Cache-Control", "public, max-age=3600")
      .json({
        exchange: "kucoin",
        markets
      });
  } catch (e) {
    return res.status(500).json({
      error: String(e && e.message ? e.message : e)
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`KuCoin proxy listening on port ${PORT}`);
});
