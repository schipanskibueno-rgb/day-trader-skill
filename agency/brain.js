#!/usr/bin/env node
/* The agency's brain: one pass over real market data, written as one JSON
 * file that the 3D agency page shows. Node 18+ (global fetch), no packages.
 *
 *   node agency/brain.js --out agency-state.json
 *
 * Reads: Binance public candles (crypto), Yahoo Finance charts (B3 and US
 * stocks, indices, dollar, gold, oil, rates, VIX), alternative.me's Fear &
 * Greed index, Google News (pt-BR) and MarketWatch headlines. Runs the same
 * engine as the Robo Trader page (docs/engine.js) on daily candles, keeps a
 * paper broker that follows the robot's held/approved signals from the
 * agency's founding day, tests a few rule variants for the lab, and writes
 * what each agent found as their report and as a meeting transcript.
 * Nothing here places a real order.
 */
"use strict";

const path = require("path");
const fs = require("fs");
const Robo = require(path.join(__dirname, "..", "docs", "engine.js"));

const FOUNDED = "2026-10-27";          // the paper broker trades from this day on
const START_EQUITY = 100000;           // virtual US dollars
const RISK_PER_TRADE = 0.01;           // 1% of equity at the stop
const DAY = 864e5, WEEK = 6048e5;
const UA = { "User-Agent": "Mozilla/5.0 (agency-brain)" };

const CRYPTO = [
  { id: "BTCUSDT", name: "Bitcoin", short: "BTC" }, { id: "ETHUSDT", name: "Ethereum", short: "ETH" },
  { id: "SOLUSDT", name: "Solana", short: "SOL" }, { id: "BNBUSDT", name: "BNB", short: "BNB" },
  { id: "XRPUSDT", name: "XRP", short: "XRP" }];
const STOCKS = [
  { id: "PETR4.SA", name: "Petrobras", short: "PETR4", cur: "R$" }, { id: "VALE3.SA", name: "Vale", short: "VALE3", cur: "R$" },
  { id: "ITUB4.SA", name: "Itau", short: "ITUB4", cur: "R$" }, { id: "AAPL", name: "Apple", short: "AAPL", cur: "US$" },
  { id: "NVDA", name: "Nvidia", short: "NVDA", cur: "US$" }];
const MACRO = [
  { id: "^GSPC", name: "S&P 500" }, { id: "^IXIC", name: "Nasdaq" }, { id: "^BVSP", name: "Ibovespa" },
  { id: "BRL=X", name: "Dolar (R$)" }, { id: "DX-Y.NYB", name: "Indice do dolar" }, { id: "GC=F", name: "Ouro" },
  { id: "BZ=F", name: "Petroleo Brent" }, { id: "^TNX", name: "Juros 10 anos EUA" }, { id: "^VIX", name: "VIX (medo)" }];
const NEWS = [
  { url: "https://news.google.com/rss/search?q=bitcoin+OR+criptomoedas+when:1d&hl=pt-BR&gl=BR&ceid=BR:pt-419", tag: "Cripto" },
  { url: "https://news.google.com/rss/search?q=Ibovespa+OR+%22bolsa+de+valores%22+when:1d&hl=pt-BR&gl=BR&ceid=BR:pt-419", tag: "Bolsa" },
  { url: "https://news.google.com/rss/search?q=Fed+OR+juros+OR+inflacao+OR+%22economia+global%22+when:1d&hl=pt-BR&gl=BR&ceid=BR:pt-419", tag: "Economia" },
  { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", tag: "Mundo" }];
const POS = ["alta", "sobe", "subiu", "dispara", "disparou", "recorde", "ganho", "ganhos", "otimismo", "avanca", "avanco",
  "recupera", "valoriza", "valorizacao", "lucro", "aprova", "corte de juros", "rally", "gains", "rises", "rose", "record",
  "beats", "surge", "surges", "jumps", "rebound", "optimism", "upgrade", "bull"];
const NEG = ["queda", "cai", "caiu", "despenca", "despencou", "perda", "perdas", "crise", "medo", "tensao", "guerra",
  "recessao", "tarifa", "tarifas", "derrete", "desvaloriza", "prejuizo", "falls", "fell", "drops", "plunge", "slump",
  "fear", "war", "recession", "crash", "selloff", "sell-off", "tariff", "tariffs", "downgrade", "bear", "hack"];

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
    const q = "https://data-api.binance.vision/api/v3/klines?symbol=" + symbol + "&interval=" + interval +
      "&limit=1000" + (end ? "&endTime=" + end : "");
    const rows = await getJSON(q);
    all = rows.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })).concat(all);
    if (rows.length < 1000) break;
    end = rows[0][0] - 1;
  }
  return all;
}

