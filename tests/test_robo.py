"""The Robo Trader page's engine (docs/engine.js), run under Node on real BTCUSDT candles."""

import json
import os
import shutil
import subprocess
import unittest

from _load import ROOT, FIX

NODE = shutil.which("node")
ENGINE = os.path.join(ROOT, "docs", "engine.js")
BARS_1H = os.path.join(FIX, "robo", "btcusdt-1h.json")
BARS_4H = os.path.join(FIX, "robo", "btcusdt-4h.json")

SCRIPT = r"""
const R = require(process.argv[1]);
const load = f => require(f).map(r => ({t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5]}));
const h1 = load(process.argv[2]), h4 = load(process.argv[3]);
const out = {};

// RSI and ATR: Wilder's, as in the Python tools
const c = h1.map(b => b.c);
out.rsi = R.rsi(c, 14)[c.length - 1];
out.atr = R.atr(h1, 14)[h1.length - 1];

// no look-ahead: standing at candle i on the full history gives the same answer
// as analyzing only the candles up to i
const p = R.prepare(h4, {});
out.lookahead = [700, 1200, 1800, 2400, 2990].map(i => {
  const d = R.decide(p, i, false), e = R.analyze(h4.slice(0, i + 1), {walkForward: false});
  return [d.score === e.score, d.verdict === e.verdict];
});

// a trade enters on the NEXT open and, when one candle hits both, the stop wins
const x = R.indicators(h1);
const t = R.simTrade(h1, x, 500, 1, R.DEFAULTS, h1.length - 1);
out.trade = {entry: t.entry, nextOpen: h1[501].o, entryIdx: t.entryIdx};
const wide = h1.map(b => ({...b}));
const e0 = wide[601].o, risk = R.DEFAULTS.stopAtr * x.atr[600];
wide[601] = {...wide[601], h: e0 + 10 * risk, l: e0 - 10 * risk};
const both = R.simTrade(wide, x, 600, 1, R.DEFAULTS, wide.length - 1);
out.both = both.why;

// the robot's own record only trades decisions made before the entry candle
const a = R.analyze(h1, {tfMs: 36e5, htfMs: 144e5}, h4);
out.verdict = a.verdict;
out.robotOk = a.robot.trades.every(tr => tr.entryIdx === tr.i + 1);
out.robotN = a.robot.all.n;
out.strategies = a.strategies.length;
out.blockedHasNote = !a.blocked || /segurado/.test(a.note);
out.planIfSignal = a.dir === 0 ? a.plan === null : a.plan.qty > 0;

// fees: a round trip costs about 2 x 0.1% of the price, in R
const flat = R.stats([{r: 0.5}, {r: -1}, {r: 2}]);
out.stats = [flat.n, flat.wins, Math.round(flat.expectancy * 100) / 100];
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class Engine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        res = subprocess.run([NODE, "-e", SCRIPT, ENGINE, BARS_1H, BARS_4H], capture_output=True, text=True,
                             timeout=120)
        if res.returncode:
            raise AssertionError(res.stderr)
        cls.out = json.loads(res.stdout)

    def wilder_rsi(self, closes, n=14):
        g = l = 0.0
        for i in range(1, n + 1):
            d = closes[i] - closes[i - 1]
            g += max(d, 0); l += max(-d, 0)
        g /= n; l /= n
        for i in range(n + 1, len(closes)):
            d = closes[i] - closes[i - 1]
            g = (g * (n - 1) + max(d, 0)) / n
            l = (l * (n - 1) + max(-d, 0)) / n
        return 100 - 100 / (1 + g / l)

    def test_rsi_matches_python(self):
        with open(BARS_1H) as fh:
            closes = [float(r[4]) for r in json.load(fh)]
        self.assertAlmostEqual(self.out["rsi"], self.wilder_rsi(closes), places=6)
        self.assertGreater(self.out["atr"], 0)

    def test_no_look_ahead(self):
        for same_score, same_verdict in self.out["lookahead"]:
            self.assertTrue(same_score and same_verdict, self.out["lookahead"])

    def test_entry_is_the_next_open_and_the_stop_wins_ties(self):
        t = self.out["trade"]
        self.assertEqual(t["entry"], t["nextOpen"])
        self.assertEqual(t["entryIdx"], 501)
        self.assertEqual(self.out["both"], "stop")

    def test_robot_record_and_verdict(self):
        self.assertTrue(self.out["robotOk"])
        self.assertGreater(self.out["robotN"], 0)
        self.assertEqual(self.out["strategies"], 7)
        self.assertIn(self.out["verdict"], ("COMPRA FORTE", "COMPRA", "AGUARDAR", "VENDA", "VENDA FORTE"))
        self.assertTrue(self.out["blockedHasNote"])
        self.assertTrue(self.out["planIfSignal"])

    def test_stats(self):
        self.assertEqual(self.out["stats"], [3, 2, 0.5])


class Launcher(unittest.TestCase):
    def test_serves_the_page_on_localhost(self):
        import threading
        import urllib.request
        from _load import load
        robo = load("docs", "robo")
        server = robo.make_server()
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            port = server.server_address[1]
            self.assertEqual(server.server_address[0], "127.0.0.1")
            with urllib.request.urlopen("http://localhost:%d/" % port) as r:
                self.assertIn("Robo Trader", r.read().decode())
            with urllib.request.urlopen("http://localhost:%d/engine.js" % port) as r:
                self.assertEqual(r.status, 200)
        finally:
            server.shutdown()
            server.server_close()


class Page(unittest.TestCase):
    def test_page_files_and_no_order_path(self):
        for f in ("index.html", "app.js", "engine.js", "style.css", "sw.js", "manifest.webmanifest", "icon.svg", "robo.py"):
            self.assertTrue(os.path.isfile(os.path.join(ROOT, "docs", f)), f)
        with open(os.path.join(ROOT, "docs", "app.js"), encoding="utf-8") as fh:
            app = fh.read()
        # the page reads public market data only: no keys, no signed calls, no orders
        for bad in ("X-MBX-APIKEY", "signature", "/api/v3/order", "secret"):
            self.assertNotIn(bad, app)
        with open(os.path.join(ROOT, "docs", "index.html"), encoding="utf-8") as fh:
            html = fh.read()
        self.assertIn("lightweight-charts@4.1.3", html)
        self.assertIn("Nao e recomendacao de investimento", html)


if __name__ == "__main__":
    unittest.main()
