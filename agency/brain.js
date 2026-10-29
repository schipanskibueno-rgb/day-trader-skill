#!/usr/bin/env node
/* The agency's brain: one pass over real market data, written as one JSON
 * document that the 3D agency page shows. Node 18+ (global fetch), no packages.
 *
 *   node agency/brain.js --out state.json [--config config.json] [--every-hours 3] [--radar-out radar.json]
 *
 * Markets: BTC (Binance), gold and the four major currencies through their
 * CME futures on Yahoo Finance (spot forex has no volume). The desk trades
 * version 2 of the method in agency/method.js, the same as the MT5 robot:
 * a POI on 5-minute candles after price cleans the liquidity of a
 * 15-minute top or bottom, aligned with the 1-hour macro, on BTC and gold,
 * with the MT5 spread as cost: stop of a fixed dollar amount, target 3R,
 * at most 2 stops a day. The currencies are watched, not traded. Research
 * reads the news, measures how markets reacted to them and ranks the
 * markets; economists read global and Brazilian markets; the lab compares
 * version 1 and 2 on the last 60 days and the desk re-tests version 2 on
 * two years of hourly candles. Nothing here places a real order.
 */
"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const M = require(path.join(__dirname, "method.js"));
const RADAR = require(path.join(__dirname, "radar-engine.js"));
const RADAR_URL = "https://claude.ai/artifact/WE7tnuyZmu3in4q1JCxetr";
const RADAR_NAME = { BTC: "BTC", XAU: "OURO" };   // how the Radar page names the desk's markets
// the MT5 robot posts a summary of its demo account to this ntfy.sh channel (kept 12 hours there)
const MT5_TOPIC = "pregao-virtual-a224d58b32c0";
// ...and reads the agency's plan and orders from this one; every message is signed with MT5_KEY
const MT5_CMD_TOPIC = process.env.MT5_CMD_TOPIC || MT5_TOPIC + "-cmd";
const MT5_SYMBOL = { BTC: "BTCUSD", XAU: "XAUUSD" };

const FOUNDED = "2026-10-27";          // the paper desk trades from this day on
const DEFAULTS = { capital: 5000, stopUsd: 50, maxStopsPerDay: 2, rr: 3, block: 25 };
const MIN1 = 6e4, MIN2 = 12e4, MIN5 = 3e5, MIN15 = 9e5, HOUR = 36e5, DAY = 864e5;
const CHART_TFS = [2, 5, 10, 15];       // minutes the agents consult before an order
// version 2 as the robot runs it: POI on 5m, liquidity of 15m, 1h macro; costs are MT5 spread estimates
const V2 = { htfMs: MIN15, align: "bias", macroMs: HOUR, wyckoffRange: true };
const V2_1H = { htfMs: 4 * HOUR, align: "bias", macroMs: 4 * HOUR, wyckoffRange: true };
const V2_M2 = { htfMs: MIN15, align: "bias", macroMs: HOUR, wyckoffRange: true };   // the same POI with a 2-minute trigger, run side by side
const UA = { "User-Agent": "Mozilla/5.0 (agency-brain)" };

const MARKETS = [
  { id: "BTCUSDT", short: "BTC", name: "Bitcoin", label: "BTC/USD", src: "binance", fee: 0.0002, always: true, desk: "rafa", dec: 0, trade: true },
  { id: "GC=F", short: "XAU", name: "Ouro", label: "XAU/USD (futuro GC)", src: "yahoo", fee: 0.00005, desk: "bia", dec: 1, trade: true },
  { id: "6E=F", short: "EUR", name: "Euro", label: "EUR/USD (futuro 6E)", src: "yahoo", fee: 0.00003, desk: "duda", dec: 5 },
  { id: "6B=F", short: "GBP", name: "Libra", label: "GBP/USD (futuro 6B)", src: "yahoo", fee: 0.00003, desk: "duda", dec: 4 },
  { id: "6J=F", short: "JPY", name: "Iene", label: "JPY/USD (futuro 6J)", src: "yahoo", fee: 0.00003, desk: "duda", dec: 7 },
  { id: "6A=F", short: "AUD", name: "Dolar australiano", label: "AUD/USD (futuro 6A)", src: "yahoo", fee: 0.00003, desk: "duda", dec: 5 }];
const GLOBAL = [
  { id: "^GSPC", name: "S&P 500" }, { id: "^IXIC", name: "Nasdaq" }, { id: "DX-Y.NYB", name: "Indice do dolar (DXY)" },
  { id: "^TNX", name: "Juros 10 anos EUA" }, { id: "^VIX", name: "VIX (medo)" }, { id: "BZ=F", name: "Petroleo Brent" },
  { id: "GC=F", name: "Ouro" }];
const NATIONAL = [{ id: "^BVSP", name: "Ibovespa" }, { id: "BRL=X", name: "Dolar (R$)" }];
const NEWS = [
  { url: "https://news.google.com/rss/search?q=bitcoin+OR+criptomoedas+when:1d&hl=pt-BR&gl=BR&ceid=BR:pt-419", tag: "Cripto" },
  { url: "https://news.google.com/rss/search?q=ouro+OR+dolar+OR+cambio+when:1d&hl=pt-BR&gl=BR&ceid=BR:pt-419", tag: "Moedas" },
  { url: "https://news.google.com/rss/search?q=presidente+OR+eleicao+OR+Fed+OR+juros+OR+tarifas+when:1d&hl=pt-BR&gl=BR&ceid=BR:pt-419", tag: "Politica" },
  { url: "https://news.google.com/rss/search?q=Ibovespa+OR+%22economia+brasileira%22+when:1d&hl=pt-BR&gl=BR&ceid=BR:pt-419", tag: "Brasil" },
  { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", tag: "Mundo" }];
const POS = ["alta", "sobe", "subiu", "dispara", "disparou", "recorde", "ganho", "ganhos", "otimismo", "avanca", "avanco",
  "recupera", "valoriza", "valorizacao", "lucro", "aprova", "corte de juros", "rally", "gains", "rises", "rose", "record",
  "beats", "surge", "surges", "jumps", "rebound", "optimism", "upgrade", "bull"];
const NEG = ["queda", "cai", "caiu", "despenca", "despencou", "perda", "perdas", "crise", "medo", "tensao", "guerra",
  "recessao", "tarifa", "tarifas", "derrete", "desvaloriza", "prejuizo", "falls", "fell", "drops", "plunge", "slump",
  "fear", "war", "recession", "crash", "selloff", "sell-off", "tariff", "tariffs", "downgrade", "bear", "hack"];
const EVENT_WORDS = /presidente|eleic|eleit|reeleit|lula|trump|fed\b|copom|selic|juros|tarifa|guerra|banco central|powell|ministro|governo|tariff|election|president/;

const PEOPLE = [
  { id: "helena", name: "Helena", role: "Diretora", sector: "direcao" },
  { id: "rafa", name: "Rafa", role: "Trader de BTC", sector: "trade" },
  { id: "bia", name: "Bia", role: "Trader de ouro (XAU)", sector: "trade" },
  { id: "duda", name: "Duda", role: "Trader de forex", sector: "trade" },
  { id: "marta", name: "Marta", role: "Gestora de risco", sector: "trade" },
  { id: "teo", name: "Teo", role: "Operador da corretora", sector: "trade" },
  { id: "lia", name: "Lia", role: "Pesquisadora de noticias", sector: "pesquisa" },
  { id: "sofia", name: "Sofia", role: "Pesquisadora de politica e eventos", sector: "pesquisa" },
  { id: "kenji", name: "Kenji", role: "Estatistico (blocos de 25)", sector: "pesquisa" },
  { id: "otavio", name: "Otavio", role: "Economista (global)", sector: "economia" },
  { id: "paulo", name: "Paulo", role: "Economista (Brasil)", sector: "economia" },
  { id: "caio", name: "Caio", role: "Desenvolvedor (laboratorio)", sector: "lab" },
  { id: "nina", name: "Nina", role: "Desenvolvedora (dados)", sector: "lab" }];

// ---------------------------------------------------------------- fetching

async function getJSON(url, tries = 3) {
  let last;
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.ok) return await r.json();
      last = new Error(r.status + " " + url);
    } catch (e) { last = e; }
    await new Promise(res => setTimeout(res, 800 * (k + 1)));
  }
  throw last;
}

