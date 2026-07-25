(function () {
  const CFG = window.ORDERBOOK_CONFIG || {};
  const EXCHANGE_NAMES = { gate: "Gate.io", kucoin: "KuCoin", binance: "Binance" };
  const DEFAULTS_BY_EXCHANGE = { gate: "EQTY_USDT", kucoin: "EQTY-USDT", binance: "BTCUSDT" };

  let API_BASE = (CFG.workerUrl || "").replace(/\/$/, "");
  let INTERVAL = Math.max(5, Number(CFG.refreshSeconds || 30));
  let DEPTH_PERCENT = Math.max(0.1, Number(CFG.depthPercent || 2));
  let paused = false;
  let inFlight = false;
  let cd = INTERVAL;
  let ticker;
  let prevB = {};
  let prevA = {};
  let prevMid = 0;
  let currentExchange = (CFG.defaultExchange || "gate").toLowerCase();
  let currentPair = CFG.defaultPair || DEFAULTS_BY_EXCHANGE[currentExchange] || "EQTY_USDT";
  let currentLimit = String(CFG.defaultLimit || "100");

  const $ = (id) => document.getElementById(id);
  const fPrice = (n) => {
    n = Number(n);
    if (!Number.isFinite(n)) return "—";
    if (n >= 1000) return n.toFixed(2);
    if (n >= 1) return n.toFixed(4);
    return n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  };
  const fPct = (n) => (Number(n) || 0).toFixed(2);
  const f2 = (n) => (Number(n) || 0).toFixed(2);
  const fq = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
  const compactQuote = (n) => {
    n = Number(n) || 0;
    if (n >= 1000000000) return (n / 1000000000).toFixed(2) + "B";
    if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
    if (n >= 1000) return (n / 1000).toFixed(2) + "k";
    return f2(n);
  };

  function displayPair(pair) {
    if (!pair) return "—";
    if (pair.includes("_")) return pair.replace("_", "/");
    if (pair.includes("-")) return pair.replace("-", "/");
    return pair;
  }

  function normalizePairForExchange(pair, exchange) {
    pair = String(pair || "").trim().toUpperCase();
    if (!pair) return DEFAULTS_BY_EXCHANGE[exchange] || "EQTY_USDT";
    if (exchange === "gate") return pair.replace(/[-/]/g, "_");
    if (exchange === "kucoin") return pair.replace(/[_/]/g, "-");
    if (exchange === "binance") return pair.replace(/[-_/]/g, "");
    return pair;
  }

  function readUrlState() {
    const params = new URLSearchParams(location.search);
    const exchange = params.get("exchange");
    const pair = params.get("pair");
    if (exchange) currentExchange = exchange.toLowerCase();
    if (pair) currentPair = normalizePairForExchange(pair, currentExchange);
  }

  function writeUrlState() {
    const params = new URLSearchParams();
    params.set("exchange", currentExchange);
    params.set("pair", currentPair);
    history.replaceState(null, "", "?" + params.toString());
  }

  function buildUrl(path, params) {
    if (!API_BASE) throw new Error("Missing workerUrl in config.js");
    const url = new URL(API_BASE + path);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
    return url.toString();
  }

  function setBadge(s, text) {
    const el = $("badge");
    const m = {
      loading: ["", text || "◌ Fetching…"],
      live: ["live", text || "● LIVE"],
      error: ["error", text || "✕ Error"],
      paused: ["paused", text || "⏸ Paused"]
    };
    const r = m[s] || m.loading;
    el.className = r[0];
    el.textContent = r[1];
  }

  function updateCountdown() {
    $("cd-text").textContent = "Next: " + cd + "s";
    $("cd-bar").style.width = (cd / INTERVAL * 100) + "%";
  }

  function renderSkeleton() {
    document.title = CFG.siteTitle || "Orderbook Depth Viewer";
    $("title").textContent = "📈 " + displayPair(currentPair);
    $("exchange-badge").textContent = EXCHANGE_NAMES[currentExchange] || currentExchange;
    $("exchange-select").value = currentExchange;
    $("pair-input").value = currentPair;
    $("depth-input").value = DEPTH_PERCENT;
    $("limit-select").value = currentLimit;
    updateCountdown();
  }

  async function loadMarkets() {
    const dl = $("market-list");
    dl.innerHTML = "";
    try {
      const r = await fetch(buildUrl("/markets", { exchange: currentExchange }), { cache: "no-store" });
      if (!r.ok) throw new Error("market list HTTP " + r.status);
      const j = await r.json();
      const markets = Array.isArray(j.markets) ? j.markets : [];
      if (CFG.pinDefaultPair !== false) {
        const opt = document.createElement("option");
        opt.value = normalizePairForExchange(CFG.defaultPair || DEFAULTS_BY_EXCHANGE[currentExchange], currentExchange);
        opt.label = "Default / pinned";
        dl.appendChild(opt);
      }
      markets.slice(0, 3000).forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.label = [m.base, m.quote, m.exchange].filter(Boolean).join(" / ");
        dl.appendChild(opt);
      });
    } catch (e) {
      // Search is optional; manual pair input still works.
      console.warn("Could not load markets", e);
    }
  }

  function calculateDepth(bids, asks, mid) {
    const pct = DEPTH_PERCENT / 100;
    const upTarget = mid * (1 + pct);
    const downTarget = mid * (1 - pct);
    let askQty = 0, askQuote = 0, askLevels = 0, askMax = 0;
    asks.forEach(([p, q]) => {
      if (p <= upTarget) { askQty += q; askQuote += p * q; askLevels++; askMax = p; }
    });
    let bidQty = 0, bidQuote = 0, bidLevels = 0, bidMin = 0;
    bids.forEach(([p, q]) => {
      if (p >= downTarget) { bidQty += q; bidQuote += p * q; bidLevels++; bidMin = p; }
    });
    return {
      upTarget, downTarget,
      askQty, askQuote, askLevels, askAvg: askQty ? askQuote / askQty : 0, askMax,
      bidQty, bidQuote, bidLevels, bidAvg: bidQty ? bidQuote / bidQty : 0, bidMin
    };
  }

  function renderDepthCards(d) {
    const labelUp = "▲ +" + DEPTH_PERCENT + "% Ask Depth";
    const labelDown = "▼ -" + DEPTH_PERCENT + "% Bid Depth";
    $("depth-up").innerHTML =
      '<div class="dc-label">' + labelUp + '</div>' +
      '<div class="dc-main">' + compactQuote(d.askQuote) + '</div>' +
      '<div class="dc-sub">Quote needed to buy visible asks up to +' + DEPTH_PERCENT + '%</div>' +
      '<div class="dc-row"><span>Target price</span><span>' + fPrice(d.upTarget) + '</span></div>' +
      '<div class="dc-row"><span>Base available</span><span>' + fq(d.askQty) + '</span></div>' +
      '<div class="dc-row"><span>Avg execution</span><span>' + (d.askAvg ? fPrice(d.askAvg) : '—') + '</span></div>' +
      '<div class="dc-row"><span>Levels counted</span><span>' + d.askLevels + '</span></div>' +
      '<div class="dc-note">Uses the current mid price as reference; only counts returned ask rows at or below +' + DEPTH_PERCENT + '%.</div>';

    $("depth-down").innerHTML =
      '<div class="dc-label">' + labelDown + '</div>' +
      '<div class="dc-main">' + compactQuote(d.bidQuote) + '</div>' +
      '<div class="dc-sub">Quote bid liquidity visible down to -' + DEPTH_PERCENT + '%</div>' +
      '<div class="dc-row"><span>Target price</span><span>' + fPrice(d.downTarget) + '</span></div>' +
      '<div class="dc-row"><span>Base demand</span><span>' + fq(d.bidQty) + '</span></div>' +
      '<div class="dc-row"><span>Avg execution</span><span>' + (d.bidAvg ? fPrice(d.bidAvg) : '—') + '</span></div>' +
      '<div class="dc-row"><span>Levels counted</span><span>' + d.bidLevels + '</span></div>' +
      '<div class="dc-note">Uses the current mid price as reference; only counts returned bid rows at or above -' + DEPTH_PERCENT + '%.</div>';
  }

  async function doFetch() {
    if (inFlight) return;
    inFlight = true;
    setBadge("loading");
    const btn = $("btn-ref");
    btn.innerHTML = '<span class="spin"></span>Fetching…';
    btn.disabled = true;
    try {
      const url = buildUrl("/orderbook", { exchange: currentExchange, pair: currentPair, limit: currentLimit });
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (!Array.isArray(j.bids) || !Array.isArray(j.asks)) throw new Error("Bad normalized orderbook response");
      const bids = j.bids.map(x => [Number(x[0]), Number(x[1])]).filter(x => x[0] > 0 && x[1] > 0).sort((a, b) => b[0] - a[0]);
      const asks = j.asks.map(x => [Number(x[0]), Number(x[1])]).filter(x => x[0] > 0 && x[1] > 0).sort((a, b) => a[0] - b[0]);
      render(bids, asks, j);
      const nb = {}, na = {};
      bids.forEach(x => nb[fPrice(x[0])] = x[1]);
      asks.forEach(x => na[fPrice(x[0])] = x[1]);
      prevB = nb; prevA = na;
      setBadge("live");
    } catch (e) {
      setBadge("error");
      $("footer").textContent = "⚠ " + e.message + " · Check workerUrl, CORS, pair, and exchange settings.";
    } finally {
      btn.innerHTML = "↺ Refresh now";
      btn.disabled = false;
      cd = INTERVAL;
      updateCountdown();
      inFlight = false;
    }
  }

  function render(bids, asks, meta) {
    if (!bids.length || !asks.length) throw new Error("Empty orderbook");
    const bb = bids[0][0], ba = asks[0][0], spread = ba - bb, mid = (bb + ba) / 2;
    const pairLabel = meta.displayPair || displayPair(meta.pair || currentPair);
    $("title").textContent = "📈 " + pairLabel;
    $("exchange-badge").textContent = EXCHANGE_NAMES[meta.exchange] || meta.exchange || currentExchange;

    let midDelta = "", midCls = "flat";
    if (prevMid > 0) {
      const md = mid - prevMid;
      if (Math.abs(md) > 0) { midCls = md > 0 ? "up" : "down"; midDelta = (md > 0 ? "▲" : "▼") + fPrice(Math.abs(md)); }
      else midDelta = "—";
    }
    $("live-price").innerHTML = fPrice(mid) + '<span class="lp-delta ' + midCls + '">' + (prevMid ? midDelta : '') + '</span>';
    prevMid = mid;

    let tbQuote = 0, taQuote = 0, tbQty = 0, taQty = 0;
    bids.forEach(x => { tbQuote += x[0] * x[1]; tbQty += x[1]; });
    asks.forEach(x => { taQuote += x[0] * x[1]; taQty += x[1]; });

    const pbbK = Object.keys(prevB).sort((a, b) => +b - +a);
    const pbaK = Object.keys(prevA).sort((a, b) => +a - +b);
    const pbb = pbbK.length ? +pbbK[0] : 0;
    const pba = pbaK.length ? +pbaK[0] : 0;
    function delta(c, p) {
      if (!p) return "";
      const d = c - p;
      if (Math.abs(d) < 1e-12) return ' <span style="color:#555;font-size:10px">—</span>';
      return d > 0 ? ' <span style="color:#6daa45;font-size:10px">▲' + fPrice(Math.abs(d)) + '</span>' : ' <span style="color:#dd6974;font-size:10px">▼' + fPrice(Math.abs(d)) + '</span>';
    }

    $("k-bb").innerHTML = fPrice(bb) + delta(bb, pbb);
    $("k-ba").innerHTML = fPrice(ba) + delta(ba, pba);
    $("k-sp").textContent = fPct(spread / bb * 100) + "%";
    $("k-sp2").textContent = fPrice(spread);
    $("k-mid").textContent = fPrice(mid);
    $("k-bd").textContent = compactQuote(tbQuote);
    $("k-bd2").textContent = fq(tbQty) + " base · " + bids.length + " rows";
    $("k-ad").textContent = compactQuote(taQuote);
    $("k-ad2").textContent = fq(taQty) + " base · " + asks.length + " rows";
    $("bid-tot").textContent = "· " + compactQuote(tbQuote) + " visible";
    $("ask-tot").textContent = "· " + compactQuote(taQuote) + " visible";

    const d = calculateDepth(bids, asks, mid);
    renderDepthCards(d);

    let maxB = 0, maxA = 0;
    bids.forEach(x => { if (x[1] > maxB) maxB = x[1]; });
    asks.forEach(x => { if (x[1] > maxA) maxA = x[1]; });

    function makeRows(data, isAsk) {
      const mx = isAsk ? maxA : maxB;
      const pm = isAsk ? prevA : prevB;
      const hasPrev = Object.keys(pm).length > 0;
      let cum = 0;
      return data.map(([p, q]) => {
        const key = fPrice(p), val = p * q;
        cum += val;
        const changed = hasPrev && pm[key] !== undefined && pm[key] !== q;
        const isNew = hasPrev && pm[key] === undefined;
        const flash = (changed || isNew) ? (isAsk ? "fa" : "fb") : "";
        const inDepth = isAsk ? p <= d.upTarget : p >= d.downTarget;
        const tag = inDepth ? '<span class="tag t-depth">' + DEPTH_PERCENT + '%</span>' : '';
        return '<div class="row ' + flash + ' ' + (inDepth ? 'depth-hit' : '') + '">' +
          '<span class="p ' + (isAsk ? 'ask' : 'bid') + '">' + key + tag + '</span>' +
          '<span class="q">' + fq(q) + '</span>' +
          '<span class="cum">' + compactQuote(cum) + '</span>' +
          '<span class="v">' + f2(val) + '</span>' +
          '<div class="bg ' + (isAsk ? 'bg-ask' : 'bg-bid') + '" style="width:' + (mx ? Math.min(100, q / mx * 100) : 0).toFixed(1) + '%"></div></div>';
      }).join('');
    }

    $("bid-rows").innerHTML = makeRows(bids, false);
    $("ask-rows").innerHTML = makeRows(asks, true);

    const stamp = meta.timestamp || Date.now();
    const parts = ["Last snapshot: " + new Date(Number(stamp)).toLocaleTimeString("en-CH")];
    if (meta.orderbookId !== undefined) parts.push("Book ID: " + meta.orderbookId);
    parts.push("Auto-refresh every " + INTERVAL + "s");
    parts.push("via Worker → " + (EXCHANGE_NAMES[meta.exchange] || meta.exchange || currentExchange) + " public API");
    $("footer").textContent = parts.join(" · ");
  }

  function startTicker() {
    clearInterval(ticker);
    ticker = setInterval(() => {
      if (paused || inFlight) return;
      cd = Math.max(0, cd - 1);
      updateCountdown();
      if (cd === 0) doFetch();
    }, 1000);
  }

  function togglePause() {
    paused = !paused;
    const btn = $("btn-pause");
    btn.textContent = paused ? "▶ Resume" : "⏸ Pause";
    btn.classList.toggle("active", paused);
    setBadge(paused ? "paused" : "live");
    if (!paused) doFetch();
  }

  function applyControls() {
    currentExchange = $("exchange-select").value;
    currentPair = normalizePairForExchange($("pair-input").value, currentExchange);
    currentLimit = $("limit-select").value;
    DEPTH_PERCENT = Math.max(0.1, Number($("depth-input").value || DEPTH_PERCENT));
    $("pair-input").value = currentPair;
    writeUrlState();
    renderSkeleton();
    prevB = {}; prevA = {}; prevMid = 0;
    loadMarkets();
    doFetch();
  }

  function init() {
    readUrlState();
    renderSkeleton();
    $("btn-ref").addEventListener("click", doFetch);
    $("btn-pause").addEventListener("click", togglePause);
    $("btn-load").addEventListener("click", applyControls);
    $("exchange-select").addEventListener("change", () => {
      currentExchange = $("exchange-select").value;
      if (!$("pair-input").value || $("pair-input").value === currentPair) {
        currentPair = normalizePairForExchange(DEFAULTS_BY_EXCHANGE[currentExchange], currentExchange);
        $("pair-input").value = currentPair;
      }
      loadMarkets();
    });
    $("pair-input").addEventListener("keydown", (e) => { if (e.key === "Enter") applyControls(); });
    loadMarkets();
    doFetch();
    startTicker();
  }

  init();
})();
