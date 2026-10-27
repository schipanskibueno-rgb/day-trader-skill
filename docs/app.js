/* Robo Trader page: fetches Binance's public candles, runs engine.js and draws it. */
(function () {
  "use strict";

  var HOSTS = ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com"];
  var TF = { "15m": { ms: 9e5, htf: "1h" }, "1h": { ms: 36e5, htf: "4h" }, "4h": { ms: 144e5, htf: "1d" },
             "1d": { ms: 864e5, htf: "1w" } };
  var SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];
  var PAGES = 3;          // 3 x 1000 candles of history
  var REFRESH_MS = 60000;
  var KEY = "robo-trader-v1";

  var cfg = Object.assign({ symbol: "BTCUSDT", tf: "1h", maxLoss: 50, stopAtr: 1.5, rr: 2, fee: 0.1,
                            auto: true, notify: false, wake: false, requireEdge: true, lastAlert: "" }, readCfg());
  var cache = {};         // "BTCUSDT|1h" -> candles
  var steps = {};         // symbol -> lot step size
  var host = null, chart = null, series = {}, priceLines = [], state = { analysis: null, closed: [], forming: null,
                                                                          selected: null, showAnalogs: false, showRobot: false };
  var timer = null, busy = false, again = false, wakeLock = null;

  function $(id) { return document.getElementById(id); }
  function readCfg() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function saveCfg() { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* private mode */ } }

  // ---------------------------------------------------------------- data

  function getJSON(path) {
    var order = host ? [host].concat(HOSTS.filter(function (h) { return h !== host; })) : HOSTS.slice();
    var tryNext = function (k, lastErr) {
      if (k >= order.length) return Promise.reject(lastErr || new Error("sem conexao com a Binance"));
      return fetch(order[k] + path).then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error("Binance " + r.status + ": " + t.slice(0, 120)); });
        host = order[k];
        return r.json();
      }).catch(function (e) { return tryNext(k + 1, e); });
    };
    return tryNext(0);
  }

  function toBar(r) { return { t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }; }

  function klines(symbol, tf, pages) {
    var all = [], end = null, n = 0;
    var next = function () {
      var q = "/api/v3/klines?symbol=" + symbol + "&interval=" + tf + "&limit=1000" + (end ? "&endTime=" + end : "");
      return getJSON(q).then(function (rows) {
        all = rows.map(toBar).concat(all);
        n++;
        if (rows.length === 1000 && n < pages) { end = rows[0][0] - 1; return next(); }
        return all;
      });
    };
    return next();
  }

  function candles(symbol, tf) {
    var key = symbol + "|" + tf, have = cache[key];
    if (!have) return klines(symbol, tf, PAGES).then(function (b) { cache[key] = b; return b; });
    return klines(symbol, tf, 1).then(function (fresh) {       // only the newest page; merge
      var first = fresh[0].t, kept = have.filter(function (b) { return b.t < first; });
      cache[key] = kept.concat(fresh);
      return cache[key];
    });
  }

  function stepSize(symbol) {
    if (steps[symbol]) return Promise.resolve(steps[symbol]);
    return getJSON("/api/v3/exchangeInfo?symbol=" + symbol).then(function (d) {
      var lot = d.symbols[0].filters.filter(function (f) { return f.filterType === "LOT_SIZE"; })[0];
      steps[symbol] = lot ? parseFloat(lot.stepSize) : 0.00001;
      return steps[symbol];
    }).catch(function () { return 0.00001; });
  }

  // ---------------------------------------------------------------- run

  function run(manual) {
    if (busy) { again = true; return; }      // run once more when the current load ends
    busy = true;
    setStatus("Atualizando...");
    var sym = cfg.symbol, tf = cfg.tf, ms = TF[tf].ms;
    Promise.all([candles(sym, tf), candles(sym, TF[tf].htf), stepSize(sym)]).then(function (res) {
      if (sym !== cfg.symbol || tf !== cfg.tf) return;          // changed while loading
      var now = Date.now(), htfMs = TF[TF[tf].htf] ? TF[TF[tf].htf].ms : 6048e5;
      var closed = res[0].filter(function (b) { return b.t + ms <= now; });
      var forming = res[0].filter(function (b) { return b.t + ms > now; })[0] || null;
      var htf = res[1].filter(function (b) { return b.t + htfMs <= now; });
      var a = Robo.analyze(closed, { maxLoss: +cfg.maxLoss, stopAtr: +cfg.stopAtr, rr: +cfg.rr, fee: +cfg.fee / 100,
                                     step: res[2], tfMs: ms, htfMs: htfMs, requireEdge: cfg.requireEdge }, htf);
      state.analysis = a; state.closed = closed; state.forming = forming;
      render();
      alertIfNew(a);
      setStatus("Atualizado " + clock(new Date()) + " | " + closed.length + " velas");
      if (manual) toast("Atualizado");
    }).catch(function (e) {
      setStatus("Erro: " + e.message, true);
    }).then(function () {
      busy = false;
      if (again) { again = false; run(false); }
    });
  }

  function schedule() {
    clearInterval(timer);
    if (cfg.auto) timer = setInterval(function () { run(false); }, REFRESH_MS);
  }

  // ---------------------------------------------------------------- render

  function money(v, ref) {
    var r = ref || v, d = r >= 1000 ? 2 : r >= 1 ? 4 : 6;
    return v.toLocaleString("pt-BR", { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
  }
  function usd(v) { return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pct(v) { return (v * 100).toFixed(2).replace(".", ",") + "%"; }
  function clock(d) { return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); }
  function when(t) {
    var d = new Date(t);
    var opt = { day: "2-digit", month: "2-digit" };
    if (d.getFullYear() !== new Date().getFullYear()) opt.year = "2-digit";
    return d.toLocaleDateString("pt-BR", opt) + " " + clock(d);
  }
  function setStatus(text, bad) { var s = $("status"); s.textContent = text; s.classList.toggle("err", !!bad); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function render() {
    var a = state.analysis;
    var card = $("verdictCard");
    card.className = "card verdict " + (a.dir > 0 ? "buy" : a.dir < 0 ? "sell" : "wait");
    $("verdict").textContent = a.verdict;
    $("verdictSub").textContent = "Nota " + (a.score > 0 ? "+" : "") + a.score + " | vela de " + when(a.time + TF[cfg.tf].ms) + " fechada";
    var live = state.forming ? state.forming.c : a.price;
    $("priceLabel").textContent = cfg.symbol;
    $("price").textContent = money(live);
    $("priceSub").textContent = "RSI " + a.rsi.toFixed(0) + " | ATR " + money(a.atr, a.price);
    $("meterDot").style.left = (50 + a.score / 2) + "%";
    var note = $("note");
    note.hidden = !a.note; note.textContent = a.note || "";
    document.title = (a.dir ? (a.dir > 0 ? "▲ " : "▼ ") + a.verdict + " " : "") + cfg.symbol + " | Robo Trader";
    renderPlan(a);
    renderReasons(a);
    renderRobot(a);
    renderStrategies(a);
    renderAnalogs(a);
    renderChart();
  }

  function renderRobot(a) {
    var box = $("robot"), r = a.robot;
    box.textContent = "";
    if (!r) return;
    var s = r.all, good = s.n >= 10 && s.expectancy > 0;
    var head = el("p", null, good
      ? "Neste par e tempo grafico, seguir o robo teria dado resultado positivo:"
      : "Neste par e tempo grafico o robo ainda NAO provou vantagem. Os sinais ficam segurados" + (cfg.requireEdge ? "." : " (o filtro esta desligado nos ajustes!)."));
    box.appendChild(head);
    var grid = el("div", "an");
    [["Sinais desde " + when(state.closed[r.from].t), String(s.n), null],
     ["Acerto", Robo.pct(s.winRate), null],
     ["Media por trade", Robo.fmtR(s.expectancy), s.expectancy],
     ["Total", Robo.fmtR(s.totalR), s.totalR],
     ["Pior sequencia de perdas", s.worstStreak + " seguidas", null],
     ["So compras / so vendas", Robo.fmtR(r.buy.expectancy) + " (" + r.buy.n + ") / " + Robo.fmtR(r.sell.expectancy) + " (" + r.sell.n + ")", null]
    ].forEach(function (x) {
      var d = el("div", "an-row");
      d.appendChild(el("span", null, x[0]));
      d.appendChild(el("b", x[2] === null ? "" : x[2] > 0 ? "pos" : "neg", x[1]));
      grid.appendChild(d);
    });
    box.appendChild(grid);
    if (s.n) {
      var b = el("button", "linkbtn", state.showRobot ? "Esconder no grafico" : "Mostrar os trades do robo no grafico");
      b.onclick = function () {
        state.showRobot = !state.showRobot; state.selected = null; state.showAnalogs = false;
        renderRobot(a); renderStrategies(a); renderAnalogs(a); renderChart();
        $("chartHint").textContent = state.showRobot ? "Setas: cada sinal do robo e o resultado em R (verde ganhou, vermelho perdeu)." : "";
        if (state.showRobot) $("chart").scrollIntoView({ behavior: "smooth", block: "center" });
      };
      box.appendChild(b);
    }
    box.appendChild(el("p", "hint", "Teste vela a vela sem olhar o futuro, com taxas. Resultado passado nao garante o futuro."));
  }

  function renderPlan(a) {
    var box = $("plan");
    box.textContent = "";
    var wrap = el("div", "plan");
    if (a.plan) {
      var p = a.plan, buy = p.dir > 0, dl = el("dl");
      var rows = [["Entrada (agora)", money(p.entry), ""], ["Stop", money(p.stop) + " (" + pct(p.riskPct) + ")", "stop"],
                  ["Alvo 1 (1R)", money(p.take1), "take"], ["Alvo 2 (" + p.rr + "R)", money(p.take2), "take"],
                  ["Quantidade", String(p.qty), ""], ["Perda se bater o stop", "~" + usd(p.maxLoss) + " USDT", ""]];
      rows.forEach(function (r) { dl.appendChild(el("dt", null, r[0])); dl.appendChild(el("dd", r[2], r[1])); });
      wrap.appendChild(dl);
      var cmd = "python3 trader-broker/binance.py plan --symbol " + cfg.symbol + " --side " + (buy ? "buy" : "sell")
        + " --stop " + round2(p.stop) + " --take " + round2(p.take2) + " --qty " + p.qty;
      wrap.appendChild(el("div", "cmd", cmd));
      var btn = el("button", "btn", "Copiar comando da testnet");
      btn.onclick = function () { copy(cmd); };
      wrap.appendChild(btn);
      if (!buy) wrap.appendChild(el("p", "hint", "Venda no spot vende a moeda que voce ja tem. Nao e venda alavancada."));
    } else {
      wrap.appendChild(el("div", "label", "Fique de olho"));
      var w = el("div", "watch");
      if (a.watch.buyAbove) w.appendChild(row("Rompimento de alta: fechar acima de", money(a.watch.buyAbove)));
      if (a.watch.sellBelow) w.appendChild(row("Rompimento de baixa: fechar abaixo de", money(a.watch.sellBelow)));
      wrap.appendChild(w);
      wrap.appendChild(el("p", "hint", "Sem sinal, sem operacao. O robo reavalia a cada vela fechada."));
    }
    box.appendChild(wrap);
  }
  function round2(v) { return Math.round(v * 100) / 100; }
  function row(k, v) { var d = el("div"); d.appendChild(el("span", null, k)); d.appendChild(el("b", null, v)); return d; }

  function renderReasons(a) {
    var ul = $("reasons");
    ul.textContent = "";
    a.reasons.forEach(function (r) {
      var li = el("li");
      li.appendChild(el("span", "dot" + (r.dir > 0 ? " up" : r.dir < 0 ? " down" : "")));
      li.appendChild(el("span", null, r.text));
      ul.appendChild(li);
    });
    if (!a.strategies.some(function (s) { return s.now; })) {
      var li = el("li"); li.appendChild(el("span", "dot")); li.appendChild(el("span", null, "Nenhuma das 7 estrategias deu gatilho nas ultimas 3 velas."));
      ul.insertBefore(li, ul.firstChild);
    }
  }

  function statCell(s) {
    var td = el("td", "st");
    if (!s.n) { td.textContent = "-"; return td; }
    var b = el("b", s.expectancy > 0 ? "pos" : "neg", Robo.fmtR(s.expectancy));
    td.appendChild(b);
    td.appendChild(el("small", null, s.n + "x | " + Robo.pct(s.winRate) + " acerto"));
    return td;
  }

  function renderStrategies(a) {
    var tb = $("strats");
    tb.textContent = "";
    var first = state.closed[Robo.WARMUP], last = state.closed[state.closed.length - 1];
    $("btHint").textContent = "De " + when(first.t) + " ate " + when(last.t) + ". Numero em R = resultado medio por trade em"
      + " multiplos do risco, ja com taxas (+0,50R = ganhou em media meio stop por trade). Stop " + cfg.stopAtr
      + " ATR, alvo " + cfg.rr + "R.";
    a.strategies.forEach(function (s) {
      var tr = el("tr", state.selected === s.id ? "sel" : "");
      var name = el("td");
      name.appendChild(el("div", null, s.name));
      name.appendChild(el("div", "fam", s.family));
      name.title = s.desc;
      tr.appendChild(name);
      var now = el("td");
      now.appendChild(el("span", "pill " + (s.now > 0 ? "buy" : s.now < 0 ? "sell" : "none"),
                         s.now > 0 ? "Compra" : s.now < 0 ? "Venda" : "-"));
      tr.appendChild(now);
      tr.appendChild(statCell(s.backtest.buy));
      tr.appendChild(statCell(s.backtest.sell));
      tr.onclick = function () {
        state.selected = state.selected === s.id ? null : s.id;
        state.showAnalogs = false; state.showRobot = false;
        renderStrategies(a); renderChart();
        $("chartHint").textContent = state.selected ? s.name + ": " + s.desc : "Toque numa estrategia para ver os sinais dela no grafico.";
        if (state.selected) $("chart").scrollIntoView({ behavior: "smooth", block: "center" });
      };
      tb.appendChild(tr);
    });
  }

  function renderAnalogs(a) {
    var box = $("analogs");
    box.textContent = "";
    var an = a.analogs;
    if (!an) { box.appendChild(el("p", "hint", "Historico curto demais para comparar.")); return; }
    var d = el("div", "an");
    d.appendChild(el("p", null, "Nos " + an.k + " momentos mais parecidos com a vela atual, o preco subiu em "
      + Robo.pct(an.upRate) + " das vezes nas " + an.horizon + " velas seguintes (mediana " + Robo.pctSigned(an.medRet) + ")."));
    var bar = el("div", "bar"), fill = el("div");
    fill.style.width = Math.round(an.upRate * 100) + "%";
    bar.appendChild(fill); d.appendChild(bar);
    var r1 = el("div", "an-row");
    r1.appendChild(el("span", null, "Se tivesse comprado em cada um"));
    r1.appendChild(el("b", an.long.expectancy > 0 ? "pos" : "neg", Robo.fmtR(an.long.expectancy) + " | " + Robo.pct(an.long.winRate)));
    var r2 = el("div", "an-row");
    r2.appendChild(el("span", null, "Se tivesse vendido em cada um"));
    r2.appendChild(el("b", an.short.expectancy > 0 ? "pos" : "neg", Robo.fmtR(an.short.expectancy) + " | " + Robo.pct(an.short.winRate)));
    d.appendChild(r1); d.appendChild(r2);
    var b = el("button", "linkbtn", state.showAnalogs ? "Esconder no grafico" : "Mostrar esses momentos no grafico");
    b.onclick = function () {
      state.showAnalogs = !state.showAnalogs; state.selected = null; state.showRobot = false;
      renderAnalogs(a); renderStrategies(a); renderChart();
      $("chartHint").textContent = state.showAnalogs ? "Circulos: momentos parecidos com agora. Verde = subiu depois, vermelho = caiu." : "";
      if (state.showAnalogs) $("chart").scrollIntoView({ behavior: "smooth", block: "center" });
    };
    d.appendChild(b);
    box.appendChild(d);
  }

  // ---------------------------------------------------------------- chart

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function localTime(t) { return Math.floor(t / 1000) - new Date(t).getTimezoneOffset() * 60; }

  function ensureChart() {
    if (chart || typeof LightweightCharts === "undefined") return chart;
    var box = $("chart");
    chart = LightweightCharts.createChart(box, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: css("--muted"), fontSize: 11 },
      grid: { vertLines: { color: css("--line") }, horzLines: { color: css("--line") } },
      rightPriceScale: { borderColor: css("--line") },
      timeScale: { borderColor: css("--line"), timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      localization: { locale: "pt-BR" }
    });
    series.candles = chart.addCandlestickSeries({ upColor: css("--buy"), downColor: css("--sell"), borderVisible: false,
                                                  wickUpColor: css("--buy"), wickDownColor: css("--sell") });
    [["e20", "--e20"], ["e50", "--e50"], ["e200", "--e200"]].forEach(function (p) {
      series[p[0]] = chart.addLineSeries({ color: css(p[1]), lineWidth: 1, priceLineVisible: false,
                                           lastValueVisible: false, crosshairMarkerVisible: false });
    });
    return chart;
  }

  function renderChart() {
    if (!ensureChart()) {
      $("chart").textContent = "Nao foi possivel carregar o grafico (sem internet para a biblioteca). O resto funciona.";
      return;
    }
    var a = state.analysis, bars = state.closed.concat(state.forming ? [state.forming] : []);
    series.candles.setData(bars.map(function (b) { return { time: localTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c }; }));
    [["e20", a.ind.ema20], ["e50", a.ind.ema50], ["e200", a.ind.ema200]].forEach(function (p) {
      var data = [];
      state.closed.forEach(function (b, i) { if (p[1][i] !== null) data.push({ time: localTime(b.t), value: p[1][i] }); });
      series[p[0]].setData(data);
    });
    var marks = [], list = null;
    if (state.selected) list = a.strategies.filter(function (x) { return x.id === state.selected; })[0].backtest.trades;
    else if (state.showRobot && a.robot) list = a.robot.trades;
    if (list) {
      list.forEach(function (t) {
        var win = !t.open && t.r > 0, color = t.open ? css("--wait") : win ? css("--buy") : css("--sell");
        marks.push({ time: localTime(state.closed[t.i].t), position: t.dir > 0 ? "belowBar" : "aboveBar",
                     shape: t.dir > 0 ? "arrowUp" : "arrowDown", color: color,
                     text: t.open ? "aberto" : Robo.fmtR(t.r) });
      });
    } else if (state.showAnalogs && a.analogs) {
      a.analogs.matches.forEach(function (j) {
        var up = a.ind.c[j + a.analogs.horizon] > a.ind.c[j];
        marks.push({ time: localTime(state.closed[j].t), position: "aboveBar", shape: "circle",
                     color: up ? css("--buy") : css("--sell") });
      });
      marks.push({ time: localTime(state.closed[state.closed.length - 1].t), position: "aboveBar", shape: "circle",
                   color: css("--accent"), text: "agora" });
    }
    marks.sort(function (x, y) { return x.time - y.time; });
    series.candles.setMarkers(marks);
    priceLines.forEach(function (l) { series.candles.removePriceLine(l); });
    priceLines = [];
    if (a.plan) {
      [[a.plan.stop, "--sell", "Stop"], [a.plan.take2, "--buy", "Alvo"], [a.plan.entry, "--muted", "Entrada"]].forEach(function (p) {
        priceLines.push(series.candles.createPriceLine({ price: p[0], color: css(p[1]), lineWidth: 1, lineStyle: 2,
                                                         axisLabelVisible: true, title: p[2] }));
      });
    }
    if (!renderChart.fitted) { chart.timeScale().setVisibleLogicalRange({ from: bars.length - 150, to: bars.length + 5 }); renderChart.fitted = true; }
  }

  // ---------------------------------------------------------------- alerts

  function alertIfNew(a) {
    if (!a.dir) return;
    var key = cfg.symbol + "|" + cfg.tf + "|" + a.time + "|" + a.dir;
    if (cfg.lastAlert === key) return;
    cfg.lastAlert = key; saveCfg();
    var text = a.verdict + " " + cfg.symbol + " (" + cfg.tf + ") a " + money(a.price);
    toast(text);
    if (!cfg.notify) return;
    beep();
    var body = a.plan ? "Stop " + money(a.plan.stop) + " | alvo " + money(a.plan.take2) : "";
    if ("Notification" in window && Notification.permission === "granted") {
      var opts = { body: body, icon: "icon.svg", tag: key };
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then(function (reg) { reg.showNotification(text, opts); });
      } else {
        try { new Notification(text, opts); } catch (e) { /* Android needs the service worker */ }
      }
    }
  }

  function beep() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)(), o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.25);
    } catch (e) { /* no audio */ }
  }

  function toast(text) {
    var t = $("toast");
    t.textContent = text; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  function copy(text) {
    var done = function () { toast("Comando copiado. Cole no Termux."); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
    function fallback() {
      var ta = el("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { toast("Copie manualmente o comando acima."); }
      ta.remove();
    }
  }

  function keepAwake() {
    if (!cfg.wake || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    navigator.wakeLock.request("screen").then(function (l) { wakeLock = l; }).catch(function () { /* refused */ });
  }

  // ---------------------------------------------------------------- controls

  function fillSymbols() {
    var sel = $("symbol");
    sel.textContent = "";
    var list = SYMBOLS.indexOf(cfg.symbol) < 0 ? SYMBOLS.concat([cfg.symbol]) : SYMBOLS;
    list.forEach(function (s) { var o = el("option", null, s.replace("USDT", "/USDT")); o.value = s; sel.appendChild(o); });
    sel.value = cfg.symbol;
  }

  function markTf() {
    Array.prototype.forEach.call($("tf").children, function (b) { b.classList.toggle("on", b.dataset.tf === cfg.tf); });
  }

  function reset() { state.selected = null; state.showAnalogs = false; state.showRobot = false; renderChart.fitted = false; run(false); }

  function bind() {
    fillSymbols(); markTf();
    $("symbol").onchange = function () { cfg.symbol = this.value; saveCfg(); reset(); };
    $("tf").onclick = function (e) {
      var tf = e.target.dataset && e.target.dataset.tf;
      if (!tf || tf === cfg.tf) return;
      cfg.tf = tf; saveCfg(); markTf(); reset();
    };
    $("refresh").onclick = function () { run(true); };
    ["maxLoss", "stopAtr", "rr", "fee"].forEach(function (k) {
      var i = $(k); i.value = cfg[k];
      i.onchange = function () { if (this.value !== "" && +this.value > 0) { cfg[k] = +this.value; saveCfg(); run(false); } };
    });
    $("customSymbol").onchange = function () {
      var s = this.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!s) return;
      cfg.symbol = s; saveCfg(); fillSymbols(); this.value = ""; reset();
    };
    $("requireEdge").checked = cfg.requireEdge;
    $("requireEdge").onchange = function () { cfg.requireEdge = this.checked; saveCfg(); run(false); };
    $("auto").checked = cfg.auto;
    $("auto").onchange = function () { cfg.auto = this.checked; saveCfg(); schedule(); };
    $("notify").checked = cfg.notify;
    $("notify").onchange = function () {
      var box = this;
      cfg.notify = box.checked; saveCfg();
      if (box.checked && "Notification" in window && Notification.permission !== "granted") {
        Notification.requestPermission().then(function (p) {
          if (p !== "granted") toast("Sem permissao de notificacao: o aviso aparece so na tela e com som.");
        });
      }
      if (box.checked) beep();
    };
    $("wake").checked = cfg.wake;
    $("wake").onchange = function () {
      cfg.wake = this.checked; saveCfg();
      if (cfg.wake) keepAwake(); else if (wakeLock) { wakeLock.release(); wakeLock = null; }
    };
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") { keepAwake(); run(false); }
    });
  }

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(function () { /* optional */ });
  }
  bind();
  keepAwake();
  run(false);
  schedule();
})();