async function getText(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(r.status + " " + url);
  return r.text();
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

// 2-minute candles: BTC from Binance 1-minute candles, the CME futures straight from Yahoo
async function candles2m(m, now) {
  const raw = m.src === "binance" ? await binance(m.id, "1m", 87) : await yahoo(m.id, "2m", "60d");
  const b = m.src === "binance" ? M.aggregate(raw, MIN2).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v })) : raw;
  return b.filter(x => x.t + MIN2 <= now);
}

async function candles(m, interval) {
  if (m.src === "binance") return binance(m.id, interval, interval === "5m" ? 18 : interval === "15m" ? 6 : 18);
  return yahoo(m.id, interval, interval === "1h" ? "730d" : "60d");
}

// ---------------------------------------------------------------- the MT5 robot

// the last summary the robot sent; anyone who knows the channel can post to it, so every field is checked
function cleanMt5(raw, now) {
  const num = v => (typeof v === "number" && isFinite(v) ? v : null);
  const str = (v, n) => (typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, "").slice(0, n || 140) : "");
  const list = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
  const leg = x => ({ s: str(x.s, 20), d: x.d === 1 ? 1 : -1, lot: num(x.lot), p: num(x.p), sl: num(x.sl), tp: num(x.tp),
                      pl: num(x.pl), t: num(x.t) === null ? null : x.t * 1000 });
  const t = num(raw.t);
  if (raw.v !== 1 || t === null || t * 1000 > now + 10 * 60000) return null;
  return { connected: true, at: t * 1000, acc: num(raw.acc), srv: str(raw.srv, 40), demo: raw.demo === true, cur: str(raw.cur, 8),
           bal: num(raw.bal), eq: num(raw.eq), stops: num(raw.stops), open: raw.open === true, stop: num(raw.stop), algo: raw.algo === true,
           pos: list(raw.pos, 10).map(leg), ord: list(raw.ord, 10).map(leg), deals: list(raw.deals, 10).map(leg),
           n: num(raw.n), w: num(raw.w), sum: num(raw.sum), st: list(raw.st, 6).map(x => str(x)),
           res: list(raw.res, 8).map(x => str(x, 220)), agency: str(raw.agency, 200),
           rej: list(raw.rej, 5).map(x => ({ s: str(x.s, 20), st: num(x.st), c: str(x.c, 60), t: num(x.t) === null ? null : x.t * 1000 })) };
}

async function mt5Robot(now, topic) {
  try {
    const txt = await getText("https://ntfy.sh/" + (topic || MT5_TOPIC) + "/json?poll=1&since=12h");
    let best = null;
    txt.split("\n").forEach(line => {
      try {
        const ev = JSON.parse(line);
        if (ev.event !== "message") return;
        const snap = cleanMt5(JSON.parse(ev.message), now);
        if (snap && (!best || snap.at >= best.at)) best = snap;
      } catch (e) { /* not a summary of the robot */ }
    });
    if (!best) return { connected: false, note: "nenhum resumo do robo nas ultimas 12 horas" };
    best.stale = now - best.at > 60 * 60000;
    return best;
  } catch (e) { return { connected: false, note: "canal da ponte indisponivel" }; }
}

// ---------------------------------------------------------------- helpers

function round(v, d) { const k = Math.pow(10, d === undefined ? 2 : d); return Math.round(v * k) / k; }
function pctChange(a, b) { return b ? (a - b) / b : 0; }
function fmt(v, d) { return Number(v).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function sgn(v, d) { return (v >= 0 ? "+" : "") + fmt(v, d === undefined ? 2 : d); }
function usd(v) { return (v < 0 ? "-US$ " : "US$ ") + fmt(Math.abs(v), 0); }
function px(m, v) { return fmt(v, m.dec); }

// CME currency and gold futures: closed Friday 21:00 UTC to Sunday 22:00 UTC and 21:00-22:00 UTC each day
function marketOpen(m, now) {
  if (m.always) return true;
  const d = new Date(now), wd = d.getUTCDay(), h = d.getUTCHours();
  if (wd === 6) return false;
  if (wd === 5 && h >= 21) return false;
  if (wd === 0 && h < 22) return false;
  return h !== 21;
}

function readConfig(file) {
  let cfg = Object.assign({}, DEFAULTS);
  if (file && fs.existsSync(file)) {
    let raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && raw.data && typeof raw.data === "object") raw = raw.data;
    if (+raw.capital > 0) cfg.capital = +raw.capital;
    if (+raw.stopUsd > 0) cfg.stopUsd = +raw.stopUsd;
    if (typeof raw.testOrder === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.testOrder)) cfg.testOrder = raw.testOrder;
  }
  return cfg;
}

function profileOf(cfg) {
  const daily = cfg.stopUsd * cfg.maxStopsPerDay, pct = daily / cfg.capital * 100;
  const label = pct <= 2 ? "Conservador" : pct <= 3.5 ? "Regular" : pct <= 5 ? "Arrojado" : "Acima do limite do material (5%)";
  return { dailyRiskUsd: daily, dailyRiskPct: round(pct, 1), label };
}

