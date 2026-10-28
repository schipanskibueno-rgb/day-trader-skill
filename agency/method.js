/* The trading desk's method, written as rules a program can follow and test.
 * It encodes the course material the agency studies:
 *
 *   MACRO (1h, built from the 15m candles): the flow of pivots (higher highs
 *   and higher lows, or lower ones), a change of character (CHoCH) when the
 *   last pivot breaks against the flow, who holds "control" since the last
 *   high-volume candle, and the health of the trend (are impulses getting
 *   longer or shorter, are pullbacks getting deeper).
 *
 *   MICRO (15m, the timing): a sideways range (cause) that price leaves with
 *   a wide, high-volume candle (imbalance) becomes a REGION OF INTEREST. Its
 *   volume profile gives the POC and the value area (VAL..VAH, 70% of the
 *   volume). The trade is the return to that region with DISINTEREST (the
 *   pullback trades less volume than the impulse) and an absorption candle
 *   that closes above the open of the last down candle (mirror for sells).
 *
 *   ONLY ALIGNED: the region must point the same way as the macro flow.
 *
 *   MANAGEMENT: fixed money risk per trade (the stop), target 3R and nothing
 *   closes early, at most 2 stops a day (then the desk goes home until the
 *   next day), results counted in blocks of 25 trades.
 *
 * A candle is {t, o, h, l, c, v}. Everything is causal: a decision at candle
 * i reads candles up to i, and an entry fills at the open of candle i + 1.
 */