async function yahoo(symbol, interval, range) {
  const d = await getJSON("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) +
    "?interval=" + interval + "&range=" + range);
  const r = d.chart.result[0], q = r.indicators.quote[0];
  const bars = [];
  (r.timestamp || []).forEach((t, i) => {
    if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(v => v === null || v === undefined)) return;
    bars.push({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
  });
  return { bars, meta: r.meta };
}

// ---------------------------------------------------------------- analysis

function round(v, d) { const m = Math.pow(10, d === undefined ? 2 : d); return Math.round(v * m) / m; }
function pctChange(a, b) { return b ? (a - b) / b : 0; }
function dayKey(t) { return new Date(t).toISOString().slice(0, 10); }

function summarize(asset, a) {
  const r = a.robot ? a.robot.all : null;
  return {
    id: asset.id, name: asset.name, short: asset.short, cur: asset.cur || "US$", kind: asset.kind,
    price: a.price, verdict: a.verdict, score: a.score, dir: a.dir, held: a.blocked || null,
    rsi: round(a.rsi, 1), adx: a.adx === null ? null : round(a.adx, 1), trend: a.trend, htfTrend: a.htfTrend,
    plan: a.plan ? { dir: a.plan.dir, entry: a.plan.entry, stop: a.plan.stop, take1: a.plan.take1,
                     take2: a.plan.take2, riskPct: round(a.plan.riskPct * 100, 2) } : null,
    watch: a.watch,
    record: r ? { n: r.n, win: round(r.winRate * 100, 0), exp: round(r.expectancy, 2), total: round(r.totalR, 1) } : null,
    analog: a.analogs ? { k: a.analogs.k, h: a.analogs.horizon, up: round(a.analogs.upRate * 100, 0),
                          med: round(a.analogs.medRet * 100, 2) } : null,
    triggers: a.strategies.filter(s => s.now).map(s => ({ name: s.name, dir: s.now, edge: s.weight > 0 })),
    reasons: a.reasons.slice(0, 6).map(x => x.text)
  };
}

// Paper broker. The robot's own sequence of trades (one at a time, decided
// candle by candle with no look-ahead) from a fixed start; the broker takes
// those the risk desk would have approved then (robot record positive at that
// moment, at least 10 trades) and risks 1% of equity on each.
function brokerTrades(asset, p, fromIdx) {
  const wf = Robo.walkForward(p, Math.max(Robo.WARMUP + 50, fromIdx - 1500));
  const out = [], done = [];
  wf.trades.forEach(t => {
    const before = Robo.stats(done.filter(d => d.exitIdx <= t.i));
    const ok = before.n >= 10 && before.expectancy > 0;
    if (t.i >= fromIdx && ok) {
      const bars = p.bars;
      out.push({ asset: asset.short, id: asset.id, dir: t.dir, entry: t.entry, stop: t.stop, take: t.take,
                 opened: bars[t.entryIdx] ? bars[t.entryIdx].t : bars[t.i].t,
                 closed: t.open ? null : bars[t.exitIdx].t, exit: t.open ? null : t.exit,
                 why: t.open ? null : t.why, r: t.open ? null : round(t.r, 2),
                 openR: t.open ? round(t.dir * (bars[bars.length - 1].c - t.entry) / Math.abs(t.entry - t.stop), 2) : null });
    }
    if (!t.open) done.push(t);
  });
  return out;
}

function ledger(trades, since) {
  const closed = trades.filter(t => t.closed !== null && t.opened >= since).sort((a, b) => a.closed - b.closed);
  let eq = START_EQUITY, peak = eq, dd = 0;
  const curve = [{ t: since, eq }];
  closed.forEach(t => {
    t.pnl = round(eq * RISK_PER_TRADE * t.r, 2);
    eq += t.pnl;
    peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak);
    curve.push({ t: t.closed, eq: round(eq, 2) });
  });
  const open = trades.filter(t => t.closed === null && t.opened >= since);
  open.forEach(t => { t.openPnl = round(eq * RISK_PER_TRADE * t.openR, 2); });
  const st = Robo.stats(closed.map(t => ({ r: t.r })));
  return { since, equity: round(eq, 2), ret: round((eq / START_EQUITY - 1) * 100, 2), maxDD: round(dd * 100, 1),
           n: st.n, win: round(st.winRate * 100, 0), exp: round(st.expectancy, 2),
           open, closed: closed.slice(-40).reverse(), curve: curve.slice(-120) };
}