function slimTrade(t, m) {
  return { asset: m.short, dir: t.dir, entry: t.entry, stop: t.stop, take: t.take, entryT: t.entryT,
           exitT: t.exitT || null, result: t.result || null, r: t.open ? null : round(t.r, 2),
           usd: t.usd === null || t.usd === undefined ? null : round(t.usd, 2),
           open: !!t.open, openR: t.open ? round(t.openR, 2) : null, openUsd: t.open ? round(t.openUsd, 2) : null,
           notional: round(t.notional, 0), size: t.size, dec: m.dec, consult: t.consult || null };
}

function deskSummary(d, byId, cfg) {
  return { n: d.n, wins: d.wins, winRate: round(d.winRate * 100, 0), expectancy: round(d.expectancy, 2),
           pnl: round(d.pnl, 2), equity: round(d.equity, 2), maxDD: round(d.maxDD, 2),
           closedDays: d.closedDays, blocks: d.blocks.map(b => ({ n: b.n, wins: b.wins, usd: round(b.usd, 2), done: b.done })),
           open: d.open.map(t => slimTrade(t, byId[t.market])),
           closed: d.closed.slice(-30).reverse().map(t => slimTrade(t, byId[t.market])),
           curve: d.curve.slice(-150).map(p => ({ t: p.t, eq: round(p.eq, 2) })),
           skipped2stops: d.skipped.filter(s => s.skippedWhy === "2 stops no dia").length, cfg };
}

// ---------------------------------------------------------------- news and event studies

function decode(s) {
  return s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<[^>]+>/g, "").trim();
}
function plain(s) { return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }

function tone(title) {
  const t = " " + plain(title).replace(/[^a-z0-9\- ]/g, " ") + " ";
  let s = 0;
  POS.forEach(w => { if (t.indexOf(" " + w + " ") >= 0) s++; });
  NEG.forEach(w => { if (t.indexOf(" " + w + " ") >= 0) s--; });
  return Math.sign(s);
}

function tagsOf(title, base) {
  const t = plain(title), tags = [base];
  [["BTC", /bitcoin|btc|cripto/], ["Ouro", /ouro|gold/], ["Dolar", /dolar|dollar|cambio/], ["Juros", /juros|fed\b|selic|copom|rate/],
   ["Politica", EVENT_WORDS], ["Petroleo", /petroleo|petrobras|oil|brent/], ["China", /china|chines/],
   ["EUA", /eua|trump|wall street|s&p|nasdaq|dow/]].forEach(([k, re]) => { if (re.test(t) && tags.indexOf(k) < 0) tags.push(k); });
  return tags;
}