(function (root) {
  "use strict";

  var P = {
    atrN: 14, volN: 20, pivot: 3,
    boxBars: 16, boxAtr: 2.5,            // a range: 16 candles inside 2.5 ATR
    breakVol: 1.5, breakSpread: 1.2,      // the imbalance candle: 1.5x volume, 1.2 ATR wide
    bins: 24, valueArea: 0.7,             // volume profile of the range
    testVol: 0.8,                         // pullback volume under 80% of the impulse volume
    zoneLife: 96,                         // a region stays valid for 96 candles (24h on 15m)
    stopBuffer: 0.2, minRiskAtr: 0.3, maxRiskAtr: 4,
    rr: 3, maxStopsPerDay: 2, block: 25, macroMs: 36e5, fee: 0, maxFeeR: 0.25, align: "bias",
    climaxVol: 2.0, climaxSpread: 1.2     // the "last high volume" that sets control
  };

  // ------------------------------------------------------------ basics

  function atr(b, n) {
    var out = new Array(b.length).fill(null), a = 0;
    for (var i = 0; i < b.length; i++) {
      var tr = i ? Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)) : b[i].h - b[i].l;
      if (i < n) { a += tr; if (i === n - 1) { a /= n; out[i] = a; } }
      else { a = (a * (n - 1) + tr) / n; out[i] = a; }
    }
    return out;
  }

  function sma(v, n) {
    var out = new Array(v.length).fill(null), s = 0;
    for (var i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) out[i] = s / n; }
    return out;
  }

  // 15m -> 1h candles, keeping the index of the last 15m candle inside each hour
  function aggregate(b, ms) {
    var out = [], cur = null;
    b.forEach(function (x, i) {
      var t = Math.floor(x.t / ms) * ms;
      if (!cur || cur.t !== t) { cur = { t: t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v, last: i }; out.push(cur); }
      else { cur.h = Math.max(cur.h, x.h); cur.l = Math.min(cur.l, x.l); cur.c = x.c; cur.v += x.v; cur.last = i; }
    });
    return out;
  }

  // ------------------------------------------------------------ macro: flow, CHoCH, control, health

  // pivots confirmed k candles after they print (so they are known only then)
  function pivots(b, k) {
    var hi = [], lo = [];
    for (var i = k; i < b.length - k; i++) {
      var isH = true, isL = true;
      for (var j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (b[j].h >= b[i].h) isH = false;
        if (b[j].l <= b[i].l) isL = false;
      }
      if (isH) hi.push({ i: i, p: b[i].h, known: i + k });
      if (isL) lo.push({ i: i, p: b[i].l, known: i + k });
    }
    return { hi: hi, lo: lo };
  }

  // the macro state after each 1h candle h
  function macroStates(hb) {
    var a = atr(hb, P.atrN), vs = sma(hb.map(function (x) { return x.v; }), P.volN), pv = pivots(hb, P.pivot);
    var states = [], flow = 0, control = null;
    for (var h = 0; h < hb.length; h++) {
      var H = pv.hi.filter(function (p) { return p.known <= h; }), L = pv.lo.filter(function (p) { return p.known <= h; });
      var h1 = H[H.length - 1], h0 = H[H.length - 2], l1 = L[L.length - 1], l0 = L[L.length - 2];
      if (h1 && h0 && l1 && l0) {
        if (h1.p > h0.p && l1.p > l0.p) flow = 1;
        else if (h1.p < h0.p && l1.p < l0.p) flow = -1;
      }
      var choch = null;
      if (flow < 0 && h1 && hb[h].c > h1.p) { flow = 1; choch = "alta"; }      // broke the last top against a down flow
      else if (flow > 0 && l1 && hb[h].c < l1.p) { flow = -1; choch = "baixa"; }
      // control: the last wide, high-volume candle, while price holds beyond its far end
      if (a[h] && vs[h] && hb[h].v >= P.climaxVol * vs[h] && hb[h].h - hb[h].l >= P.climaxSpread * a[h]) {
        var d = hb[h].c >= hb[h].o ? 1 : -1;
        control = { dir: d, level: d > 0 ? hb[h].l : hb[h].h, t: hb[h].t };
      }
      if (control && ((control.dir > 0 && hb[h].c < control.level) || (control.dir < 0 && hb[h].c > control.level))) {
        control = { dir: -control.dir, level: control.level, t: control.t, lost: true };
      }
      // health: compare the last two impulses (projection) and pullbacks (depth) of the flow
      var health = 0;
      if (flow > 0 && H.length >= 2 && L.length >= 2) {
        var up1 = h1.p - l1.p, up0 = h0.p - l0.p, dn1 = h1.p - (L[L.length - 1].p), dn0 = h0.p - l0.p;
        health = (up1 >= up0 ? 1 : -1) + (dn1 <= dn0 ? 0 : -0);
      } else if (flow < 0 && H.length >= 2 && L.length >= 2) {
        var d1 = h1.p - l1.p, d0 = h0.p - l0.p;
        health = d1 >= d0 ? 1 : -1;
      }
      var bias = flow;
      if (control && control.dir !== flow) bias = 0;                      // flow and control disagree: no clarity
      states.push({ flow: flow, choch: choch, control: control, health: health, bias: bias,
                    lastHigh: h1 ? h1.p : null, lastLow: l1 ? l1.p : null });
    }
    return states;
  }

  // ------------------------------------------------------------ micro: regions of interest

  function profile(b, from, to) {
    var lo = Infinity, hi = -Infinity;
    for (var i = from; i <= to; i++) { lo = Math.min(lo, b[i].l); hi = Math.max(hi, b[i].h); }
    var n = P.bins, step = (hi - lo) / n || 1e-9, vol = new Array(n).fill(0), total = 0;
    for (i = from; i <= to; i++) {
      var a = Math.max(0, Math.floor((b[i].l - lo) / step)), z = Math.min(n - 1, Math.floor((b[i].h - lo) / step));
      var share = (b[i].v || 1) / (z - a + 1);
      for (var k = a; k <= z; k++) { vol[k] += share; total += share; }
    }
    var poc = 0;
    for (k = 1; k < n; k++) if (vol[k] > vol[poc]) poc = k;
    var dn = poc, up = poc, inside = vol[poc];
    while (inside < P.valueArea * total && (dn > 0 || up < n - 1)) {
      var below = dn > 0 ? vol[dn - 1] : -1, above = up < n - 1 ? vol[up + 1] : -1;
      if (above >= below) { up++; inside += vol[up]; } else { dn--; inside += vol[dn]; }
    }
    return { lo: lo, hi: hi, poc: lo + (poc + 0.5) * step, val: lo + dn * step, vah: lo + (up + 1) * step };
  }

  // every candle that leaves a range with an imbalance creates a region
  function findRegions(b, a, vs) {
    var out = [];
    for (var i = P.boxBars + P.atrN; i < b.length; i++) {
      var from = i - P.boxBars, hi = -Infinity, lo = Infinity;
      for (var j = from; j < i; j++) { hi = Math.max(hi, b[j].h); lo = Math.min(lo, b[j].l); }
      if (!a[i - 1] || hi - lo > P.boxAtr * a[i - 1]) continue;
      var x = b[i], wide = x.h - x.l >= P.breakSpread * a[i - 1], loud = vs[i - 1] && x.v >= P.breakVol * vs[i - 1];
      var dir = x.c > hi ? 1 : x.c < lo ? -1 : 0;
      if (!dir || !wide || (!loud && x.v > 0)) continue;     // markets without volume data only need the wide candle
      var pr = profile(b, from, i - 1);
      out.push({ i: i, dir: dir, box: { from: from, to: i - 1, hi: hi, lo: lo }, poc: pr.poc, val: pr.val, vah: pr.vah });
    }
    return out;
  }

  // ------------------------------------------------------------ the setups

  // walks every region forward and returns the trades its rules would take
  function setups(b, opts) {
    var o = Object.assign({}, P, opts || {});
    var a = atr(b, o.atrN), vs = sma(b.map(function (x) { return x.v; }), o.volN);
    var hb = aggregate(b, o.macroMs), ms = macroStates(hb);
    var hourOf = new Array(b.length).fill(-1);
    hb.forEach(function (h, k) { hourOf[h.last] = k; });
    var lastClosedHour = new Array(b.length).fill(-1), cur = -1;
    for (var i = 0; i < b.length; i++) { if (hourOf[i] >= 0) cur = hourOf[i]; lastClosedHour[i] = cur; }

    var regions = findRegions(b, a, vs), out = [];
    regions.forEach(function (z) {
      var d = z.dir, peak = d > 0 ? -Infinity : Infinity, peakIdx = z.i, impVol = 0, impN = 0;
      for (var j = z.i; j < b.length - 1 && j - z.i <= o.zoneLife; j++) {
        var x = b[j];
        if ((d > 0 && x.h > peak) || (d < 0 && x.l < peak)) {
          peak = d > 0 ? x.h : x.l; peakIdx = j;
          impVol = 0; impN = 0;
          for (var k = z.i; k <= j; k++) { impVol += b[k].v; impN++; }
        }
        var far = d > 0 ? z.val : z.vah;
        if ((d > 0 && x.c < far - 0.5 * a[j]) || (d < 0 && x.c > far + 0.5 * a[j])) break;   // region lost
        if (j <= peakIdx) continue;
        var near = d > 0 ? z.vah : z.val;
        var touched = d > 0 ? x.l <= near : x.h >= near;
        if (!touched) continue;
        var pbVol = 0;
        for (k = peakIdx + 1; k <= j; k++) pbVol += b[k].v;
        var pbAvg = pbVol / (j - peakIdx), impAvg = impVol / Math.max(1, impN);
        var quiet = impAvg === 0 || pbAvg < o.testVol * impAvg;
        // absorption: closes beyond the open of the last candle against the trade
        var lastAgainst = null;
        for (k = j - 1; k > peakIdx && lastAgainst === null; k--) if ((d > 0 && b[k].c < b[k].o) || (d < 0 && b[k].c > b[k].o)) lastAgainst = k;
        var absorb = lastAgainst !== null && (d > 0 ? x.c > x.o && x.c > b[lastAgainst].o : x.c < x.o && x.c < b[lastAgainst].o);
        if (!quiet || !absorb) continue;
        var h = lastClosedHour[j], m = h >= 0 ? ms[h] : null;
        var gate = o.align === "none" ? d : o.align === "flow" ? (m ? m.flow : 0) : (m ? m.bias : 0);
        if (gate !== d) continue;                                      // only aligned with the macro
        var entry = b[j + 1].o, stop = (d > 0 ? z.val : z.vah) - d * o.stopBuffer * a[j];
        var risk = d * (entry - stop);
        if (risk < o.minRiskAtr * a[j] || risk > o.maxRiskAtr * a[j]) break;
        if (2 * o.fee * entry > o.maxFeeR * risk) break;                // the fee would eat more than 0.25R
        out.push({ i: j, entryIdx: j + 1, dir: d, entry: entry, stop: stop, take: entry + d * o.rr * risk, risk: risk,
                   region: { poc: z.poc, val: z.val, vah: z.vah, from: b[z.box.from].t, to: b[z.box.to].t, born: b[z.i].t },
                   why: { pullbackVol: Math.round(pbAvg / (impAvg || 1) * 100), macro: m } });
        break;                                                         // one trade per region
      }
    });
    out.sort(function (x, y) { return x.entryIdx - y.entryIdx; });
    return { trades: out, regions: regions, macro: ms, hours: hb, lastClosedHour: lastClosedHour, atr: a, volSma: vs };
  }

  // ------------------------------------------------------------ version 2: POI after a liquidity sweep
  //
  // The entry the course teaches in its live sessions, as rules:
  //   LIQUIDITY: tops and bottoms of the higher chart (15m for a 5m trigger)
  //   rest orders beyond them. A candle that trades past one "cleans" it.
  //   POI: after the sweep, the trigger chart rises (the "1, 2, 3"), pulls
  //   down breaking a small bottom of that rise but holding a bottom higher
  //   than the sweep, close to it, and then pulls up through the top the
  //   pull-down started from. The pull-down is the zone: the last down candle
  //   in it, from its body top to the bottom of the pull-down.
  //   ENTRY: a limit order at the top of the zone while the move is young; the
  //   stop goes below the pull-down; target 3R. If price reaches the target
  //   or the stop before filling, the trade is gone.
  // Sells are the mirror image. Everything is causal like the rest of the file.

  var POI = {
    htfMs: 9e5, htfPivot: 3, ltfPivot: 2,
    huntLife: 36,          // the POI must confirm within 36 candles of the sweep (3h on 5m)
    maxRunHtfAtr: 1.5,     // a sweep that runs more than 1.5 higher-chart ATR is a breakdown, not a sweep
    nearHtfAtr: 1.0,       // the higher bottom sits within 1 higher-chart ATR of the sweep low
    entryLife: 24,         // the limit order waits 24 candles
    stopBufferPoi: 0.1, breakMinor: true, align: "none"
  };

  function mirror(b) {
    return b.map(function (x) { return { t: x.t, o: -x.o, h: -x.l, l: -x.h, c: -x.c, v: x.v }; });
  }

  // buys only; sells run on the mirrored chart
  function poiBuys(b, o, gateAt) {
    var a = atr(b, o.atrN), hb = aggregate(b, o.htfMs), ha = atr(hb, o.atrN);
    var hp = pivots(hb, o.htfPivot), lp = pivots(b, o.ltfPivot);
    var htfAt = new Array(b.length).fill(-1), cur = -1;
    hb.forEach(function (h, k) { htfAt[h.last] = k; });
    for (var i = 0; i < b.length; i++) { if (htfAt[i] >= 0) cur = htfAt[i]; htfAt[i] = cur; }
    // higher-chart bottoms become liquidity once confirmed, at the base candle that closes their confirming hour
    var levels = hp.lo.filter(function (p) { return p.known < hb.length; })
      .map(function (p) { return { p: p.p, from: hb[p.known].last + 1 }; }).sort(function (x, y) { return x.from - y.from; });
    var active = [], next = 0, out = [], seen = {};
    for (i = 1; i < b.length; i++) {
      while (next < levels.length && levels[next].from <= i) active.push(levels[next++]);
      var swept = active.filter(function (z) { return b[i].l < z.p; });
      if (!swept.length) continue;
      active = active.filter(function (z) { return b[i].l >= z.p; });
      var lvl = Math.min.apply(null, swept.map(function (z) { return z.p; }));
      var t = hunt(b, a, ha, htfAt, lp, o, i, lvl, gateAt);
      if (t && !seen[t.key]) { seen[t.key] = true; out.push(t); }
    }
    return out;
  }

  function hunt(b, a, ha, htfAt, lp, o, s, lvl, gateAt) {
    var hA = htfAt[s] >= 0 ? ha[htfAt[s]] : null;
    if (!hA) return null;
    var ext = b[s].l, extIdx = s;
    for (var j = s + 1; j < b.length && j <= s + o.huntLife; j++) {
      if (b[j].l < ext) { ext = b[j].l; extIdx = j; }
      if (ext < lvl - o.maxRunHtfAtr * hA) return null;                 // not a sweep: price kept going
      var lows = lp.lo.filter(function (p) { return p.known <= j && p.i > extIdx; });
      if (!lows.length) continue;
      var PL = lows[lows.length - 1];
      if (PL.p <= ext || PL.p - ext > o.nearHtfAtr * hA) continue;     // a higher bottom, close to the sweep
      var highs = lp.hi.filter(function (p) { return p.known <= j && p.i > extIdx && p.i < PL.i; });
      if (!highs.length) continue;
      var PH = highs[highs.length - 1];
      if (o.breakMinor) {
        var minor = lows.filter(function (p) { return p.i < PH.i; });
        if (!minor.length || PL.p >= minor[minor.length - 1].p) continue;   // the pull-down broke a small bottom
      }
      if (b[j].c <= PH.p) continue;                                     // pulls up through the top: confirmed
      if (gateAt && gateAt(j) !== 1) return null;
      var ob = null;
      for (var k = PL.i; k >= PH.i && ob === null; k--) if (b[k].c < b[k].o) ob = k;
      var zoneHi = ob !== null ? Math.max(b[ob].o, b[PL.i].c) : b[PL.i].h;
      var stop = PL.p - o.stopBufferPoi * a[j], plan = zoneHi - stop;
      if (!(plan > 0) || plan < o.minRiskAtr * a[j] || plan > o.maxRiskAtr * a[j]) return null;
      if (2 * o.fee * Math.abs(zoneHi) > o.maxFeeR * plan) return null;
      for (k = j + 1; k < b.length && k <= j + o.entryLife; k++) {
        if (b[k].h >= zoneHi + o.rr * plan) return null;                // ran away before filling
        if (b[k].l <= zoneHi) {
          var entry = Math.min(b[k].o, zoneHi);
          if (entry <= stop) return null;
          var risk = entry - stop;
          return { key: PL.i + ":" + j, i: j, entryIdx: k, dir: 1, entry: entry, stop: stop, take: entry + o.rr * risk, risk: risk,
                   limit: true, poi: { sweepT: b[s].t, level: lvl, low: ext, pullLow: PL.p, top: PH.p, zone: [PL.p, zoneHi] } };
        }
      }
      return null;
    }
    return null;
  }

  function flipTrade(t) {
    return Object.assign({}, t, { dir: -1, entry: -t.entry, stop: -t.stop, take: -t.take,
      poi: { sweepT: t.poi.sweepT, level: -t.poi.level, high: -t.poi.low, pullHigh: -t.poi.pullLow, bottom: -t.poi.top,
             zone: [-t.poi.zone[1], -t.poi.zone[0]] } });
  }

  // same shape as setups(): { trades }, so the desk and the blocks of 25 work unchanged
  function poiSetups(b, opts) {
    var o = Object.assign({}, P, POI, opts || {});
    var gate = null;
    if (o.align !== "none") {
      var hb = aggregate(b, o.macroMs), ms = macroStates(hb), last = new Array(b.length).fill(-1), c = -1;
      hb.forEach(function (h, k) { last[h.last] = k; });
      for (var i = 0; i < b.length; i++) { if (last[i] >= 0) c = last[i]; last[i] = c; }
      gate = function (j) { var m = last[j] >= 0 ? ms[last[j]] : null; return m ? (o.align === "flow" ? m.flow : m.bias) : 0; };
    }
    var buys = poiBuys(b, o, gate);
    var sells = poiBuys(mirror(b), o, gate ? function (j) { return -gate(j); } : null).map(flipTrade);
    var trades = buys.concat(sells).sort(function (x, y) { return x.entryIdx - y.entryIdx; });
    return { trades: trades };
  }

  // stop or target, whichever is hit first (both in one candle: the stop). No time exit.
  function resolve(b, t, fee) {
    for (var j = t.entryIdx; j < b.length; j++) {
      var x = b[j], hitStop = t.dir > 0 ? x.l <= t.stop : x.h >= t.stop, hitTake = t.dir > 0 ? x.h >= t.take : x.l <= t.take;
      if (t.limit && j === t.entryIdx) hitTake = false;                // a limit fill: the high may have come before it
      if (hitStop || hitTake) {
        var exit = hitStop ? t.stop : t.take;
        var r = t.dir * (exit - t.entry) / t.risk - fee * (t.entry + exit) / t.risk;
        return Object.assign({}, t, { exitIdx: j, exitT: x.t, exit: exit, r: r, result: hitStop ? "stop" : "alvo" });
      }
    }
    return Object.assign({}, t, { open: true, lastPrice: b[b.length - 1].c,
                                  openR: t.dir * (b[b.length - 1].c - t.entry) / t.risk });
  }

  function dayOf(t) { return new Date(t).toISOString().slice(0, 10); }

  // The desk: trades of all markets in time order, fixed money risk, at most
  // maxStopsPerDay stops a day (counted when they happen), then no new trade
  // until the next day. Positions already open keep their stop and target.
  function desk(markets, cfg) {
    var stopUsd = cfg.stopUsd, capital = cfg.capital, events = [];
    markets.forEach(function (m) {
      m.trades.forEach(function (t) {
        var r = resolve(m.bars, t, m.fee);
        r.market = m.id; r.short = m.short; r.entryT = m.bars[t.entryIdx].t;
        events.push(r);
      });
    });
    events.sort(function (x, y) { return x.entryT - y.entryT; });
    var taken = [], skipped = [], stopsByDay = {}, closedDays = {};
    events.forEach(function (e) {
      var day = dayOf(e.entryT);
      // stops that already happened today, before this entry
      var stopsSoFar = taken.filter(function (t) { return !t.open && t.result === "stop" && dayOf(t.exitT) === day && t.exitT <= e.entryT; }).length;
      if (stopsSoFar >= cfg.maxStopsPerDay) { skipped.push(Object.assign(e, { skippedWhy: "2 stops no dia" })); closedDays[day] = true; return; }
      // one position at a time per market
      if (taken.some(function (t) { return t.market === e.market && (t.open || t.exitT > e.entryT); })) { skipped.push(Object.assign(e, { skippedWhy: "ja posicionado" })); return; }
      taken.push(e);
    });
    taken.forEach(function (t) {
      if (t.result === "stop") stopsByDay[dayOf(t.exitT)] = (stopsByDay[dayOf(t.exitT)] || 0) + 1;
      t.usd = t.open ? null : t.r * stopUsd;
      t.openUsd = t.open ? t.openR * stopUsd : null;
      t.size = stopUsd / t.risk;
      t.notional = t.size * t.entry;
    });
    Object.keys(stopsByDay).forEach(function (d) { if (stopsByDay[d] >= cfg.maxStopsPerDay) closedDays[d] = true; });
    var closed = taken.filter(function (t) { return !t.open; }).sort(function (x, y) { return x.exitT - y.exitT; });
    var eq = capital, peak = capital, dd = 0, curve = [];
    closed.forEach(function (t) { eq += t.usd; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); curve.push({ t: t.exitT, eq: eq }); });
    var wins = closed.filter(function (t) { return t.r > 0; }).length;
    var blocks = [];
    for (var k = 0; k < closed.length; k += cfg.block) {
      var part = closed.slice(k, k + cfg.block), sum = part.reduce(function (s, t) { return s + t.usd; }, 0);
      blocks.push({ n: part.length, wins: part.filter(function (t) { return t.r > 0; }).length, usd: sum, done: part.length === cfg.block });
    }
    return { trades: taken, skipped: skipped, closed: closed, open: taken.filter(function (t) { return t.open; }),
             equity: eq, pnl: eq - capital, maxDD: dd, n: closed.length, wins: wins,
             winRate: closed.length ? wins / closed.length : 0,
             expectancy: closed.length ? closed.reduce(function (s, t) { return s + t.r; }, 0) / closed.length : 0,
             closedDays: Object.keys(closedDays).sort(), stopsByDay: stopsByDay, blocks: blocks, curve: curve };
  }

  // what the desk sees right now on one market (for the screens and the meeting)
  function snapshot(b, s) {
    var i = b.length - 1, h = s.lastClosedHour[i], m = h >= 0 ? s.macro[h] : null;
    var live = s.regions.filter(function (z) { return i - z.i <= P.zoneLife; }).slice(-3);
    var vs = s.volSma[i], a = s.atr[i], x = b[i];
    return {
      price: x.c, atr: a, relVol: vs ? x.v / vs : null,
      macro: m ? { flow: m.flow, bias: m.bias, choch: m.choch, health: m.health,
                   control: m.control ? { dir: m.control.dir, level: m.control.level, lost: !!m.control.lost } : null,
                   lastHigh: m.lastHigh, lastLow: m.lastLow } : null,
      regions: live.map(function (z) { return { dir: z.dir, poc: z.poc, val: z.val, vah: z.vah, born: b[z.i].t,
                                                aligned: !!(m && m.bias === z.dir) }; })
    };
  }

  var api = { P: P, atr: atr, sma: sma, aggregate: aggregate, pivots: pivots, macroStates: macroStates, profile: profile,
              findRegions: findRegions, setups: setups, POI: POI, poiSetups: poiSetups, mirror: mirror, resolve: resolve, desk: desk, snapshot: snapshot, dayOf: dayOf };
  root.Method = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
