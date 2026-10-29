#!/usr/bin/env node
/* Lab: variants of the POI (version 2) on the same data and desk, MT5 costs.
 *
 *   node agency/lab-variants.js [--out variants.json]
 *
 *   base      stop a little below the wick of the POI (its pull-down)
 *   sweep     stop a little below the wick of the liquidity sweep
 *   volume    base + Wyckoff spring filter: the sweep candle trades less than its average volume
 *   both      sweep stop + volume filter
 *   wyckoffRange  base, plus the spring volume rule only when the sweep is at the edge of a sideways 15m structure
 *   wyckoffContext  inside a sideways 15m structure (12h, 6 ATR), buy only after a fall and sell only after a rise
 * Each with and without the 1h macro filter. 5-minute trigger, 15-minute liquidity:
 * one year of BTC (Binance) and 60 days of gold and currency futures (Yahoo).
 */
"use strict";

const path = require("path");
const fs = require("fs");
const M = require(path.join(__dirname, "method.js"));

const MARKETS = [
  { id: "BTCUSDT", short: "BTC", src: "binance", fee: 0.0002 },
  { id: "GC=F", short: "XAU", src: "yahoo", fee: 0.00005 },
  { id: "6E=F", short: "EUR", src: "yahoo", fee: 0.00003 },
  { id: "6B=F", short: "GBP", src: "yahoo", fee: 0.00003 },
  { id: "6J=F", short: "JPY", src: "yahoo", fee: 0.00003 },
  { id: "6A=F", short: "AUD", src: "yahoo", fee: 0.00003 }];
const VARIANTS = { base: {}, sweep: { stopAt: "sweep" }, volume: { sweepVolMax: 1 }, both: { stopAt: "sweep", sweepVolMax: 1 },
  wyckoffRange: { wyckoffRange: true }, wyckoffContext: { wyckoffContext: true } };
const DESK = { stopUsd: 50, capital: 5000, maxStopsPerDay: 2, block: 25 };

async function getJSON(url) {
  let last;
  for (let k = 0; k < 3; k++) {
    try { const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (agency-lab)" } }); if (r.ok) return await r.json(); last = new Error(r.status + " " + url); }
    catch (e) { last = e; }
    await new Promise(res => setTimeout(res, 800 * (k + 1)));
  }
  throw last;
}
async function binance(symbol, pages) {
  let all = [], end = null;
  for (let n = 0; n < pages; n++) {
    const rows = await getJSON("https://data-api.binance.vision/api/v3/klines?symbol=" + symbol + "&interval=5m&limit=1000" + (end ? "&endTime=" + end : ""));
    all = rows.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })).concat(all);
    if (rows.length < 1000) break;
    end = rows[0][0] - 1;
  }
  return all;
}
async function yahoo(symbol) {
  const d = await getJSON("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?interval=5m&range=60d");
  const r = d.chart.result[0], q = r.indicators.quote[0], bars = [];
  (r.timestamp || []).forEach((t, i) => {
    if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(v => v === null || v === undefined)) return;
    bars.push({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
  });
  return bars;
}

function summary(runs) {
  const d = M.desk(runs, DESK), by = {};
  d.closed.forEach(t => { const s = by[t.short] || (by[t.short] = { n: 0, r: 0 }); s.n++; s.r += t.r; });
  Object.keys(by).forEach(k => { by[k].exp = +(by[k].r / by[k].n).toFixed(2); delete by[k].r; });
  return { n: d.n, winRate: +(d.winRate * 100).toFixed(0), expR: +d.expectancy.toFixed(2), usd: Math.round(d.pnl), maxDD: Math.round(d.maxDD), byMarket: by };
}

async function main() {
  const args = process.argv.slice(2), out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
  const data = {};
  for (const m of MARKETS) {
    try { data[m.id] = m.src === "binance" ? await binance(m.id, 105) : await yahoo(m.id); }
    catch (e) { process.stderr.write(m.short + ": sem dados (" + e.message + ")\n"); }
  }
  const report = { at: new Date().toISOString(), desk: DESK, results: {} };
  for (const align of ["none", "bias"]) {
    for (const v of Object.keys(VARIANTS)) {
      const runs = MARKETS.filter(m => data[m.id]).map(m => ({ id: m.id, short: m.short, bars: data[m.id], fee: m.fee,
        trades: M.poiSetups(data[m.id], Object.assign({ fee: m.fee, htfMs: 9e5, align, macroMs: 36e5 }, VARIANTS[v])).trades }));
      report.results[v + (align === "bias" ? "+macro1h" : "")] = summary(runs);
    }
  }
  const txt = JSON.stringify(report, null, 1);
  if (out) fs.writeFileSync(out, txt);
  console.log(txt);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