function lab(prepared) {
  const variants = [[1.0, 2], [1.5, 2], [2.0, 2], [1.5, 3], [2.0, 3], [1.5, 1.5]];
  return prepared.map(({ asset, bars, htf, fee }) => {
    const rows = variants.map(([stopAtr, rr]) => {
      const p = Robo.prepare(bars, { stopAtr, rr, fee, tfMs: DAY, htfMs: WEEK }, htf);
      const s = Robo.walkForward(p, bars.length - 1500).all;
      return { stopAtr, rr, n: s.n, exp: round(s.expectancy, 2), win: round(s.winRate * 100, 0), total: round(s.totalR, 1) };
    });
    return { asset: asset.short, rows };
  });
}

// ---------------------------------------------------------------- news

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
  [["BTC", /bitcoin|btc/], ["ETH", /ethereum|ether\b|eth\b/], ["Juros", /juros|fed\b|selic|copom|rate/],
   ["Dolar", /dolar|dollar|cambio/], ["Petroleo", /petroleo|petrobras|oil|brent/], ["China", /china|chines/],
   ["EUA", /eua|trump|wall street|s&p|nasdaq|dow/]].forEach(([k, re]) => { if (re.test(t) && tags.indexOf(k) < 0) tags.push(k); });
  return tags;
}

