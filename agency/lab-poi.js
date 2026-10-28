#!/usr/bin/env node
/* Lab: the POI after a liquidity sweep (version 2) against the current rules
 * (version 1) on the same real data, with the same desk: fixed money stop,
 * target 3R, at most 2 stops a day, fees of each venue.
 *
 *   node agency/lab-poi.js [--out lab-poi.json]
 *
 * Intraday test: 5-minute trigger with the 15-minute chart for liquidity
 * (Binance: one year of BTC; Yahoo: the last 60 days of gold and currency
 * futures). Fractal test: 1-hour trigger with the 4-hour chart, two years.
 * Version 1 reads 15-minute candles (1h macro) intraday and 1h candles (4h
 * macro) in the fractal test, as the brain does. Each test runs twice: with
 * the fees of the data venue (Binance spot charges 0.1% a side on BTC) and
 * with an estimate of the MT5 demo spread (BTC 0.02%, gold 0.005% and
 * currencies 0.003% of the price a side).
 * Node 18+, no packages.
 */
"use strict";

const path = require("path");
const fs = require("fs");
const M = require(path.join(__dirname, "method.js"));

const MIN5 = 3e5, MIN15 = 9e5, HOUR = 36e5;
const UA = { "User-Agent": "Mozilla/5.0 (agency-lab)" };
const MARKETS = [
  { id: "BTCUSDT", short: "BTC", src: "binance", fee: 0.001, mt5Fee: 0.0002 },
  { id: "GC=F", short: "XAU", src: "yahoo", fee: 0.0002, mt5Fee: 0.00005 },
  { id: "6E=F", short: "EUR", src: "yahoo", fee: 0.0001, mt5Fee: 0.00003 },
  { id: "6B=F", short: "GBP", src: "yahoo", fee: 0.0001, mt5Fee: 0.00003 },
  { id: "6J=F", short: "JPY", src: "yahoo", fee: 0.0001, mt5Fee: 0.00003 },
  { id: "6A=F", short: "AUD", src: "yahoo", fee: 0.0001, mt5Fee: 0.00003 }];
const DESK = { stopUsd: 80, capital: 5000, maxStopsPerDay: 2, block: 25 };

async function getJSON(url) {
  let last;
  for (let k = 0; k < 3; k++) {
    try { const r = await fetch(url, { headers: UA }); if (r.ok) return await r.json(); last = new Error(r.status + " " + url); }
    catch (e) { last = e; }
    await new Promise(res => setTimeout(res, 800 * (k + 1)));
  }
  throw last;
}

async function binance(symbol, interval, pages) {
  let all = [], end = null;
  for (let n = 0; n < pages; n++) {
    const rows = await getJSON("https://data-api.binance.vision/api/v3/klines?symbol=" + symbol + "&interval=" + interval +
      "&limit=1000" + (end ? "&endTime=" + end : ""));
    all = rows.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })).concat(all);
    if (rows.length < 1000) break;
    end = rows[0][0] - 1;
  }
  return all;
}

async function yahoo(symbol, interval, range) {
  const d = await getJSON("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) +
    "?interval=" + interval + "&range=" + range);
  const r = d.chart.result[0], q = r.indicators.quote[0], bars = [];
  (r.timestamp || []).forEach((t, i) => {
    if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(v => v === null || v === undefined)) return;
    bars.push({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
  });
  return bars;
}

function summary(runs) {
  const d = M.desk(runs, DESK);
  const byMarket = {};
  d.closed.forEach(t => { const s = byMarket[t.short] || (byMarket[t.short] = { n: 0, r: 0 }); s.n++; s.r += t.r; });
  Object.keys(byMarket).forEach(k => { byMarket[k].exp = +(byMarket[k].r / byMarket[k].n).toFixed(2); delete byMarket[k].r; });
  return { n: d.n, winRate: +(d.winRate * 100).toFixed(0), expR: +d.expectancy.toFixed(2), usd: Math.round(d.pnl),
           maxDD: Math.round(d.maxDD), blocks: d.blocks.map(b => Math.round(b.usd)), byMarket };
}

async function main() {
  const args = process.argv.slice(2), outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
  const data = {};
  for (const m of MARKETS) {
    try {
      data[m.id] = m.src === "binance"
        ? { m5: await binance(m.id, "5m", 105), h1: await binance(m.id, "1h", 18) }
        : { m5: await yahoo(m.id, "5m", "60d"), h1: await yahoo(m.id, "1h", "730d") };
      process.stderr.write(m.short + ": " + data[m.id].m5.length + " candles de 5m, " + data[m.id].h1.length + " de 1h\n");
    } catch (e) { process.stderr.write(m.short + ": sem dados (" + e.message + ")\n"); }
  }
  const tests = {};
  ["venue", "mt5"].forEach(cost => {
    const T = { intraday: { v1: [], v2: [], v2macro: [] }, fractal: { v1: [], v2: [], v2macro: [] } };
    for (const m of MARKETS) {
      const d = data[m.id];
      if (!d) continue;
      const fee = cost === "mt5" && m.mt5Fee !== undefined ? m.mt5Fee : m.fee;
      const m15 = M.aggregate(d.m5, MIN15).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
      const run = (bars, trades) => ({ id: m.id, short: m.short, bars, trades, fee });
      T.intraday.v1.push(run(m15, M.setups(m15, { fee }).trades));
      T.intraday.v2.push(run(d.m5, M.poiSetups(d.m5, { fee, htfMs: MIN15 }).trades));
      T.intraday.v2macro.push(run(d.m5, M.poiSetups(d.m5, { fee, htfMs: MIN15, align: "bias", macroMs: HOUR }).trades));
      T.fractal.v1.push(run(d.h1, M.setups(d.h1, { fee, macroMs: 4 * HOUR }).trades));
      T.fractal.v2.push(run(d.h1, M.poiSetups(d.h1, { fee, htfMs: 4 * HOUR }).trades));
      T.fractal.v2macro.push(run(d.h1, M.poiSetups(d.h1, { fee, htfMs: 4 * HOUR, align: "bias", macroMs: 4 * HOUR }).trades));
    }
    tests[cost] = T;
  });
  const report = { at: new Date().toISOString(), desk: DESK, results: {} };
  Object.keys(tests).forEach(c => {
    report.results[c] = {};
    Object.keys(tests[c]).forEach(k => {
      report.results[c][k] = {};
      Object.keys(tests[c][k]).forEach(v => { report.results[c][k][v] = summary(tests[c][k][v]); });
    });
  });
  const txt = JSON.stringify(report, null, 1);
  if (outFile) fs.writeFileSync(outFile, txt);
  console.log(txt);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
