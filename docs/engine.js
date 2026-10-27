/* Robo Trader engine: indicators, strategies, backtests, look-alike patterns
 * and the signal for the last closed candle. No DOM, no network: the page
 * (app.js) feeds it candles and draws what it returns. Runs in a browser
 * (window.Robo) and in Node (require) for the tests.
 *
 * A candle is {t, o, h, l, c, v}: open time in ms and numbers.
 * Every signal is read at the CLOSE of candle i and entered at the OPEN of
 * candle i + 1, so nothing here looks at a candle that has not happened yet.
 */
(function (root) {
  "use strict";

  var WARMUP = 200;
  var DEFAULTS = { stopAtr: 1.5, rr: 2, maxHold: 48, fee: 0.001, maxLoss: 50, step: 0.00001,
                   k: 30, horizon: 12 };

  // ------------------------------------------------------------ indicators

  function sma(src, n) {
    var out = new Array(src.length).fill(null), sum = 0;
    for (var i = 0; i < src.length; i++) {
      sum += src[i];
      if (i >= n) sum -= src[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function ema(src, n) {
    var out = new Array(src.length).fill(null), k = 2 / (n + 1), prev = null, start = -1;
    for (var i = 0; i < src.length; i++) {
      if (src[i] === null) continue;
      if (start < 0) start = i;
      if (i - start < n - 1) continue;
      if (prev === null) {
        var s = 0;
        for (var j = i - n + 1; j <= i; j++) s += src[j];
        prev = s / n;
      } else {
        prev = src[i] * k + prev * (1 - k);
      }
      out[i] = prev;
    }
    return out;
  }

  function rsi(c, n) {
    var out = new Array(c.length).fill(null), g = 0, l = 0;
    if (c.length <= n) return out;
    for (var i = 1; i <= n; i++) {
      var d = c[i] - c[i - 1];
      g += Math.max(d, 0); l += Math.max(-d, 0);
    }
    g /= n; l /= n;
    out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (i = n + 1; i < c.length; i++) {
      d = c[i] - c[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }

  function trueRange(bars) {
    return bars.map(function (b, i) {
      if (i === 0) return b.h - b.l;
      var pc = bars[i - 1].c;
      return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    });
  }

  function wilder(src, n) {
    var out = new Array(src.length).fill(null), a = 0;
    for (var i = 0; i < src.length; i++) {
      if (i < n) { a += src[i]; if (i === n - 1) { a /= n; out[i] = a; } continue; }
      a = (a * (n - 1) + src[i]) / n;
      out[i] = a;
    }
    return out;
  }

  function atr(bars, n) { return wilder(trueRange(bars), n); }

  function adx(bars, n) {
    var len = bars.length, plus = [0], minus = [0];
    for (var i = 1; i < len; i++) {
      var up = bars[i].h - bars[i - 1].h, dn = bars[i - 1].l - bars[i].l;
      plus.push(up > dn && up > 0 ? up : 0);
      minus.push(dn > up && dn > 0 ? dn : 0);
    }
    var tr = wilder(trueRange(bars), n), p = wilder(plus, n), m = wilder(minus, n);
    var dx = new Array(len).fill(null);
    for (i = 0; i < len; i++) {
      if (tr[i] === null || !tr[i]) continue;
      var pdi = 100 * p[i] / tr[i], mdi = 100 * m[i] / tr[i];
      dx[i] = pdi + mdi === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi);
    }
    var first = dx.findIndex(function (x) { return x !== null; });
    var out = new Array(len).fill(null);
    if (first < 0) return out;
    var tail = wilder(dx.slice(first), n);
    for (i = 0; i < tail.length; i++) out[first + i] = tail[i];
    return out;
  }

  // highest high / lowest low of the n candles BEFORE i (not including i)
  function channel(bars, n) {
    var hh = new Array(bars.length).fill(null), ll = new Array(bars.length).fill(null);
    for (var i = n; i < bars.length; i++) {
      var h = -Infinity, l = Infinity;
      for (var j = i - n; j < i; j++) { if (bars[j].h > h) h = bars[j].h; if (bars[j].l < l) l = bars[j].l; }
      hh[i] = h; ll[i] = l;
    }
    return { hh: hh, ll: ll };
  }

  function indicators(bars) {
    var c = bars.map(function (b) { return b.c; }), v = bars.map(function (b) { return b.v; });
    var e12 = ema(c, 12), e26 = ema(c, 26);
    var macd = c.map(function (_, i) { return e12[i] === null || e26[i] === null ? null : e12[i] - e26[i]; });
    var mid = sma(c, 20), up = [], lo = [], width = [];
    for (var i = 0; i < c.length; i++) {
      if (mid[i] === null) { up.push(null); lo.push(null); width.push(null); continue; }
      var s = 0;
      for (var j = i - 19; j <= i; j++) s += (c[j] - mid[i]) * (c[j] - mid[i]);
      var sd = Math.sqrt(s / 20);
      up.push(mid[i] + 2 * sd); lo.push(mid[i] - 2 * sd); width.push(4 * sd / mid[i]);
    }
    var ch = channel(bars, 20);
    return { c: c, ema20: ema(c, 20), ema50: ema(c, 50), ema200: ema(c, 200), rsi: rsi(c, 14),
             atr: atr(bars, 14), adx: adx(bars, 14), macd: macd, macdSig: ema(macd, 9),
             bbMid: mid, bbUp: up, bbLo: lo, bbWidth: width, hh20: ch.hh, ll20: ch.ll,
             volSma: sma(v, 20) };
  }

  // ------------------------------------------------------------ strategies

  function crossUp(a, b, i) { return a[i - 1] <= b[i - 1] && a[i] > b[i]; }
  function crossDown(a, b, i) { return a[i - 1] >= b[i - 1] && a[i] < b[i]; }

  var STRATEGIES = [
    { id: "cruzamento", name: "Cruzamento de medias", family: "Tendencia",
      desc: "EMA 20 cruza a EMA 50, a favor da EMA 200 (compra so acima dela, venda so abaixo).",
      signal: function (b, x, i) {
        if (crossUp(x.ema20, x.ema50, i) && x.c[i] > x.ema200[i]) return 1;
        if (crossDown(x.ema20, x.ema50, i) && x.c[i] < x.ema200[i]) return -1;
        return 0;
      } },
    { id: "pullback", name: "Pullback na tendencia", family: "Tendencia",
      desc: "Tendencia alinhada (EMA 20 > 50 > 200), o preco volta a EMA 20 e fecha de novo a favor, RSI sem exagero.",
      signal: function (b, x, i) {
        var k = b[i];
        if (x.ema20[i] > x.ema50[i] && x.ema50[i] > x.ema200[i] && k.l <= x.ema20[i] && k.c > x.ema20[i]
            && k.c > k.o && x.rsi[i] >= 40 && x.rsi[i] <= 65) return 1;
        if (x.ema20[i] < x.ema50[i] && x.ema50[i] < x.ema200[i] && k.h >= x.ema20[i] && k.c < x.ema20[i]
            && k.c < k.o && x.rsi[i] >= 35 && x.rsi[i] <= 60) return -1;
        return 0;
      } },
    { id: "rompimento", name: "Rompimento de 20 velas", family: "Rompimento",
      desc: "Fecha acima da maxima (ou abaixo da minima) das 20 velas anteriores, com volume 20% acima da media.",
      signal: function (b, x, i) {
        var vol = b[i].v > 1.2 * x.volSma[i];
        if (vol && x.c[i] > x.hh20[i]) return 1;
        if (vol && x.c[i] < x.ll20[i]) return -1;
        return 0;
      } },
    { id: "squeeze", name: "Compressao de Bollinger", family: "Rompimento",
      desc: "As bandas estavam entre as 20% mais estreitas das ultimas 120 velas e o preco fecha fora delas.",
      signal: function (b, x, i) {
        if (i < 121) return 0;
        var w = x.bbWidth[i - 1], below = 0;
        for (var j = i - 120; j < i; j++) if (x.bbWidth[j] < w) below++;
        if (below / 120 > 0.2) return 0;
        if (x.c[i] > x.bbUp[i]) return 1;
        if (x.c[i] < x.bbLo[i]) return -1;
        return 0;
      } },
    { id: "macd", name: "MACD cruzamento", family: "Momento",
      desc: "MACD cruza a linha de sinal, a favor da EMA 200.",
      signal: function (b, x, i) {
        if (crossUp(x.macd, x.macdSig, i) && x.c[i] > x.ema200[i]) return 1;
        if (crossDown(x.macd, x.macdSig, i) && x.c[i] < x.ema200[i]) return -1;
        return 0;
      } },
    { id: "rsi", name: "RSI volta de 30/70", family: "Reversao",
      desc: "RSI sai da zona de sobrevenda (volta acima de 30) ou de sobrecompra (volta abaixo de 70). Contra a tendencia.",
      signal: function (b, x, i) {
        if (x.rsi[i - 1] < 30 && x.rsi[i] >= 30) return 1;
        if (x.rsi[i - 1] > 70 && x.rsi[i] <= 70) return -1;
        return 0;
      } },
    { id: "engolfo", name: "Engolfo em suporte/resistencia", family: "Padrao de candle",
      desc: "Candle de engolfo de alta perto da minima de 20 velas (suporte), ou de baixa perto da maxima (resistencia).",
      signal: function (b, x, i) {
        var p = b[i - 1], k = b[i], a = x.atr[i];
        if (p.c < p.o && k.c > k.o && k.c >= p.o && k.o <= p.c && k.l - x.ll20[i] <= a) return 1;
        if (p.c > p.o && k.c < k.o && k.c <= p.o && k.o >= p.c && x.hh20[i] - k.h <= a) return -1;
        return 0;
      } }
  ];

  function signals(bars, x) {
    var out = {};
    STRATEGIES.forEach(function (s) {
      var arr = new Array(bars.length).fill(0);
      for (var i = WARMUP; i < bars.length; i++) arr[i] = s.signal(bars, x, i);
      out[s.id] = arr;
    });
    return out;
  }

  // ------------------------------------------------------------ backtest

  // One trade: signal at the close of i, entry at the open of i + 1, stop at
  // stopAtr x ATR, target at rr x the risk. Never reads past `last`.
  function simTrade(bars, x, i, dir, o, last) {
    if (i + 1 > last || !x.atr[i]) return null;
    var entry = bars[i + 1].o, risk = o.stopAtr * x.atr[i];
    var stop = entry - dir * risk, take = entry + dir * o.rr * risk;
    for (var j = i + 1; j <= last; j++) {
      var b = bars[j], hitStop = dir > 0 ? b.l <= stop : b.h >= stop;
      var hitTake = dir > 0 ? b.h >= take : b.l <= take, exit = null, why = null;
      if (hitStop) { exit = stop; why = "stop"; }            // both in one candle: assume the stop
      else if (hitTake) { exit = take; why = "alvo"; }
      else if (j - i >= o.maxHold) { exit = b.c; why = "tempo"; }
      if (exit !== null) {
        var r = dir * (exit - entry) / risk - o.fee * (entry + exit) / risk;
        return { i: i, entryIdx: i + 1, exitIdx: j, dir: dir, entry: entry, stop: stop, take: take,
                 exit: exit, why: why, r: r };
      }
    }
    return { i: i, entryIdx: i + 1, exitIdx: null, dir: dir, entry: entry, stop: stop, take: take, open: true };
  }

  function stats(trades) {
    var done = trades.filter(function (t) { return !t.open; });
    var n = done.length, wins = 0, pos = 0, neg = 0, streak = 0, worst = 0;
    done.forEach(function (t) {
      if (t.r > 0) { wins++; pos += t.r; streak = 0; } else { neg -= t.r; streak++; worst = Math.max(worst, streak); }
    });
    return { n: n, wins: wins, winRate: n ? wins / n : 0, expectancy: n ? (pos - neg) / n : 0,
             totalR: pos - neg, pf: neg ? pos / neg : (pos ? Infinity : 0), worstStreak: worst };
  }

  function backtest(bars, x, sig, opts, last) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    if (last === undefined) last = bars.length - 1;
    var trades = [], free = WARMUP;
    for (var i = Math.max(WARMUP, 1); i < last; i++) {
      if (i < free || !sig[i]) continue;
      var t = simTrade(bars, x, i, sig[i], o, last);
      if (!t) continue;
      trades.push(t);
      if (t.open) break;
      free = t.exitIdx;
    }
    return { trades: trades, all: stats(trades),
             buy: stats(trades.filter(function (t) { return t.dir > 0; })),
             sell: stats(trades.filter(function (t) { return t.dir < 0; })) };
  }

  // ------------------------------------------------------------ look-alike moments

  function features(bars, x, j) {
    var a = x.atr[j], c = x.c;
    if (!a || j < 12 || x.ema200[j] === null || x.bbUp[j] === null) return null;
    var band = x.bbUp[j] - x.bbLo[j] || 1;
    return [(c[j] - c[j - 1]) / a, (c[j] - c[j - 3]) / a, (c[j] - c[j - 6]) / a, (c[j] - c[j - 12]) / a,
            (x.rsi[j] - 50) / 10, (c[j] - x.ema20[j]) / a, (c[j] - x.ema50[j]) / a, (c[j] - x.ema200[j]) / (3 * a),
            2 * (c[j] - x.bbMid[j]) / band, Math.log(Math.max(bars[j].v, 1e-9) / Math.max(x.volSma[j], 1e-9))];
  }

  // The k past candles that looked most like candle i, and what came after
  // each one. Only candles whose whole outcome is before i are used.
  // feats: features() of every candle, computed once (see prepare).
  function analogs(bars, x, i, opts, feats) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var h = o.horizon, now = feats ? feats[i] : features(bars, x, i);
    if (!now) return null;
    var cands = [];
    for (var j = WARMUP; j + h < i; j++) {
      var f = feats ? feats[j] : features(bars, x, j);
      if (f) cands.push({ j: j, f: f });
    }
    if (cands.length < o.k * 3) return null;
    var dim = now.length, mean = new Array(dim).fill(0), sd = new Array(dim).fill(0), d;
    cands.forEach(function (cd) { for (d = 0; d < dim; d++) mean[d] += cd.f[d] / cands.length; });
    cands.forEach(function (cd) { for (d = 0; d < dim; d++) sd[d] += Math.pow(cd.f[d] - mean[d], 2) / cands.length; });
    sd = sd.map(function (s) { return Math.sqrt(s) || 1; });
    cands.forEach(function (cd) {
      var s = 0;
      for (d = 0; d < dim; d++) s += Math.pow((cd.f[d] - now[d]) / sd[d], 2);
      cd.dist = s;
    });
    cands.sort(function (a, b) { return a.dist - b.dist; });
    var picked = [];
    for (var n = 0; n < cands.length && picked.length < o.k; n++) {
      var cd = cands[n];
      if (picked.some(function (p) { return Math.abs(p.j - cd.j) < 4; })) continue;
      picked.push(cd);
    }
    var hold = Object.assign({}, o, { maxHold: h * 2 });
    var rets = [], longs = [], shorts = [];
    picked.forEach(function (p) {
      rets.push((x.c[p.j + h] - x.c[p.j]) / x.c[p.j]);
      var lt = simTrade(bars, x, p.j, 1, hold, i), st = simTrade(bars, x, p.j, -1, hold, i);
      if (lt && !lt.open) longs.push(lt);
      if (st && !st.open) shorts.push(st);
    });
    var sorted = rets.slice().sort(function (a, b) { return a - b; });
    return { k: picked.length, horizon: h, matches: picked.map(function (p) { return p.j; }),
             upRate: rets.filter(function (r) { return r > 0; }).length / rets.length,
             avgRet: rets.reduce(function (a, b) { return a + b; }, 0) / rets.length,
             medRet: sorted[Math.floor(sorted.length / 2)],
             long: stats(longs), short: stats(shorts) };
  }

  // ------------------------------------------------------------ the decision

  function trendScore(x, i) {
    if (x.ema200[i] === null) return 0;
    var s = 0;
    s += x.c[i] > x.ema200[i] ? 1 : -1;
    s += x.ema50[i] > x.ema200[i] ? 1 : -1;
    s += x.ema20[i] > x.ema50[i] ? 1 : -1;
    return s;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function floorStep(v, step) { return Math.floor(v / step + 1e-9) * step; }

  function decimals(step) { var s = String(step); return s.indexOf(".") < 0 ? 0 : s.length - s.indexOf(".") - 1; }

  // Everything that does not depend on "now": indicators, signals and every
  // strategy's trades over the whole history. All of it is causal (the value
  // at candle i only uses candles up to i), so decide() can stand at any
  // candle i and see exactly what it would have seen live.
  function prepare(bars, opts, htf) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var x = indicators(bars), sig = signals(bars, x), trades = {};
    STRATEGIES.forEach(function (s) { trades[s.id] = backtest(bars, x, sig[s.id], o).trades; });
    var p = { bars: bars, o: o, x: x, sig: sig, trades: trades,
              feats: bars.map(function (_, j) { return features(bars, x, j); }), htf: null };
    if (htf && htf.length > WARMUP && o.tfMs && o.htfMs) {
      var hx = indicators(htf), closeAt = new Array(bars.length).fill(-1), k = -1;
      for (var i = 0; i < bars.length; i++) {           // last higher-timeframe candle closed by the close of i
        while (k + 1 < htf.length && htf[k + 1].t + o.htfMs <= bars[i].t + o.tfMs) k++;
        closeAt[i] = k;
      }
      p.htf = { x: hx, at: closeAt };
    } else if (htf && htf.length > WARMUP) {
      var hx2 = indicators(htf);
      p.htf = { x: hx2, at: bars.map(function () { return htf.length - 1; }) };
    }
    return p;
  }

  // statistics of a strategy's trades that had ENDED by candle i
  function statsAt(trades, i, dir) {
    return stats(trades.filter(function (t) { return !t.open && t.exitIdx <= i && t.dir === dir; }));
  }

  // The verdict at the close of candle i, from what was known then.
  function decide(p, i, light) {
    var o = p.o, x = p.x, bars = p.bars;
    var RECENCY = [1, 0.6, 0.35], sum = 0, reasons = [], active = { 1: 0, "-1": 0 }, strategies = [];

    STRATEGIES.forEach(function (s) {
      var now = 0, age = null;
      for (var a = 0; a < RECENCY.length; a++) if (p.sig[s.id][i - a]) { now = p.sig[s.id][i - a]; age = a; break; }
      var side = now ? statsAt(p.trades[s.id], i, now) : null, weight = 0;
      if (side && side.n >= 8 && side.expectancy > 0) {
        weight = Math.min(side.expectancy, 1) * Math.min(1, side.n / 20) * RECENCY[age];
        sum += now * weight;
        active[now] += 1;
        if (!light) reasons.push({ dir: now, text: s.name + (age ? " (ha " + age + " vela" + (age > 1 ? "s" : "") + ")" : "")
          + ": " + pct(side.winRate) + " de acerto em " + side.n + " vezes, " + fmtR(side.expectancy) + " por trade" });
      } else if (side && !light) {
        reasons.push({ dir: 0, text: s.name + " deu sinal de " + (now > 0 ? "compra" : "venda")
          + ", mas nao tem vantagem no historico deste grafico (" + side.n + " vezes, " + fmtR(side.expectancy) + ")" });
      }
      if (!light) strategies.push({ id: s.id, name: s.name, family: s.family, desc: s.desc, now: now, age: age,
                                    weight: weight, buy: statsAt(p.trades[s.id], i, 1), sell: statsAt(p.trades[s.id], i, -1) });
    });

    var score = Math.tanh(sum * 1.5) * 50;
    // the look-alike search is the slow part: skip it when no strategy fired (it cannot create a signal alone)
    var an = (!light || active[1] || active[-1]) ? analogs(bars, x, i, o, p.feats) : null, anScore = 0;
    if (an) {
      anScore = clamp((an.long.expectancy - an.short.expectancy) * 15 + (an.upRate - 0.5) * 20, -25, 25);
      if (!light) reasons.push({ dir: Math.sign(Math.round(anScore)), text: an.k + " momentos parecidos no passado: "
        + pct(an.upRate) + " subiram nas " + an.horizon + " velas seguintes (mediana " + pctSigned(an.medRet) + ")" });
    }
    var ts = trendScore(x, i), tScore = ts / 3 * 15;
    if (!light) reasons.push({ dir: Math.sign(ts), text: "Tendencia neste tempo grafico: " + trendWord(ts)
      + (x.adx[i] !== null ? " (ADX " + x.adx[i].toFixed(0) + (x.adx[i] >= 25 ? ", com forca" : ", fraca") + ")" : "") });
    var htfTrend = null, hScore = 0;
    if (p.htf && p.htf.at[i] >= WARMUP) {
      htfTrend = trendScore(p.htf.x, p.htf.at[i]);
      hScore = htfTrend / 3 * 10;
      if (!light) reasons.push({ dir: Math.sign(htfTrend), text: "Tendencia no tempo grafico maior: " + trendWord(htfTrend) });
    }
    var total = clamp(score + anScore + tScore + hScore, -100, 100);
    var dir = total >= 20 ? 1 : total <= -20 ? -1 : 0, note = null;
    if (dir && !active[dir]) {
      note = "O contexto favorece " + (dir > 0 ? "compra" : "venda") + ", mas nenhuma estrategia com vantagem deu gatilho agora.";
      dir = 0;
    }
    return { i: i, time: bars[i].t, price: bars[i].c, score: Math.round(total), dir: dir, verdict: verdictOf(dir, total),
             note: note, reasons: reasons, strategies: strategies, analogs: an, trend: ts, htfTrend: htfTrend,
             parts: { strategies: Math.round(score), analogs: Math.round(anScore), trend: Math.round(tScore),
                      htf: Math.round(hScore) } };
  }

  function verdictOf(dir, total) {
    if (dir > 0) return total >= 45 ? "COMPRA FORTE" : "COMPRA";
    if (dir < 0) return total <= -45 ? "VENDA FORTE" : "VENDA";
    return "AGUARDAR";
  }

  // The robot's own record: stand at every candle from `from` on, decide with
  // only what was known then, and trade every signal with the same stop and
  // target (one trade at a time). No candle after the decision is used to make it.
  function walkForward(p, from, to) {
    var bars = p.bars, last = bars.length - 1, trades = [], free = 0;
    if (to === undefined) to = last - 1;
    for (var i = Math.max(from, WARMUP + 50); i <= to; i++) {
      if (i < free) continue;
      var d = decide(p, i, true);
      if (!d.dir) continue;
      var t = simTrade(bars, p.x, i, d.dir, p.o, last);
      if (!t) continue;
      t.score = d.score;
      trades.push(t);
      if (t.open) break;
      free = t.exitIdx;
    }
    var buys = trades.filter(function (t) { return t.dir > 0; }), sells = trades.filter(function (t) { return t.dir < 0; });
    return { from: Math.max(from, WARMUP + 50), trades: trades, all: stats(trades), buy: stats(buys), sell: stats(sells) };
  }

  // bars: closed candles only. htf: closed candles of the higher timeframe (optional).
  // opts.tfMs / opts.htfMs line the two timeframes up in time.
  function analyze(bars, opts, htf) {
    if (bars.length < WARMUP + 50) throw new Error("poucas velas para analisar (" + bars.length + ")");
    var p = prepare(bars, opts, htf), o = p.o, x = p.x, i = bars.length - 1;
    var d = decide(p, i, false);
    var wf = o.walkForward === false ? null : walkForward(p, Math.max(WARMUP + 50, i - (o.wfBars || 1500)), i - 1);
    var raw = d.verdict, blocked = null;
    if (wf && d.dir && o.requireEdge !== false && (wf.all.n < 10 || wf.all.expectancy <= 0)) {
      blocked = raw;
      d.note = "Pelas regras daria " + raw + ", mas neste par e tempo grafico o proprio robo ainda nao provou vantagem ("
        + wf.all.n + " sinais, " + fmtR(wf.all.expectancy) + " por trade). Sinal segurado.";
      d.dir = 0; d.verdict = "AGUARDAR";
    }
    var last = bars[i], a14 = x.atr[i], plan = null;
    if (d.dir) {
      var risk = o.stopAtr * a14, entry = last.c, fees = o.fee * 2 * entry;
      var qty = floorStep(o.maxLoss / (risk + fees), o.step);
      plan = { dir: d.dir, entry: entry, stop: entry - d.dir * risk, take1: entry + d.dir * risk,
               take2: entry + d.dir * o.rr * risk, risk: risk, riskPct: risk / entry, rr: o.rr,
               qty: Number(qty.toFixed(decimals(o.step))), maxLoss: qty * (risk + fees) };
    }
    var watch = { buyAbove: x.hh20[i] !== null ? Math.max(x.hh20[i], last.h) : null,
                  sellBelow: x.ll20[i] !== null ? Math.min(x.ll20[i], last.l) : null };
    // the strategy table shows the whole history, open trades included
    d.strategies.forEach(function (s) {
      var bt = { trades: p.trades[s.id], buy: s.buy, sell: s.sell };
      s.backtest = bt;
    });
    return Object.assign(d, { blocked: blocked, rsi: x.rsi[i], atr: a14, adx: x.adx[i], plan: plan, watch: watch,
                              robot: wf, ind: x, signals: p.sig });
  }

  function trendWord(s) {
    return s >= 3 ? "alta" : s >= 1 ? "alta fraca" : s <= -3 ? "baixa" : s <= -1 ? "baixa fraca" : "lateral";
  }
  function pct(v) { return Math.round(v * 100) + "%"; }
  function pctSigned(v) { return (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%"; }
  function fmtR(v) { return (v >= 0 ? "+" : "") + v.toFixed(2) + "R"; }

  var api = { WARMUP: WARMUP, DEFAULTS: DEFAULTS, STRATEGIES: STRATEGIES, sma: sma, ema: ema, rsi: rsi,
              atr: atr, adx: adx, indicators: indicators, signals: signals, simTrade: simTrade,
              backtest: backtest, stats: stats, analogs: analogs, analyze: analyze, prepare: prepare,
              decide: decide, walkForward: walkForward, features: features, trendScore: trendScore,
              fmtR: fmtR, pct: pct, pctSigned: pctSigned };
  root.Robo = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
