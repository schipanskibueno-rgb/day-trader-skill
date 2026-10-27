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
