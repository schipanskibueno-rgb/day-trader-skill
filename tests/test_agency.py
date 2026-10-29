"""The agency: its trading method (agency/method.js) and the brain's helpers (agency/brain.js), under Node.
The brain's full run needs the network and is not tested here."""

import json
import os
import shutil
import subprocess
import unittest

from _load import ROOT

NODE = shutil.which("node")
METHOD = os.path.join(ROOT, "agency", "method.js")
BRAIN = os.path.join(ROOT, "agency", "brain.js")

SCRIPT = r"""
const M = require(process.argv[1]), B = require(process.argv[2]);
const out = {};
const bar = (t, o, h, l, c, v) => ({t, o, h, l, c, v});

// volume profile: all the volume sits around 10, so the POC and value area are there
const pb = [bar(0, 10, 10.2, 9.8, 10, 1000), bar(1, 10, 10.2, 9.8, 10, 1000), bar(2, 10, 12, 8, 11, 10)];
const pr = M.profile(pb, 0, 2);
out.profile = [pr.poc > 9.7 && pr.poc < 10.3, pr.val <= 10 && pr.vah >= 10, pr.lo, pr.hi];

// a pivot is only known k candles after it prints
const pv = M.pivots([1, 2, 5, 2, 1, 1, 1].map((h, i) => bar(i, h, h, h - 0.5, h, 1)), 2);
out.pivot = pv.hi.map(p => [p.i, p.known]);

// the desk: fixed money risk, at most 2 stops a day, then no new trade that day
const day = Date.UTC(2026, 9, 27), H = 36e5;
const bars = []; for (let i = 0; i < 30; i++) bars.push(bar(day + i * H, 100, 100.5, 99.5, 100, 1));
bars[3] = bar(day + 3 * H, 100, 100.5, 98, 99, 1);     // hits the first stop
bars[6] = bar(day + 6 * H, 100, 100.5, 98, 99, 1);     // hits the second stop
bars[10] = bar(day + 10 * H, 100, 104, 99.5, 103, 1);  // would hit a target, but the desk is closed by then
const t = (i, entry) => ({ i, entryIdx: i + 1, dir: 1, entry: 100, stop: 99, take: 103, risk: 1 });
const mk = (id, trades) => ({ id, short: id, bars, trades, fee: 0 });
const d = M.desk([mk("A", [t(1)]), mk("B", [t(4)]), mk("C", [t(8)])], { stopUsd: 80, capital: 5000, maxStopsPerDay: 2, block: 25 });
out.desk = { n: d.n, pnl: d.pnl, skipped: d.skipped.map(s => s.skippedWhy), closedDays: d.closedDays };

// a target 3R away pays three times the stop
const win = M.resolve(bars, { i: 8, entryIdx: 9, dir: 1, entry: 100, stop: 99, take: 103, risk: 1 }, 0);
out.win = [win.result, win.r];
// both in one candle: the stop counts
const both = [bar(0, 100, 100, 100, 100, 1), bar(H, 100, 104, 98, 100, 1)];
out.both = M.resolve(both, { i: 0, entryIdx: 1, dir: 1, entry: 100, stop: 99, take: 103, risk: 1 }, 0).result;

// setups never read the future: the same trades with or without the candles after them
const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
const series = []; let px = 100;
for (let i = 0; i < 3000; i++) { const o = px; px = Math.max(1, px + (rnd() - 0.5) * 2 + Math.sin(i / 90) * 0.3);
  series.push(bar(i * 9e5, o, Math.max(o, px) + rnd(), Math.min(o, px) - rnd(), px, 100 + rnd() * 300 + (i % 37 === 0 ? 900 : 0))); }
const full = M.setups(series, { macroMs: 36e5 }), cut = M.setups(series.slice(0, 2000), { macroMs: 36e5 });
const early = full.trades.filter(x => x.entryIdx < 1999).map(x => x.i + ":" + x.entry);
out.causal = [JSON.stringify(early) === JSON.stringify(cut.trades.filter(x => x.entryIdx < 1999).map(x => x.i + ":" + x.entry)), full.regions.length > 0];

// version 2 (POI after a liquidity sweep): causal, sells mirror buys, and a limit fill never counts the target in its own candle
const walk = []; let w = 100;
for (let i = 0; i < 20000; i++) { const o = w; w = Math.max(1, w + (rnd() - 0.5) * 0.6 + Math.sin(i / 300) * 0.05);
  walk.push(bar(i * 3e5, o, Math.max(o, w) + rnd() * 0.2, Math.min(o, w) - rnd() * 0.2, w, 100 + rnd() * 300)); }
const pf = M.poiSetups(walk), pc = M.poiSetups(walk.slice(0, 12000)), key = x => x.entryIdx + ":" + x.dir + ":" + x.entry.toFixed(6);
const pm = M.poiSetups(M.mirror(walk));
out.poi = [pf.trades.length > 0,
           JSON.stringify(pf.trades.filter(x => x.entryIdx < 11990).map(key)) === JSON.stringify(pc.trades.filter(x => x.entryIdx < 11990).map(key)),
           pf.trades.filter(x => x.dir < 0).length === pm.trades.filter(x => x.dir > 0).length,
           pf.trades.every(x => x.dir * (x.take - x.entry) > 0 && Math.abs(x.take - x.entry - 3 * x.dir * x.risk) < 1e-9 && x.dir * (x.entry - x.stop) > 0)];
const lim = [bar(0, 100, 100, 100, 100, 1), bar(H, 101, 104, 99.8, 103.5, 1), bar(2 * H, 103, 103.5, 102, 103, 1)];
out.limit = [M.resolve(lim, { i: 0, entryIdx: 1, dir: 1, entry: 100, stop: 99, take: 103, risk: 1, limit: true }, 0).exitIdx,
             M.resolve(lim, { i: 0, entryIdx: 1, dir: 1, entry: 100, stop: 99, take: 103, risk: 1 }, 0).exitIdx];

// Wyckoff in reserve: a sideways 15m stretch is a trading range, a trend is not
const flat = [], trend = [];
for (let i = 0; i < 80; i++) { const f = 100 + Math.sin(i / 3) * 0.5; flat.push(bar(i * 9e5, f, f + 0.6, f - 0.6, f + 0.1, 100));
  const g = 100 + i * 0.8; trend.push(bar(i * 9e5, g, g + 0.6, g - 0.6, g + 0.5, 100)); }
const oo = Object.assign({}, M.P, M.POI);
out.range = [!!M.tradingRange(flat, M.atr(flat, 14), 79, oo), !!M.tradingRange(trend, M.atr(trend, 14), 79, oo)];

// the MT5 bridge: a summary from the robot is kept, junk and future-dated posts are dropped
const now = Date.UTC(2026, 9, 29, 12);
const good = { v: 1, acc: 1, srv: "MetaQuotes-Demo", demo: true, t: now / 1000 - 60, cur: "USD", bal: 100, eq: 101, stops: 0, open: true, stop: 50,
               algo: true, pos: [{ s: "BTCUSD", d: 1, lot: 0.1, p: 1, sl: 0.9, tp: 1.3, pl: 1, t: now / 1000 - 600 }], ord: [], deals: [], n: 0, w: 0, sum: 0, st: ["BTCUSD: ok"] };
out.mt5 = [B.cleanMt5(good, now).pos[0].s, B.cleanMt5({ v: 2 }, now), B.cleanMt5(Object.assign({}, good, { t: now / 1000 + 3600 }), now),
           B.cleanMt5(Object.assign({}, good, { srv: "<script>x" }), now).srv];

out.tone = [B.tone("Ibovespa dispara e bate recorde"), B.tone("Bitcoin despenca com medo de recessao"), B.tone("Mercado aguarda decisao do Fed")];
out.tags = B.tagsOf("Lula reeleito: dolar dispara", "Politica");
out.climate = [B.climate([{id: "^GSPC", chg5d: 0.02}, {id: "^VIX", price: 14}, {id: "DX-Y.NYB", chg5d: -0.01}]).label,
               B.climate([{id: "^GSPC", chg5d: -0.03}, {id: "^VIX", price: 28}]).label];
out.profileOf = [B.profileOf({ capital: 3000, stopUsd: 45, maxStopsPerDay: 2 }), B.profileOf({ capital: 5000, stopUsd: 80, maxStopsPerDay: 2 })];
// CME futures: closed Saturday, open Tuesday 13:00 UTC, BTC always open
out.open = [B.marketOpen({}, Date.UTC(2026, 9, 31, 12)), B.marketOpen({}, Date.UTC(2026, 9, 27, 13)), B.marketOpen({ always: true }, Date.UTC(2026, 9, 31, 12))];
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class Agency(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        res = subprocess.run([NODE, "-e", SCRIPT, METHOD, BRAIN], capture_output=True, text=True, timeout=120)
        if res.returncode:
            raise AssertionError(res.stderr)
        cls.out = json.loads(res.stdout)

    def test_volume_profile(self):
        poc_ok, va_ok, lo, hi = self.out["profile"]
        self.assertTrue(poc_ok and va_ok)
        self.assertEqual((lo, hi), (8, 12))

    def test_pivot_known_only_after_k_candles(self):
        self.assertEqual(self.out["pivot"], [[2, 4]])

    def test_two_stops_close_the_desk_for_the_day(self):
        d = self.out["desk"]
        self.assertEqual(d["n"], 2)
        self.assertEqual(d["pnl"], -160)               # two stops of 80
        self.assertEqual(d["skipped"], ["2 stops no dia"])
        self.assertEqual(d["closedDays"], ["2026-10-27"])

    def test_target_is_3r_and_the_stop_wins_ties(self):
        self.assertEqual(self.out["win"], ["alvo", 3])
        self.assertEqual(self.out["both"], "stop")

    def test_setups_never_read_the_future(self):
        same, has_regions = self.out["causal"]
        self.assertTrue(has_regions)
        self.assertTrue(same)

    def test_poi_version_is_causal_and_symmetric(self):
        has_trades, causal, mirror, levels = self.out["poi"]
        self.assertTrue(has_trades)
        self.assertTrue(causal)
        self.assertTrue(mirror)
        self.assertTrue(levels)                         # stop on the far side, target exactly 3R

    def test_limit_fill_does_not_take_the_target_in_its_own_candle(self):
        self.assertEqual(self.out["limit"], [2, 1])

    def test_wyckoff_only_sees_sideways_structures(self):
        self.assertEqual(self.out["range"], [True, False])

    def test_mt5_bridge_keeps_only_clean_summaries(self):
        name, wrong_version, future, srv = self.out["mt5"]
        self.assertEqual(name, "BTCUSD")
        self.assertIsNone(wrong_version)
        self.assertIsNone(future)
        self.assertEqual(srv, "<script>x")   # plain text: the page writes it with textContent, never as HTML

    def test_brain_helpers(self):
        self.assertEqual(self.out["tone"], [1, -1, 0])
        self.assertIn("Politica", self.out["tags"])
        self.assertIn("Dolar", self.out["tags"])
        self.assertEqual(self.out["climate"], ["apetite a risco", "aversao a risco"])
        regular, high = self.out["profileOf"]
        self.assertEqual(regular, {"dailyRiskUsd": 90, "dailyRiskPct": 3, "label": "Regular"})   # the material's own example
        self.assertEqual(high["label"], "Regular")
        self.assertEqual(self.out["open"], [False, True, True])


class Page(unittest.TestCase):
    def test_page_reads_the_database_and_places_no_orders(self):
        with open(os.path.join(ROOT, "agency", "agencia.html"), encoding="utf-8") as fh:
            html = fh.read()
        self.assertIn('db.doc("agency/state")', html)
        self.assertIn('db.doc("agency/config")', html)
        self.assertIn("three@0.160.0", html)
        for bad in ("X-MBX-APIKEY", "/api/v3/order", "fetch("):
            self.assertNotIn(bad, html)


if __name__ == "__main__":
    unittest.main()
