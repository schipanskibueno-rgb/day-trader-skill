#!/usr/bin/env node
/* The agency's brain: one pass over real market data, written as one JSON
 * document that the 3D agency page shows. Node 18+ (global fetch), no packages.
 *
 *   node agency/brain.js --out state.json [--config config.json] [--every-hours 2]
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
const M = require(path.join(__dirname, "method.js"));

const FOUNDED = "2026-10-27";          // the paper desk trades from this day on
const DEFAULTS = { capital: 5000, stopUsd: 80, maxStopsPerDay: 2, rr: 3, block: 25 };
const MIN5 = 3e5, MIN15 = 9e5, HOUR = 36e5, DAY = 864e5;
// version 2 as the robot runs it: POI on 5m, liquidity of 15m, 1h macro; costs are MT5 spread estimates
const V2 = { htfMs: MIN15, align: "bias", macroMs: HOUR };
const V2_1H = { htfMs: 4 * HOUR, align: "bias", macroMs: 4 * HOUR };
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

async function candles(m, interval) {
  if (m.src === "binance") return binance(m.id, interval, interval === "5m" ? 18 : interval === "15m" ? 6 : 18);
  return yahoo(m.id, interval, interval === "1h" ? "730d" : "60d");
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
           notional: round(t.notional, 0), size: t.size, dec: m.dec };
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

// the 15-minute tops and bottoms price has not cleaned yet, nearest first
function liquidity(b5) {
  const hb = M.aggregate(b5, MIN15), pv = M.pivots(hb, M.POI.htfPivot), last = b5[b5.length - 1];
  const after = p => b5.filter(x => x.t >= hb[p.known].t + MIN15);
  const highs = pv.hi.filter(p => p.known < hb.length && p.p > last.c && after(p).every(x => x.h <= p.p)).map(p => p.p).sort((a, b) => a - b);
  const lows = pv.lo.filter(p => p.known < hb.length && p.p < last.c && after(p).every(x => x.l >= p.p)).map(p => p.p).sort((a, b) => b - a);
  return { above: highs[0] === undefined ? null : highs[0], below: lows[0] === undefined ? null : lows[0] };
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
  if (!closed) {
    const b = mk("BTC"), g = mk("XAU");
    if (b) say("rafa", line(b) + ".");
    if (g) say("bia", line(g) + ".");
    say("duda", st.markets.filter(x => x.desk === "duda").map(line).join("; ") + ".");
  }
  const sim = D.sim, study = D.study;
  say("kenji", "Simulacao de 60 dias, POI em 5m: " + sim.n + " trades, " + sim.winRate + "% de acerto, " + sgn(sim.expectancy) + "R por trade" +
    (sim.blocks.length ? " (bloco atual " + sim.blocks[sim.blocks.length - 1].wins + "/" + sim.blocks[sim.blocks.length - 1].n + ")" : "") +
    ". POI em 1h com liquidez de 4h, 2 anos: " + study.n + " trades, " + sgn(study.expectancy) + "R. Com alvo de 3R o equilibrio e 25% de acerto; ainda sem vantagem comprovada.");
  say("marta", "Stop de " + usd(st.config.stopUsd) + " por trade, alvo 3R (" + usd(st.config.stopUsd * 3) + "), risco diario de " +
    usd(st.profile.dailyRiskUsd) + " = " + fmt(st.profile.dailyRiskPct, 1) + "% de " + usd(st.config.capital) + " (" + st.profile.label + "). " +
    (closed ? "Dois stops hoje: mesa fechada ate " + new Date(D.today.reopenAt).toISOString().slice(11, 16) + " UTC." : "Stops hoje: " + D.today.stops + "/" + st.config.maxStopsPerDay + "."));
  const L0 = D.live;
  say("teo", "Corretora virtual desde " + FOUNDED.split("-").reverse().join("/") + ": " + usd(L0.equity) + " (" + (L0.pnl >= 0 ? "+" : "") + usd(L0.pnl) + "), " +
    L0.open.length + " posicao(oes) aberta(s), " + L0.n + " encerrada(s)" + (D.today.trades ? ", " + D.today.trades + " hoje" : "") + ".");
  const lab = st.lab;
  say("caio", "Laboratorio (60 dias, 6 mercados): versao 1 em 15m " + sgn(lab.v1.exp) + "R em " + lab.v1.n + " trades; POI em 5m " +
    sgn(lab.v2.exp) + "R em " + lab.v2.n + "; POI com macro 1h (a da mesa) " + sgn(lab.v2macro.exp) + "R em " + lab.v2macro.n + ". Julgamos em blocos de 25 trades novos.");
  say("nina", "Leitura com " + st.markets.length + " mercados, " + (st.global.length + st.national.length) + " indicadores e " + st.news.length +
    " noticias. Fontes: Binance, Yahoo Finance (futuros CME), Google Noticias e MarketWatch." + (st.errors.length ? " Falhas: " + st.errors.length + "." : ""));
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

// ---------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2), arg = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const out = arg("--out"), every = arg("--every-hours") ? +arg("--every-hours") : null;
  const cfg = readConfig(arg("--config"));
  const now = Date.now(), founded = Date.parse(FOUNDED + "T00:00:00Z"), errors = [];
  const byId = {}, live = [], sim = [], study = [], labRuns = { v1: [], v2: [], v2macro: [] }, markets = [], series15 = {};

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
  const today = M.dayOf(now);
  const stopsToday = L.trades.filter(t => !t.open && t.result === "stop" && M.dayOf(t.exitT) === today).length;
  const tradesToday = L.trades.filter(t => M.dayOf(t.entryT) === today).length;
  const closedToday = stopsToday >= cfg.maxStopsPerDay;
  const lab = {};
  Object.keys(labRuns).forEach(k => { const d = M.desk(labRuns[k], deskCfg); lab[k] = { n: d.n, win: round(d.winRate * 100, 0), exp: round(d.expectancy, 2) }; });

  const headlines = (await news(now)).slice(0, 20);
  const glob = await macro(GLOBAL), nat = await macro(NATIONAL);
  const st = {
    version: 3, updatedAt: now, nextAt: every ? now + every * HOUR : null, founded: FOUNDED,
    config: cfg, profile: profileOf(cfg), markets, global: glob, national: nat, news: headlines, errors,
    desk: {
      today: { day: today, stops: stopsToday, trades: tradesToday, closed: closedToday,
               reopenAt: closedToday ? Date.parse(today + "T00:00:00Z") + DAY : null },
      live: deskSummary(L, byId, cfg), sim: deskSummary(S, byId, cfg), study: deskSummary(T, byId, cfg),
      method: "v2", assets: MARKETS.filter(m => m.trade).map(m => m.short)
    },
    lab, people: PEOPLE
  };
  st.desk.sim.closed = st.desk.sim.closed.slice(0, 15);
  st.desk.study.closed = st.desk.study.closed.slice(0, 10);
  st.desk.study.curve = st.desk.study.curve.slice(-80);
  st.climate = climate(glob);
  st.research = { events: reactions(headlines, series15), ranking: rank(markets) };
  st.meeting = meeting(st, now);
  st.agents = agentReports(st);

  const json = JSON.stringify(st);
  if (out) fs.writeFileSync(out, json); else process.stdout.write(json + "\n");
  console.error("agency: " + markets.length + " markets, " + headlines.length + " news, live " + L.n + " trades, desk " +
    (closedToday ? "CLOSED" : "open") + ", " + (json.length / 1024).toFixed(0) + " KB" + (errors.length ? ", errors: " + errors.join(" | ") : ""));
  return st;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { tone, tagsOf, climate, decode, marketOpen, profileOf, readConfig, reactions, liquidity };