async function news(now) {
  const items = [];
  for (const f of NEWS) {
    try {
      const xml = await getText(f.url);
      xml.split(/<item>/).slice(1, 26).forEach(b => {
        const g = re => { const m = b.match(re); return m ? decode(m[1]) : ""; };
        let title = g(/<title>([\s\S]*?)<\/title>/), source = g(/<source[^>]*>([\s\S]*?)<\/source>/);
        if (!source && f.tag === "Mundo") source = "MarketWatch";
        if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
        const t = Date.parse(g(/<pubDate>([\s\S]*?)<\/pubDate>/)) || now;
        if (!title || now - t > 2 * DAY) return;
        items.push({ title, source, url: g(/<link>([\s\S]*?)<\/link>/), t, tone: tone(title), tags: tagsOf(title, f.tag) });
      });
    } catch (e) { /* one feed down is not the end of the day */ }
  }
  const seen = new Set();
  return items.filter(i => { const k = plain(i.title).slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.t - a.t);
}

// how each market moved from the 15-minute candle of the headline until now
function reactions(items, series) {
  return items.filter(n => EVENT_WORDS.test(plain(n.title))).slice(0, 8).map(n => {
    const moves = [];
    Object.keys(series).forEach(k => {
      const b = series[k];
      const at = b.find(x => x.t >= n.t);
      if (!at || at === b[b.length - 1]) return;
      moves.push({ asset: k, pct: round(pctChange(b[b.length - 1].c, at.o) * 100, 2) });
    });
    return { title: n.title, source: n.source, url: n.url, t: n.t, moves };
  }).filter(e => e.moves.length);
}

async function macro(list) {
  const out = [];
  for (const m of list) {
    try {
      const b = await yahoo(m.id, "1d", "3mo"), c = b[b.length - 1].c;
      const back = k => b[Math.max(0, b.length - 1 - k)].c;
      out.push({ id: m.id, name: m.name, price: round(c, 4), chg1d: round(pctChange(c, back(1)), 5),
                 chg5d: round(pctChange(c, back(5)), 5), chg1m: round(pctChange(c, back(21)), 5),
                 spark: b.slice(-30).map(x => round(x.c, 4)) });
    } catch (e) { /* missing macro series is reported by count */ }
  }
  return out;
}

function climate(glob) {
  const by = id => glob.find(m => m.id === id);
  let s = 0;
  const spx = by("^GSPC"), vix = by("^VIX"), dxy = by("DX-Y.NYB");
  if (spx) s += spx.chg5d > 0.01 ? 1 : spx.chg5d < -0.01 ? -1 : 0;
  if (vix) s += vix.price < 16 ? 1 : vix.price > 22 ? -1 : 0;
  if (dxy) s += dxy.chg5d < -0.005 ? 1 : dxy.chg5d > 0.005 ? -1 : 0;
  return { score: s, label: s >= 2 ? "apetite a risco" : s <= -2 ? "aversao a risco" : "neutro, sem direcao clara" };
}

// ---------------------------------------------------------------- reading one market

function flowWord(f) { return f > 0 ? "alta" : f < 0 ? "baixa" : "lateral"; }

// the 15-minute tops and bottoms price has not cleaned yet, nearest first (up to k each side)
function liquidityLevels(b5, k) {
  const hb = M.aggregate(b5, MIN15), pv = M.pivots(hb, M.POI.htfPivot), last = b5[b5.length - 1];
  const after = p => b5.filter(x => x.t >= hb[p.known].t + MIN15);
  const above = pv.hi.filter(p => p.known < hb.length && p.p > last.c && after(p).every(x => x.h <= p.p)).map(p => p.p).sort((a, b) => a - b);
  const below = pv.lo.filter(p => p.known < hb.length && p.p < last.c && after(p).every(x => x.l >= p.p)).map(p => p.p).sort((a, b) => b - a);
  // levels cleaned in the last 24 hours: where the sweeps happened
  const swept = [];
  pv.hi.concat(pv.lo.map(p => Object.assign({ low: true }, p))).forEach(p => {
    if (p.known >= hb.length) return;
    const hit = after(p).find(x => p.low ? x.l < p.p : x.h > p.p);
    if (hit && hit.t >= last.t - DAY) swept.push({ p: p.p, side: p.low ? "fundo" : "topo", t: hit.t });
  });
  return { above: above.slice(0, k), below: below.slice(0, k), swept: swept.sort((a, b) => b.t - a.t).slice(0, 6) };
}

function liquidity(b5) {
  const hb = M.aggregate(b5, MIN15), pv = M.pivots(hb, M.POI.htfPivot), last = b5[b5.length - 1];
  const after = p => b5.filter(x => x.t >= hb[p.known].t + MIN15);
  const highs = pv.hi.filter(p => p.known < hb.length && p.p > last.c && after(p).every(x => x.h <= p.p)).map(p => p.p).sort((a, b) => a - b);
  const lows = pv.lo.filter(p => p.known < hb.length && p.p < last.c && after(p).every(x => x.l >= p.p)).map(p => p.p).sort((a, b) => b - a);
  return { above: highs[0] === undefined ? null : highs[0], below: lows[0] === undefined ? null : lows[0] };
}

// what an agent reads on one chart up to time T: the structure of its last pivots
function structureAt(bars, T) {
  const b = bars.filter(x => x.t <= T);
  if (b.length < 20) return { flow: 0, word: "sem dados" };
  const pv = M.pivots(b, 2), H = pv.hi.filter(p => p.known < b.length), L = pv.lo.filter(p => p.known < b.length);
  if (H.length < 2 || L.length < 2) return { flow: 0, word: "lateral" };
  const hh = H[H.length - 1].p > H[H.length - 2].p, hl = L[L.length - 1].p > L[L.length - 2].p;
  const flow = hh && hl ? 1 : !hh && !hl ? -1 : 0;
  return { flow, word: flow > 0 ? "topos e fundos subindo" : flow < 0 ? "topos e fundos caindo" : "lateral" };
}

// the Radar de Ativos reading of one chart up to time T: its indicators vote COMPRA / VENDA / NEUTRO
function radarAt(bars, T) {
  let n = bars.length;
  while (n > 0 && bars[n - 1].t > T) n--;
  const cs = bars.slice(Math.max(0, n - 300), n);
  if (cs.length < 60) return null;
  const sig = RADAR.signalAt(RADAR.indicators(cs), cs.length - 1);
  return { code: sig.code.replace("_", " "), dir: sig.dir, force: sig.force };
}

// the consultation the desk makes before an order: every chart of CHART_TFS up to the moment,
// its structure and the Radar de Ativos signal
function consult(byTf, T) {
  const out = {};
  CHART_TFS.forEach(tf => {
    const b = byTf[tf];
    out[tf + "m"] = b ? Object.assign(structureAt(b, T), { radar: radarAt(b, T) }) : { flow: 0, word: "sem dados", radar: null };
  });
  return out;
}
const radarWord = r => r && r.radar ? " (Radar: " + r.radar.code + " " + r.radar.force + "%)" : "";

// Wyckoff is kept in reserve: it only speaks when the 15-minute chart builds a sideways structure
function wyckoffNow(b15) {
  if (!b15 || b15.length < 60) return null;
  const o = Object.assign({}, M.P, M.POI), tr = M.tradingRange(b15, M.atr(b15, o.atrN), b15.length - 1, o);
  if (!tr) return null;
  const last = b15[b15.length - 1].c, pos = (last - tr.lo) / ((tr.hi - tr.lo) || 1);
  return { hi: tr.hi, lo: tr.lo, from: tr.from, pos: round(pos, 2),
           note: "estrutura lateral de " + (o.rangeBars * 15 / 60) + "h: uma varredura na borda so vale como spring (abaixo) ou upthrust (acima) com volume abaixo da media" };
}

function chartPack(m, byTf, liq, trades, now) {
  const tfs = {};
  CHART_TFS.forEach(tf => {
    const b = byTf[tf];
    if (b) tfs[tf + "m"] = b.slice(-90).map(x => [x.t, x.o, x.h, x.l, x.c]);
  });
  const pois = trades.filter(t => t.entryT >= now - 2 * DAY).slice(-8).map(t => ({
    trigger: t.trigger, aligned: t.aligned, dir: t.dir, entry: t.entry, stop: t.stop, take: t.take, entryT: t.entryT, exitT: t.exitT || null,
    result: t.result || (t.open ? "aberta" : null), zone: t.poi ? t.poi.zone : null, sweepT: t.poi ? t.poi.sweepT : null,
    level: t.poi ? t.poi.level : null }));
  const radar = {};
  CHART_TFS.forEach(tf => { const b = byTf[tf]; if (b) radar[tf + "m"] = b.slice(-300).map(x => [x.t, x.o, x.h, x.l, x.c, round(x.v, 4)]); });
  return { asset: m.short, dec: m.dec, tfs, liquidity: liq, pois, reading: consult(byTf, now), radarCandles: radar, wyckoff: wyckoffNow(byTf[15]) };
}

function readMarket(m, b15, s15, study, now, b5, openTrade) {
  const snap = M.snapshot(b15, s15), last = b15[b15.length - 1], mac = snap.macro;
  const regions = snap.regions.map(z => ({ dir: z.dir, poc: z.poc, val: z.val, vah: z.vah, born: z.born, aligned: z.aligned,
    distAtr: round(Math.abs(last.c - (z.dir > 0 ? z.vah : z.val)) / (snap.atr || 1), 1),
    inside: last.c <= z.vah && last.c >= z.val }));
  const best = regions.filter(z => z.aligned).sort((a, b) => a.distAtr - b.distAtr)[0] || null;
  let status = "sem cenario alinhado";
  if (!marketOpen(m, now)) status = "mercado fechado";
  else if (best && best.inside) status = "em teste na regiao: aguardando desinteresse e absorcao";
  else if (best) status = "regiao alinhada a " + best.distAtr + " ATR: aguardando o retorno";
  else if (mac && mac.bias === 0) status = "macro sem clareza (fluxo e controle em desacordo)";
  let liq = null;
  if (m.trade && b5 && b5.length) {
    liq = liquidity(b5);
    const a = snap.atr || 1, dist = v => v === null ? null : round(Math.abs(v - last.c) / a, 1);
    liq.aboveAtr = dist(liq.above); liq.belowAtr = dist(liq.below);
    if (!marketOpen(m, now)) status = "mercado fechado";
    else if (openTrade) status = "posicionado: " + (openTrade.dir > 0 ? "compra" : "venda") + " com stop e alvo 3R";
    else if (!mac || mac.bias === 0) status = "macro 1h sem clareza: so observando a liquidez";
    else {
      const lvl = mac.bias > 0 ? liq.below : liq.above, d = mac.bias > 0 ? liq.belowAtr : liq.aboveAtr;
      status = lvl === null ? "sem liquidez de 15m marcada a favor"
        : "aguardando limpar a liquidez " + (mac.bias > 0 ? "abaixo" : "acima") + " de " + px(m, lvl) + " (" + d + " ATR) e o POI de " + (mac.bias > 0 ? "compra" : "venda") + " em 5m";
    }
  } else if (!m.trade) status = marketOpen(m, now) ? "observando (a mesa opera so BTC e ouro)" : "mercado fechado";
  const dayAgo = b15.find(x => x.t >= last.t - DAY) || b15[0];
  return { id: m.id, short: m.short, name: m.name, label: m.label, desk: m.desk, dec: m.dec, open: marketOpen(m, now),
           price: last.c, t: last.t, chg24h: round(pctChange(last.c, dayAgo.o) * 100, 2),
           relVol: snap.relVol === null ? null : round(snap.relVol, 2), atr: snap.atr,
           macro: mac ? { flow: mac.flow, bias: mac.bias, choch: mac.choch, health: mac.health,
                          control: mac.control, lastHigh: mac.lastHigh, lastLow: mac.lastLow } : null,
           regions, best: m.trade ? null : best, status, trade: !!m.trade, liquidity: liq,
           study: study ? { n: study.n, win: round(study.winRate * 100, 0), exp: round(study.expectancy, 2) } : null,
           spark: b15.slice(-96).map(x => x.c) };
}

function rank(markets) {
  return markets.map(x => {
    let score = 0;
    const why = [];
    if (x.macro && x.macro.bias !== 0) { score += 2; why.push("macro de " + flowWord(x.macro.bias) + " com controle a favor"); }
    if (x.best) { score += 2 - Math.min(2, x.best.distAtr / 2); why.push("regiao de interesse " + (x.best.dir > 0 ? "compradora" : "vendedora") + " a " + x.best.distAtr + " ATR"); }
    if (x.macro && x.macro.health > 0) { score += 0.5; why.push("impulsos ganhando amplitude"); }
    if (x.macro && x.macro.health < 0) { score -= 0.5; why.push("impulsos perdendo amplitude"); }
    if (x.study && x.study.n >= 10 && x.study.exp > 0) { score += 0.5; why.push("historico 1h positivo"); }
    if (!x.open) why.push("abre na proxima sessao");
    return { asset: x.short, dir: x.best ? x.best.dir : (x.macro ? x.macro.bias : 0), score: round(score, 1), why };
  }).sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------- the meeting

function meeting(st, now) {
  const L = [], say = (who, text) => L.push({ who, text });
  const h = new Date(now).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
  const D = st.desk, closed = D.today.closed, mk = id => st.markets.find(x => x.short === id);
  const glob = id => st.global.find(x => x.id === id), nat = id => st.national.find(x => x.id === id);
  say("helena", "Reuniao das " + h + " (Brasilia). " + (closed
    ? "A mesa de trade encerrou o dia apos " + D.today.stops + " stops, como manda o gerenciamento. Hoje a reuniao e de estudo."
    : "Mesa aberta: " + D.today.stops + " de " + st.config.maxStopsPerDay + " stops usados hoje."));
  const spx = glob("^GSPC"), dxy = glob("DX-Y.NYB"), tnx = glob("^TNX"), vix = glob("^VIX");
  say("otavio", [spx && "S&P 500 " + sgn(spx.chg1d * 100) + "% no dia", dxy && "indice do dolar " + sgn(dxy.chg5d * 100) + "% na semana",
    tnx && "juros de 10 anos dos EUA em " + fmt(tnx.price, 2) + "%", vix && "VIX em " + fmt(vix.price, 1)]
    .filter(Boolean).join(", ") + ". Clima global: " + st.climate.label + ".");
  const ibov = nat("^BVSP"), brl = nat("BRL=X");
  say("paulo", [ibov && "Ibovespa " + sgn(ibov.chg1d * 100) + "% no dia e " + sgn(ibov.chg1m * 100) + "% no mes",
    brl && "dolar a R$ " + fmt(brl.price, 2) + " (" + sgn(brl.chg1d * 100) + "% no dia, " + sgn(brl.chg1m * 100) + "% no mes)"]
    .filter(Boolean).join("; ") + ".");
  const pos = st.news.filter(n => n.tone > 0).length, neg = st.news.filter(n => n.tone < 0).length;
  const top = st.news.find(n => n.tone !== 0) || st.news[0];
  say("lia", "Li " + st.news.length + " manchetes das ultimas 48h: " + pos + " positivas, " + neg + " negativas." +
    (top ? " Destaque: \"" + top.title + "\"." : ""));
  const ev = st.research.events.slice(0, 2);
  say("sofia", ev.length ? ev.map(e => "\"" + e.title.slice(0, 80) + "\": desde a noticia " +
    e.moves.map(x => x.asset + " " + sgn(x.pct) + "%").join(", ")).join(" | ") : "Nenhum evento politico ou de juros novo nas ultimas 48h.");
  const line = x => x.short + ": macro " + flowWord(x.macro ? x.macro.flow : 0) + (x.macro && x.macro.choch ? " (CHoCH de " + x.macro.choch + ")" : "") + ", " + x.status;
  const look = s => { const c = st.charts[s]; if (!c) return "";
    return " Consultei os graficos e o Radar: " + Object.keys(c.reading).map(k => k + " " + c.reading[k].word + radarWord(c.reading[k])).join(", ") + "."; };
  if (!closed) {
    const b = mk("BTC"), g = mk("XAU");
    const wy = s => { const c = st.charts[s], w = c && c.wyckoff; return w ? " Wyckoff: lateralizacao entre " + px(mk(s), w.lo) + " e " + px(mk(s), w.hi) +
      " desde " + new Date(w.from).toISOString().slice(11, 16) + " UTC; spring ou upthrust so com volume baixo." : ""; };
    if (b) say("rafa", line(b) + "." + look("BTC") + wy("BTC"));
    if (g) say("bia", line(g) + "." + look("XAU") + wy("XAU"));
    say("duda", st.markets.filter(x => x.desk === "duda").map(line).join("; ") + ".");
  }
  const sim = D.sim, study = D.study;
  say("kenji", "Simulacao de 60 dias, POI em 5m: " + sim.n + " trades, " + sim.winRate + "% de acerto, " + sgn(sim.expectancy) + "R por trade" +
    (sim.blocks.length ? " (bloco atual " + sim.blocks[sim.blocks.length - 1].wins + "/" + sim.blocks[sim.blocks.length - 1].n + ")" : "") +
    ". Mesmo POI com gatilho de 2m, lado a lado: " + D.compare.sim.n + " trades, " + sgn(D.compare.sim.expectancy) + "R" +
    ". POI em 1h com liquidez de 4h, 2 anos: " + study.n + " trades, " + sgn(study.expectancy) + "R. Com alvo de 3R o equilibrio e 25% de acerto; ainda sem vantagem comprovada.");
  say("marta", "Stop de " + usd(st.config.stopUsd) + " por trade, alvo 3R (" + usd(st.config.stopUsd * 3) + "), risco diario de " +
    usd(st.profile.dailyRiskUsd) + " = " + fmt(st.profile.dailyRiskPct, 1) + "% de " + usd(st.config.capital) + " (" + st.profile.label + "). " +
    (closed ? "Dois stops hoje: mesa fechada ate " + new Date(D.today.reopenAt).toISOString().slice(11, 16) + " UTC." : "Stops hoje: " + D.today.stops + "/" + st.config.maxStopsPerDay + "."));
  const L0 = D.live;
  const R5 = st.mt5;
  say("teo", "Corretora virtual desde " + FOUNDED.split("-").reverse().join("/") + ": " + usd(L0.equity) + " (" + (L0.pnl >= 0 ? "+" : "") + usd(L0.pnl) + "), " +
    L0.open.length + " posicao(oes) aberta(s), " + L0.n + " encerrada(s)" + (D.today.trades ? ", " + D.today.trades + " hoje" : "") + ". " +
    (R5 && R5.connected
      ? "Robo no MT5 (conta demo " + R5.acc + "): saldo " + fmt(R5.bal, 2) + " " + R5.cur + ", " + R5.pos.length + " posicao(oes), " + R5.ord.length +
        " ordem(ns) limitada(s), " + (R5.n || 0) + " trade(s) encerrado(s)" + (R5.stale ? "; atencao: sem sinal do robo desde " + new Date(R5.at).toISOString().slice(11, 16) + " UTC" : "") + "."
      : "Robo no MT5: " + (R5 ? R5.note : "sem dados") + "."));
  const lab = st.lab;
  say("caio", "Laboratorio (60 dias, 6 mercados): versao 1 em 15m " + sgn(lab.v1.exp) + "R em " + lab.v1.n + " trades; POI em 5m " +
    sgn(lab.v2.exp) + "R em " + lab.v2.n + "; POI com macro 1h (a da mesa) " + sgn(lab.v2macro.exp) + "R em " + lab.v2macro.n + ". Julgamos em blocos de 25 trades novos.");
  say("nina", "Leitura com " + st.markets.length + " mercados, " + (st.global.length + st.national.length) + " indicadores e " + st.news.length +
    " noticias. Fontes: Binance, Yahoo Finance (futuros CME), Google Noticias e MarketWatch." + (st.errors.length ? " Falhas: " + st.errors.length + "." : ""));
  const C = st.command;
  if (C) {
    say("marta", "Plano para o robo no MT5 ate a proxima leitura: " + C.plan.map(p => p.short + " " +
      ({ BUY: "so compras", SELL: "so vendas", BOTH: "compras e vendas", NONE: "nada" })[p.allow] + " (" + p.why + ")").join("; ") +
      (C.orders.length ? ". Ordem direta: " + C.orders.map(o => (o.side === "BUY" ? "compra" : "venda") + " de " + o.short + " (" + o.tag.toLowerCase() + "), stop a " +
        fmt(o.frac * 100, 2) + "% e alvo 3R").join("; ") : "") + (C.sent ? ". Enviado e assinado." : ". " + C.note + "."));
  }
  if (R5 && R5.connected && (R5.res.length || R5.rej.length)) {
    say("teo", "Retorno do MT5: " + R5.res.slice(-3).join(" | ") + (R5.rej.length ? (R5.res.length ? " | " : "") + "recusadas pela corretora: " +
      R5.rej.map(x => x.s + " " + explainRefusal(x.c)).join("; ") : "") + ".");
  }
  const r0 = st.research.ranking[0];
  say("helena", "Leitura da casa: clima " + st.climate.label + ". " + (r0 ? "Melhor cenario para " + (closed ? "a proxima sessao" : "agora") + ": " + r0.asset +
    " (" + r0.why.slice(0, 2).join(", ") + "). " : "") + "Seguimos o plano, no papel. Nao e recomendacao de investimento.");
  return { time: now, deskClosed: closed, lines: L };
}

function agentReports(st) {
  const r = {}, lines = st.meeting.lines, line = id => (lines.filter(x => x.who === id).pop() || {}).text || "";
  const mk = id => st.markets.find(x => x.short === id), closed = st.desk.today.closed;
  const short = x => x ? x.short + ": " + (x.best ? "regiao " + (x.best.dir > 0 ? "compradora" : "vendedora") + " a " + x.best.distAtr + " ATR" : x.status) : "";
  const add = (id, task, bubble) => { r[id] = { task, report: line(id), bubble }; };
  add("helena", "Coordenando a agencia", "Stops hoje " + st.desk.today.stops + "/" + st.config.maxStopsPerDay);
  add("rafa", closed ? "Foi para casa (2 stops no dia)" : "BTC: liquidez de 15m e POI em 5m", short(mk("BTC")));
  add("bia", closed ? "Foi para casa (2 stops no dia)" : "Ouro: liquidez de 15m e POI em 5m", short(mk("XAU")));
  add("duda", closed ? "Foi para casa (2 stops no dia)" : "Observando euro, libra, iene e dolar australiano (sem operar)", short(st.markets.filter(x => x.desk === "duda").sort((a, b) => (a.best ? a.best.distAtr : 99) - (b.best ? b.best.distAtr : 99))[0]));
  add("marta", closed ? "Fechou a mesa do dia" : "Conferindo stop, alvo 3R e o limite de 2 stops", "Stop " + usd(st.config.stopUsd) + ", alvo 3R");
  add("teo", closed ? "Foi para casa (2 stops no dia)" : "Registrando as ordens no papel", "Patrimonio " + usd(st.desk.live.equity));
  add("lia", "Lendo noticias do mundo", st.news[0] ? st.news[0].title.slice(0, 70) : "Sem manchetes novas");
  const e = st.research.events[0];
  add("sofia", "Medindo como o mercado reagiu a eventos", e ? e.moves.slice(0, 2).map(x => x.asset + " " + sgn(x.pct) + "%").join(", ") + " desde a noticia" : "Sem eventos novos");
  add("kenji", "Contando os blocos de 25 trades", "Simulacao: " + sgn(st.desk.sim.expectancy) + "R por trade");
  add("otavio", "Acompanhando juros, dolar e bolsas globais", "Clima: " + st.climate.label);
  const brl = st.national.find(x => x.id === "BRL=X");
  add("paulo", "Acompanhando Ibovespa e dolar/real", brl ? "Dolar R$ " + fmt(brl.price, 2) : "");
  add("caio", "Comparando a versao 1 com o POI", "POI + macro: " + sgn(st.lab.v2macro.exp) + "R");
  add("nina", "Cuidando dos dados e das fontes", st.markets.length + " mercados lidos");
  return r;
}

// ---------------------------------------------------------------- the agency decides, the robot executes

const ascii = s => plain(String(s)).replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim();

// what a broker refusal means (comments the MT5 server writes on rejected orders)
function explainRefusal(c) {
  const t = String(c || "").toLowerCase();
  if (t.indexOf("no money") >= 0) return "sem margem livre suficiente na conta para o lote pedido";
  if (t.indexOf("invalid stops") >= 0) return "stop ou alvo perto demais do preco";
  if (t.indexOf("market closed") >= 0) return "mercado fechado";
  if (t.indexOf("autotrading") >= 0) return "Algotrading desligado";
  if (t.indexOf("invalid volume") >= 0) return "lote invalido";
  return t ? "recusada pela corretora (" + t + ")" : "cancelada (venceu ou mesa fechou)";
}

// markets the robot reported it cannot find at its broker
function missingAtBroker(st) {
  const out = {};
  const lines = st.mt5 && st.mt5.connected ? st.mt5.st : [];
  Object.keys(MT5_SYMBOL).forEach(k => { if (lines.some(l => l.indexOf(MT5_SYMBOL[k] + ":") === 0 && l.indexOf("nao existe") >= 0)) out[k] = true; });
  return out;
}

// the plan for each traded market: which side the robot may take until the next reading, and why not
function deskPlan(st, cfg, now) {
  const mt5 = st.mt5 && st.mt5.connected ? st.mt5 : null, missing = missingAtBroker(st);
  const closed = st.desk.today.closed || (mt5 && mt5.stops >= cfg.maxStopsPerDay);
  return st.markets.filter(m => m.trade).map(m => {
    const sym = MT5_SYMBOL[m.short], bias = m.macro ? m.macro.bias : 0, c = st.charts[m.short];
    const r5 = c && c.reading["5m"] && c.reading["5m"].radar, r15 = c && c.reading["15m"] && c.reading["15m"].radar;
    let allow = bias > 0 ? "BUY" : bias < 0 ? "SELL" : "NONE", why;
    if (missing[m.short]) { allow = "NONE"; why = sym + " nao existe nesta corretora"; }
    else if (closed) { allow = "NONE"; why = "mesa fechada: 2 stops hoje"; }
    else if (!m.open) { allow = "NONE"; why = "mercado fechado"; }
    else if (!bias) why = "macro 1h sem clareza: nao operar";
    else if (r5 && r15 && r5.dir === -bias && r15.dir === -bias && r5.force >= 70 && r15.force >= 70) {
      allow = "NONE"; why = "recusado: Radar forte contra em 5m e 15m (" + r5.code + ", " + r15.code + ")";
    } else why = "macro 1h de " + (bias > 0 ? "alta" : "baixa") + ": so " + (bias > 0 ? "compras" : "vendas") + " no POI de 5m";
    return { short: m.short, sym, allow, why: ascii(why) };
  });
}

// the test order the owner asked for: the market and side where the agency's reading agrees most
function testOrder(st, cfg, now) {
  const today = new Date(now - 3 * HOUR).toISOString().slice(0, 10);       // Brasilia date
  if (cfg.testOrder !== today || st.desk.today.closed) return null;
  let best = null;
  const missing = missingAtBroker(st);
  st.markets.filter(m => m.trade && m.open && !missing[m.short]).forEach(m => {
    const c = st.charts[m.short];
    if (!c) return;
    let score = 2 * (m.macro ? m.macro.bias : 0), parts = [];
    Object.keys(c.reading).forEach(k => {
      const r = c.reading[k];
      score += 0.5 * r.flow + (r.radar ? r.radar.dir * r.radar.force / 100 : 0);
      if (r.radar) parts.push(k + " " + r.radar.code);
    });
    if (!best || Math.abs(score) > Math.abs(best.score)) best = { m, score, parts };
  });
  if (!best || !best.score) return null;
  const m = best.m, frac = Math.min(0.02, Math.max(0.001, (m.atr || 0) / m.price));
  return { id: "TESTE-" + today, short: m.short, sym: MT5_SYMBOL[m.short], side: best.score > 0 ? "BUY" : "SELL", frac: +frac.toFixed(5),
           risk: cfg.stopUsd, exp: Math.floor(now / 1000) + 3 * 3600, tag: "TESTE",
           why: ascii("ordem de teste pedida pelo dono; nota " + best.score.toFixed(1) + " (macro 1h, estrutura e Radar: " + best.parts.join(", ") + ")") };
}

// the signed message the robot reads: the plan, valid for 4 hours, and the orders
function commandText(plan, orders, now, key) {
  const t = Math.floor(now / 1000), rows = ["T " + t + " " + (t + 4 * 3600)];
  plan.forEach(p => rows.push(["PLAN", p.sym, p.allow, p.why].join(" ")));
  orders.forEach(o => rows.push(["ORD", o.id, o.sym, o.side, o.frac, o.risk, o.exp, o.tag, o.why].join(" ")));
  const rest = rows.join("\n");
  return "PV1 " + crypto.createHash("sha256").update(key + "\n" + rest).digest("hex") + "\n" + rest;
}

async function sendCommands(text) {
  const r = await fetch("https://ntfy.sh/" + MT5_CMD_TOPIC, { method: "POST", body: text, headers: { "Content-Type": "text/plain" } });
  if (!r.ok) throw new Error("ntfy " + r.status);
}

// ---------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2), arg = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const out = arg("--out"), every = arg("--every-hours") ? +arg("--every-hours") : null;
  const cfg = readConfig(arg("--config"));
  const now = Date.now(), founded = Date.parse(FOUNDED + "T00:00:00Z"), errors = [];
  const byId = {}, live = [], sim = [], study = [], labRuns = { v1: [], v2: [], v2macro: [] }, markets = [], series15 = {};
  const live2 = [], sim2 = [], charts = {}, consults = {};

  for (const m of MARKETS) {
    try {
      const b15 = (await candles(m, "15m")).filter(x => x.t + MIN15 <= now);
      const b5 = (await candles(m, "5m")).filter(x => x.t + MIN5 <= now);
      const b1h = m.trade ? (await candles(m, "1h")).filter(x => x.t + HOUR <= now) : null;
      byId[m.id] = m;
      series15[m.short] = b15;
      const s15 = M.setups(b15, { macroMs: HOUR, fee: m.fee });
      const run = (bars, trades) => ({ id: m.id, short: m.short, bars, trades, fee: m.fee });
      const v2 = M.poiSetups(b5, Object.assign({ fee: m.fee }, V2));
      labRuns.v1.push(run(b15, s15.trades));
      labRuns.v2.push(run(b5, M.poiSetups(b5, { fee: m.fee, htfMs: MIN15 }).trades));
      labRuns.v2macro.push(run(b5, v2.trades));
      let one = null, openTrade = null;
      if (m.trade) {
        sim.push(run(b5, v2.trades));
        const mine = run(b5, v2.trades.filter(t => b5[t.entryIdx].t >= founded));
        live.push(mine);
        const fr = run(b1h, M.poiSetups(b1h, Object.assign({ fee: m.fee }, V2_1H)).trades);
        study.push(fr);
        one = M.desk([fr], Object.assign({}, cfg));
        openTrade = M.desk([mine], Object.assign({}, cfg)).open[0] || null;
        // the 2-minute trigger, side by side, and the charts the agents consult
        const b2 = await candles2m(m, now);
        const v2m2 = M.poiSetups(b2, Object.assign({ fee: m.fee }, V2_M2));
        sim2.push(run(b2, v2m2.trades));
        live2.push(run(b2, v2m2.trades.filter(t => b2[t.entryIdx].t >= founded)));
        const byTf = { 2: b2, 5: b5, 10: M.aggregate(b5, 2 * MIN5).filter(x => x.t + 2 * MIN5 <= now).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v })), 15: b15 };
        consults[m.short] = byTf;
        // every POI of the last days on both triggers, marked when the 1h macro let the desk take it
        const allPois = (bars, setups, taken, trig) => {
          const ok = new Set(taken.map(t => t.entryIdx + ":" + t.dir));
          return M.desk([run(bars, setups.trades)], Object.assign({}, cfg, { maxStopsPerDay: 99 })).trades
            .map(t => Object.assign(t, { trigger: trig, aligned: ok.has(t.entryIdx + ":" + t.dir) }));
        };
        const recent = allPois(b5, M.poiSetups(b5, { fee: m.fee, htfMs: MIN15 }), v2.trades, "5m")
          .concat(allPois(b2, M.poiSetups(b2, { fee: m.fee, htfMs: MIN15 }), v2m2.trades, "2m"))
          .sort((x, y) => x.entryT - y.entryT);
        charts[m.short] = chartPack(m, byTf, liquidityLevels(b5, 3), recent, now);
      }
      markets.push(readMarket(m, b15, s15, one, now, b5, openTrade));
    } catch (e) { errors.push(m.short + ": " + e.message); }
  }
  try {
    const brl = (await yahoo("BRL=X", "15m", "5d")).filter(x => x.t + MIN15 <= now);
    series15["USD/BRL"] = brl;
  } catch (e) { errors.push("BRL=X: " + e.message); }

  const deskCfg = Object.assign({}, cfg);
  const L = M.desk(live, deskCfg), S = M.desk(sim, deskCfg), T = M.desk(study, deskCfg);
  const L2 = M.desk(live2, deskCfg), S2 = M.desk(sim2, deskCfg);
  // every order of the desk carries the consultation of the 2, 5, 10 and 15-minute charts made before it
  const withConsult = d => d.trades.forEach(t => { const byTf = consults[t.short]; if (byTf) t.consult = consult(byTf, t.entryT - 1); });
  withConsult(L); withConsult(L2);
  const today = M.dayOf(now);
  const stopsToday = L.trades.filter(t => !t.open && t.result === "stop" && M.dayOf(t.exitT) === today).length;
  const tradesToday = L.trades.filter(t => M.dayOf(t.entryT) === today).length;
  const closedToday = stopsToday >= cfg.maxStopsPerDay;
  const lab = {};
  Object.keys(labRuns).forEach(k => { const d = M.desk(labRuns[k], deskCfg); lab[k] = { n: d.n, win: round(d.winRate * 100, 0), exp: round(d.expectancy, 2) }; });

  const headlines = (await news(now)).slice(0, 20);
  const mt5 = await mt5Robot(now);
  const glob = await macro(GLOBAL), nat = await macro(NATIONAL);
  const st = {
    version: 3, updatedAt: now, nextAt: every ? now + every * HOUR : null, founded: FOUNDED,
    config: cfg, profile: profileOf(cfg), markets, global: glob, national: nat, news: headlines, errors,
    desk: {
      today: { day: today, stops: stopsToday, trades: tradesToday, closed: closedToday,
               reopenAt: closedToday ? Date.parse(today + "T00:00:00Z") + DAY : null },
      live: deskSummary(L, byId, cfg), sim: deskSummary(S, byId, cfg), study: deskSummary(T, byId, cfg),
      method: "v2", assets: MARKETS.filter(m => m.trade).map(m => m.short),
      compare: { trigger: "2m", live: deskSummary(L2, byId, cfg), sim: deskSummary(S2, byId, cfg) }
    },
    charts, mt5,
    lab, people: PEOPLE
  };
  st.desk.sim.closed = st.desk.sim.closed.slice(0, 15);
  st.desk.study.closed = st.desk.study.closed.slice(0, 10);
  st.desk.study.curve = st.desk.study.curve.slice(-80);
  st.desk.compare.sim.closed = st.desk.compare.sim.closed.slice(0, 10);
  st.desk.compare.sim.curve = st.desk.compare.sim.curve.slice(-80);
  st.climate = climate(glob);
  st.research = { events: reactions(headlines, series15), ranking: rank(markets) };
  // the agency decides: plan and orders for the robot on MT5, signed with the owner's key
  const plan = deskPlan(st, cfg, now), orders = [], t1 = testOrder(st, cfg, now);
  if (t1) orders.push(t1);
  st.command = { at: now, plan, orders, sent: false, note: "" };
  const key = process.env.MT5_KEY || "";
  if (args.includes("--send-orders")) {
    if (!key) st.command.note = "sem a chave MT5_KEY: plano calculado mas nao enviado";
    else {
      try { await sendCommands(commandText(plan, orders, now, key)); st.command.sent = true; }
      catch (e) { st.command.note = "falha ao enviar: " + e.message; errors.push("ordens: " + e.message); }
    }
  } else st.command.note = "modo leitura: plano nao enviado ao robo";
  st.meeting = meeting(st, now);
  st.agents = agentReports(st);

  // the candles, liquidity and POIs the Radar de Ativos page shows for the desk's markets
  const radarDoc = { updatedAt: now, nextAt: st.nextAt, source: "Agencia Pregao Virtual (Binance e futuros CME)", assets: {} };
  Object.keys(st.charts).forEach(k => {
    const c = st.charts[k];
    radarDoc.assets[RADAR_NAME[k] || k] = { tfs: c.radarCandles, liquidity: c.liquidity, pois: c.pois, reading: c.reading, dec: c.dec, wyckoff: c.wyckoff };
    delete c.radarCandles;
  });
  if (arg("--radar-out")) fs.writeFileSync(arg("--radar-out"), JSON.stringify(radarDoc));
  const json = JSON.stringify(st);
  if (out) fs.writeFileSync(out, json); else process.stdout.write(json + "\n");
  console.error("agency: " + markets.length + " markets, " + headlines.length + " news, live " + L.n + " trades, desk " +
    (closedToday ? "CLOSED" : "open") + ", " + (json.length / 1024).toFixed(0) + " KB" + (errors.length ? ", errors: " + errors.join(" | ") : ""));
  return st;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { tone, tagsOf, climate, decode, marketOpen, profileOf, readConfig, reactions, liquidity, radarAt, cleanMt5, mt5Robot,
                   deskPlan, testOrder, commandText, explainRefusal };