async function news(now) {
  const items = [];
  for (const f of NEWS) {
    try {
      const xml = await getText(f.url);
      const blocks = xml.split(/<item>/).slice(1);
      blocks.slice(0, 25).forEach(b => {
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

// ---------------------------------------------------------------- the people

const PEOPLE = [
  { id: "helena", name: "Helena", role: "Diretora", desk: "dir" },
  { id: "otavio", name: "Otavio", role: "Economista", desk: "eco" },
  { id: "lia", name: "Lia", role: "Pesquisadora de noticias", desk: "res" },
  { id: "rafa", name: "Rafa", role: "Trader de cripto", desk: "trade" },
  { id: "bia", name: "Bia", role: "Trader de bolsa", desk: "trade" },
  { id: "kenji", name: "Kenji", role: "Analista quantitativo", desk: "quant" },
  { id: "marta", name: "Marta", role: "Gestora de risco", desk: "risk" },
  { id: "teo", name: "Teo", role: "Operador da corretora", desk: "broker" },
  { id: "caio", name: "Caio", role: "Desenvolvedor (laboratorio)", desk: "dev" },
  { id: "nina", name: "Nina", role: "Desenvolvedora (dados)", desk: "dev" }];

function fmt(v, d) { return v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function money(v, cur) { return (cur || "US$") + " " + fmt(v, v >= 100 ? 0 : v >= 1 ? 2 : 4); }
function sgn(v, d) { return (v >= 0 ? "+" : "") + fmt(v, d === undefined ? 2 : d); }
function verdictLine(x) {
  return x.short + " " + x.verdict + (x.held ? " (regra daria " + x.held + ", segurado)" : "") + " nota " + sgn(x.score, 0);
}

function climate(macro, fng) {
  const by = id => macro.find(m => m.id === id);
  let s = 0;
  const spx = by("^GSPC"), vix = by("^VIX"), dxy = by("DX-Y.NYB");
  if (spx) s += spx.chg5d > 0.01 ? 1 : spx.chg5d < -0.01 ? -1 : 0;
  if (vix) s += vix.price < 16 ? 1 : vix.price > 22 ? -1 : 0;
  if (dxy) s += dxy.chg5d < -0.005 ? 1 : dxy.chg5d > 0.005 ? -1 : 0;
  if (fng) s += fng.value >= 60 ? 1 : fng.value <= 35 ? -1 : 0;
  return { score: s, label: s >= 2 ? "apetite a risco" : s <= -2 ? "aversao a risco" : "neutro, sem direcao clara" };
}

function meeting(st, now) {
  const L = [], say = (who, text) => L.push({ who, text });
  const h = new Date(now).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
  const by = id => st.macro.find(m => m.id === id);
  say("helena", "Reuniao das " + h + " (Brasilia). Mercado, noticias, sinais e risco, nessa ordem.");
  const spx = by("^GSPC"), ibov = by("^BVSP"), brl = by("BRL=X"), tnx = by("^TNX"), vix = by("^VIX");
  say("otavio", [spx && "S&P 500 " + sgn(spx.chg1d * 100) + "% no dia e " + sgn(spx.chg5d * 100) + "% na semana",
    ibov && "Ibovespa " + sgn(ibov.chg1d * 100) + "% no dia", brl && "dolar a R$ " + fmt(brl.price, 2) + " (" + sgn(brl.chg1d * 100) + "%)",
    tnx && "juros de 10 anos dos EUA em " + fmt(tnx.price, 2) + "%", vix && "VIX em " + fmt(vix.price, 1)]
    .filter(Boolean).join(", ") + ". Clima: " + st.climate.label + ".");
  const pos = st.news.filter(n => n.tone > 0).length, neg = st.news.filter(n => n.tone < 0).length;
  const top = st.news.find(n => n.tone !== 0) || st.news[0];
  say("lia", (st.fng ? "Medo e ganancia das cripto em " + st.fng.value + " (" + st.fng.label + "). " : "") +
    "Li " + st.news.length + " manchetes das ultimas 48h: " + pos + " positivas, " + neg + " negativas." +
    (top ? " Destaque: \"" + top.title + "\" (" + (top.source || top.tags[0]) + ")." : ""));
  const cr = st.assets.filter(a => a.kind === "crypto"), sk = st.assets.filter(a => a.kind === "stock");
  say("rafa", "Cripto no diario: " + cr.map(verdictLine).join("; ") + ".");
  say("bia", "Bolsa no diario: " + sk.map(verdictLine).join("; ") + ".");
  const good = st.assets.filter(a => a.record && a.record.n >= 10 && a.record.exp > 0);
  say("kenji", good.length
    ? "O robo tem historico positivo (sem olhar o futuro) em " + good.map(a => a.short + " " + sgn(a.record.exp) + "R").join(", ") +
      ". Nos outros ativos os sinais ficam segurados."
    : "Nenhum ativo com historico positivo do robo agora. Tudo segurado.");
  const sig = st.assets.filter(a => a.dir !== 0), held = st.assets.filter(a => a.held);
  say("marta", (sig.length ? "Aprovo no papel: " + sig.map(a => a.short + " " + a.verdict.toLowerCase() +
      " com stop em " + money(a.plan.stop, a.cur)).join("; ") + ". " : "Nada aprovado agora. ") +
    (held.length ? "Segurei " + held.map(a => a.short).join(", ") + ": o robo ainda nao provou vantagem nesses. " : "") +
    "Risco por operacao: 1% do patrimonio.");
  const b = st.broker.live;
  say("teo", "Corretora virtual (desde " + FOUNDED.split("-").reverse().join("/") + "): patrimonio US$ " + fmt(b.equity, 0) +
    " (" + sgn(b.ret) + "%), " + b.open.length + " posicao(oes) aberta(s), " + b.n + " operacao(oes) encerrada(s)" +
    (b.pending.length ? ". Ordens para a proxima abertura: " + b.pending.map(o => (o.dir > 0 ? "compra " : "venda ") + o.asset).join(", ") : "") + ".");
  const best = [];
  st.lab.forEach(x => {
    const cur = x.rows.find(r => r.stopAtr === 1.5 && r.rr === 2), top2 = x.rows.slice().sort((p, q) => q.exp - p.exp)[0];
    if (cur && top2) best.push(x.asset + ": atual " + sgn(cur.exp) + "R, melhor variante stop " + top2.stopAtr + " ATR e alvo " +
      top2.rr + "R com " + sgn(top2.exp) + "R");
  });
  say("caio", "Laboratorio: " + best.join("; ") + ". Nao troco a regra sozinho: pode ser sorte do periodo, fica em observacao.");
  say("nina", "Dados desta rodada: " + st.assets.length + " ativos, " + st.macro.length + " indicadores e " + st.news.length +
    " noticias. Fontes: Binance, Yahoo Finance, alternative.me, Google Noticias e MarketWatch.");
  const btc = st.assets.find(a => a.short === "BTC");
  say("helena", "Leitura da casa: clima " + st.climate.label + ". " +
    (btc && btc.analog ? "Para o BTC, nos " + btc.analog.k + " dias mais parecidos com hoje o preco subiu em " + btc.analog.up +
      "% das vezes nos " + btc.analog.h + " dias seguintes. " : "") +
    (sig.length ? "Seguimos os sinais aprovados, no papel." : "Hoje e dia de esperar.") + " Nao e recomendacao de investimento.");
  return { time: now, lines: L };
}

function agentReports(st) {
  const r = {};
  const by = id => st.macro.find(m => m.id === id);
  const cr = st.assets.filter(a => a.kind === "crypto"), sk = st.assets.filter(a => a.kind === "stock");
  const lead = list => list.slice().sort((a, b) => Math.abs(b.score) - Math.abs(a.score))[0];
  const m = st.meeting.lines, line = id => (m.filter(x => x.who === id).pop() || {}).text || "";
  r.helena = { task: "Coordenando a mesa e as reunioes", report: line("helena") };
  r.otavio = { task: "Acompanhando juros, dolar e bolsas", report: line("otavio"), bubble: "Clima: " + st.climate.label };
  r.lia = { task: "Lendo noticias do mundo", report: line("lia"),
            bubble: st.news[0] ? st.news[0].title.slice(0, 70) : "Sem manchetes novas" };
  const c = lead(cr), s = lead(sk);
  r.rafa = { task: "Analisando graficos de cripto", report: line("rafa"), bubble: c ? verdictLine(c) : "" };
  r.bia = { task: "Analisando acoes da B3 e dos EUA", report: line("bia"), bubble: s ? verdictLine(s) : "" };
  r.kenji = { task: "Testando estrategias no historico", report: line("kenji"),
              bubble: (st.assets.find(a => a.short === "BTC") || {}).record ? "BTC: robo " +
                sgn(st.assets.find(a => a.short === "BTC").record.exp) + "R por trade" : "" };
  r.marta = { task: "Conferindo limites de risco", report: line("marta"), bubble: "Risco por trade: 1%" };
  r.teo = { task: "Registrando ordens na corretora virtual", report: line("teo"),
            bubble: "Patrimonio US$ " + fmt(st.broker.live.equity, 0) };
  r.caio = { task: "Rodando experimentos no laboratorio", report: line("caio"), bubble: "Testando variantes de stop e alvo" };
  r.nina = { task: "Cuidando dos dados e das fontes", report: line("nina"), bubble: st.assets.length + " ativos lidos" };
  return r;
}

// ---------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2), outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : null;
  const evIdx = args.indexOf("--every-hours"), every = evIdx >= 0 ? +args[evIdx + 1] : null;
  const now = Date.now(), founded = Date.parse(FOUNDED + "T00:00:00Z");
  const errors = [];
  const assets = [], prepared = [], liveTrades = [], simTrades = [];

  for (const a of CRYPTO) {
    try {
      const d = (await binance(a.id, "1d", 3)).filter(b => b.t + DAY <= now);
      const w = (await binance(a.id, "1w", 1)).filter(b => b.t + WEEK <= now);
      const opts = { tfMs: DAY, htfMs: WEEK, fee: 0.001 };
      const an = Robo.analyze(d, opts, w);
      assets.push(Object.assign(summarize(Object.assign({ kind: "crypto" }, a), an), { chg1d: round(pctChange(d[d.length - 1].c, d[d.length - 2].c) * 100, 2) }));
      const p = Robo.prepare(d, opts, w);
      prepared.push({ asset: a, bars: d, htf: w, fee: 0.001 });
      const tr = brokerTrades(a, p, d.findIndex(b => b.t >= founded - 400 * DAY));
      tr.forEach(t => { simTrades.push(t); if (t.opened >= founded) liveTrades.push(t); });
    } catch (e) { errors.push(a.id + ": " + e.message); }
  }
  for (const a of STOCKS) {
    try {
      const y = await yahoo(a.id, "1d", "10y"), wk = await yahoo(a.id, "1wk", "10y");
      // a daily candle from today is still forming while the exchange is open
      const d = y.bars.filter(b => dayKey(b.t) !== dayKey(now) || now - b.t > DAY);
      const w = wk.bars.filter(b => b.t + WEEK <= now);
      const opts = { tfMs: DAY, htfMs: WEEK, fee: 0.0005, step: 1 };
      const an = Robo.analyze(d, opts, w);
      assets.push(Object.assign(summarize(Object.assign({ kind: "stock" }, a), an), { chg1d: round(pctChange(d[d.length - 1].c, d[d.length - 2].c) * 100, 2) }));
      const p = Robo.prepare(d, opts, w);
      const tr = brokerTrades(a, p, d.findIndex(b => b.t >= founded - 400 * DAY));
      tr.forEach(t => { simTrades.push(t); if (t.opened >= founded) liveTrades.push(t); });
    } catch (e) { errors.push(a.id + ": " + e.message); }
  }

  const macro = [];
  for (const m of MACRO) {
    try {
      const y = await yahoo(m.id, "1d", "3mo"), b = y.bars, c = b[b.length - 1].c;
      const back = k => b[Math.max(0, b.length - 1 - k)].c;
      macro.push({ id: m.id, name: m.name, price: round(c, 4), chg1d: round(pctChange(c, back(1)), 5),
                   chg5d: round(pctChange(c, back(5)), 5), chg1m: round(pctChange(c, back(21)), 5),
                   spark: b.slice(-30).map(x => round(x.c, 4)) });
    } catch (e) { errors.push(m.id + ": " + e.message); }
  }

  let fng = null;
  try {
    const f = (await getJSON("https://api.alternative.me/fng/?limit=8")).data;
    const pt = { "Extreme Fear": "medo extremo", "Fear": "medo", "Neutral": "neutro", "Greed": "ganancia", "Extreme Greed": "ganancia extrema" };
    fng = { value: +f[0].value, label: pt[f[0].value_classification] || f[0].value_classification, weekAgo: +f[f.length - 1].value };
  } catch (e) { errors.push("fng: " + e.message); }

  const headlines = (await news(now)).slice(0, 18);
  const st = { version: 1, updatedAt: now, nextAt: every ? now + every * 36e5 : null, founded: FOUNDED, startEquity: START_EQUITY, assets, macro, fng,
               news: headlines, errors };
  st.climate = climate(macro, fng);
  st.broker = { live: ledger(liveTrades, founded), sim: ledger(simTrades, founded - 365 * DAY) };
  // approved signals on the last closed candle: filled at the next open
  st.broker.live.pending = assets.filter(a => a.dir !== 0 && a.plan).map(a => ({
    asset: a.short, name: a.name, cur: a.cur, dir: a.dir, ref: a.price, stop: a.plan.stop, take: a.plan.take2,
    riskPct: a.plan.riskPct }));
  st.lab = lab(prepared.filter(x => x.asset.short === "BTC" || x.asset.short === "ETH"));
  st.meeting = meeting(st, now);
  st.agents = agentReports(st);
  st.people = PEOPLE;
  st.broker.sim.curve = st.broker.sim.curve.slice(-80);

  const json = JSON.stringify(st);
  if (out) fs.writeFileSync(out, json);
  else process.stdout.write(json + "\n");
  console.error("agency: " + assets.length + " assets, " + macro.length + " macro, " + headlines.length + " news, " +
                (json.length / 1024).toFixed(0) + " KB" + (errors.length ? ", errors: " + errors.join(" | ") : ""));
  return st;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { tone, tagsOf, climate, ledger, decode };
