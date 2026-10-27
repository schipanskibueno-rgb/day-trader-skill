"""The agency brain's helpers (agency/brain.js), run under Node. The full run needs the network and is not tested here."""

import json
import os
import shutil
import subprocess
import unittest

from _load import ROOT

NODE = shutil.which("node")
BRAIN = os.path.join(ROOT, "agency", "brain.js")
SCRIPT = r"""
const B = require(process.argv[1]);
const out = {
  tone: [B.tone("Ibovespa dispara e bate recorde"), B.tone("Bitcoin despenca com medo de recessao"),
         B.tone("Dolar tem maior alta e Ibovespa despenca"), B.tone("Mercado aguarda decisao do Fed")],
  tags: B.tagsOf("Petrobras sobe com petroleo e dolar cai", "Bolsa"),
  climate: [B.climate([{id: "^GSPC", chg5d: 0.02}, {id: "^VIX", price: 14}, {id: "DX-Y.NYB", chg5d: -0.01}], {value: 70}).label,
            B.climate([{id: "^GSPC", chg5d: -0.03}, {id: "^VIX", price: 28}], {value: 20}).label],
  decode: B.decode("<![CDATA[A &amp; B <b>x</b>]]>")
};
const L = B.ledger([{closed: 2, opened: 1, r: 2}, {closed: 3, opened: 2, r: -1}, {closed: null, opened: 4, openR: 0.5}], 0);
out.ledger = [L.equity, L.n, L.open.length, L.closed[0].pnl];
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class Brain(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        res = subprocess.run([NODE, "-e", SCRIPT, BRAIN], capture_output=True, text=True, timeout=60)
        if res.returncode:
            raise AssertionError(res.stderr)
        cls.out = json.loads(res.stdout)

    def test_headline_tone(self):
        self.assertEqual(self.out["tone"], [1, -1, 0, 0])

    def test_tags(self):
        self.assertEqual(self.out["tags"], ["Bolsa", "Dolar", "Petroleo"])

    def test_climate(self):
        self.assertEqual(self.out["climate"], ["apetite a risco", "aversao a risco"])

    def test_decode(self):
        self.assertEqual(self.out["decode"], "A & B x")

    def test_ledger_risks_one_percent_per_trade(self):
        # +2R on 100,000 at 1% risk = +2,000; then -1R on 102,000 = -1,020
        self.assertEqual(self.out["ledger"], [100980, 2, 1, -1020])


class Page(unittest.TestCase):
    def test_page_reads_the_database_and_places_no_orders(self):
        with open(os.path.join(ROOT, "agency", "agencia.html"), encoding="utf-8") as fh:
            html = fh.read()
        self.assertIn('db.doc("agency/state")', html)
        self.assertIn("three@0.160.0", html)
        for bad in ("X-MBX-APIKEY", "/api/v3/order", "fetch("):
            self.assertNotIn(bad, html)
