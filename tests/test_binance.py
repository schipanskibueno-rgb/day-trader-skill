import io
import json
import os
import shutil
import tempfile
import unittest
import urllib.parse
from contextlib import redirect_stdout, redirect_stderr
from decimal import Decimal

from _load import load

bn = load("trader-broker", "binance")

INFO = {"symbol": "BTCUSDT", "base": "BTC", "quote": "USDT", "tick": "0.01", "step": "0.00001",
        "min_qty": "0.00001", "min_notional": "5", "oco": True}
EXCHANGE_INFO = {"symbols": [{"symbol": "BTCUSDT", "baseAsset": "BTC", "quoteAsset": "USDT", "ocoAllowed": True,
                              "filters": [{"filterType": "PRICE_FILTER", "tickSize": "0.01000000"},
                                          {"filterType": "LOT_SIZE", "stepSize": "0.00001000",
                                           "minQty": "0.00001000"},
                                          {"filterType": "NOTIONAL", "minNotional": "5.00000000"}]}]}


class FakeBinance(object):
    """Answers like the testnet does, and remembers every call."""

    def __init__(self, price="80100", usdt="10000", btc="1", oco_fails=False):
        self.price, self.usdt, self.btc, self.oco_fails = price, usdt, btc, oco_fails
        self.calls = []

    def __call__(self, method, url, headers):
        u = urllib.parse.urlparse(url)
        q = dict(urllib.parse.parse_qsl(u.query))
        self.calls.append((method, u.path, q, headers))
        if u.path == "/api/v3/time":
            return 200, json.dumps({"serverTime": 1700000000000})
        if u.path == "/api/v3/ticker/price":
            return 200, json.dumps({"symbol": q["symbol"], "price": self.price})
        if u.path == "/api/v3/exchangeInfo":
            return 200, json.dumps(EXCHANGE_INFO)
        if u.path == "/api/v3/account":
            return 200, json.dumps({"canTrade": True, "permissions": ["SPOT"], "balances": [
                {"asset": "BTC", "free": self.btc, "locked": "0"},
                {"asset": "USDT", "free": self.usdt, "locked": "0"}]})
        if u.path == "/api/v3/order" and method == "POST":
            qty = Decimal(q["quantity"])
            return 200, json.dumps({"orderId": 7, "executedQty": q["quantity"],
                                    "cummulativeQuoteQty": str(qty * Decimal(self.price)),
                                    "fills": [{"commission": "0", "commissionAsset": "BTC"}]})
        if u.path == "/api/v3/orderList/oco":
            if self.oco_fails:
                return 400, json.dumps({"code": -1013, "msg": "Filter failure: PRICE_FILTER"})
            return 200, json.dumps({"orderListId": 99})
        if u.path == "/api/v3/openOrders":
            return 200, json.dumps([])
        return 404, json.dumps({"code": -1, "msg": "unknown " + u.path})

    def paths(self):
        return [(m, p) for m, p, _, _ in self.calls if p not in ("/api/v3/time",)]


class Signing(unittest.TestCase):
    def test_matches_binance_documented_example(self):
        secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j"
        query = ("symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1"
                 "&recvWindow=5000&timestamp=1499827319559")
        self.assertEqual(bn.sign(secret, query),
                         "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71")

    def test_signed_call_sends_key_header_and_signature(self):
        fake = FakeBinance()
        bn.Client("k", "s", opener=fake).account()
        method, path, q, headers = fake.calls[-1]
        self.assertEqual(headers["X-MBX-APIKEY"], "k")
        self.assertIn("signature", q)
        self.assertIn("timestamp", q)

    def test_only_the_testnet(self):
        self.assertEqual(bn.BASE_URL, "https://testnet.binance.vision")
        fake = FakeBinance()
        bn.Client(opener=fake).price("BTCUSDT")
        self.assertTrue(all(h for _, _, _, h in fake.calls))


class Plan(unittest.TestCase):
    def test_long_sized_to_max_loss(self):
        p = bn.build_plan(INFO, "80100", "buy", "79850", "82050", max_loss=50)
        self.assertEqual(p["side"], "BUY")
        self.assertEqual(p["stop"], "79850")
        self.assertLessEqual(Decimal(p["max_loss"]), 50)
        self.assertGreater(Decimal(p["qty"]), 0)
        self.assertLess(Decimal(p["stop_limit"]), Decimal(p["stop"]))
        self.assertAlmostEqual(p["reward_risk"], 7.8, places=1)

    def test_stop_rounds_away_and_qty_floors(self):
        p = bn.build_plan(INFO, "80100", "buy", "79850.009", "82050", qty="0.0012345")
        self.assertEqual(p["stop"], "79850")
        self.assertEqual(p["qty"], "0.00123")
        s = bn.build_plan(INFO, "80100", "sell", "80950.001", "79000", qty="0.001")
        self.assertEqual(s["stop"], "80950.01")
        self.assertGreater(Decimal(s["stop_limit"]), Decimal(s["stop"]))

    def test_refusals(self):
        bad = [("buy", "80200", "82050", None, 50),     # stop above the price
               ("buy", "79850", "80000", None, 50),     # take below the price
               ("sell", "79850", "79000", None, 50),    # short with the stop below
               ("buy", "80090", "82050", None, 50),     # 0.01%: too tight
               ("buy", "79850", "82050", "1", 50),      # over the max loss
               ("buy", "79850", "82050", "0.00001", 50),  # under the 5 USDT minimum
               ("buy", "79850", "80200", None, 50),     # reward:risk 0.4
               ("hold", "79850", "82050", None, 50)]
        for side, stop, take, qty, ml in bad:
            with self.assertRaises(bn.BinanceError, msg=(side, stop, take, qty)):
                bn.build_plan(INFO, "80100", side, stop, take, qty, ml)


class Yes(unittest.TestCase):
    T = {"symbol": "BTCUSDT", "side": "BUY", "qty": "0.019", "stop": "79850", "stop_limit": "79610.45",
         "take": "82050", "ref_price": "80100", "max_loss": "48.0"}

    def test_explicit_yes(self):
        for r in ("sim", "Sim.", "SIM", "s", "yes", "sim, pode mandar", "sim BTCUSDT", "sim 0.019",
                  "sim 0,019 btcusdt"):
            self.assertTrue(bn.parse_yes(r, self.T)[0], r)

    def test_everything_else(self):
        for r in ("", "ok", "pode", "manda", "vai", "claro", "sim?", "nao", "sim para todos", "sim, espera",
                  "sim mas so metade", "sim se cair", "sim ETHUSDT", "sim 0.5", "talvez sim"):
            self.assertFalse(bn.parse_yes(r, self.T)[0], r)


class Flow(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.environ["BINANCE_API_KEY"], os.environ["BINANCE_SECRET_KEY"] = "k", "s"
        self.fake = FakeBinance()
        self._orig = bn.Client.__init__.__defaults__
        bn.Client.__init__.__defaults__ = (None, None, self.fake)

    def tearDown(self):
        bn.Client.__init__.__defaults__ = self._orig
        del os.environ["BINANCE_API_KEY"], os.environ["BINANCE_SECRET_KEY"]
        shutil.rmtree(self.tmp)

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = bn.main(["--dir", self.tmp] + list(argv))
        return code, out.getvalue(), err.getvalue()

    def state(self):
        with open(os.path.join(self.tmp, "state", "binance.json")) as fh:
            return json.load(fh)["tickets"]

    def test_plan_approve_place(self):
        code, out, _ = self.run_cli("plan", "--side", "buy", "--stop", "79850", "--take", "82050")
        self.assertEqual(code, 0)
        self.assertIn("TESTNET", out)
        code, out, err = self.run_cli("place", "--index", "1")
        self.assertEqual(code, 2, "no yes, no order")
        self.assertNotIn(("POST", "/api/v3/order"), self.fake.paths())
        code, out, _ = self.run_cli("approve", "--index", "1", "--reply", "ok")
        self.assertEqual(code, 1)
        code, out, _ = self.run_cli("approve", "--index", "1", "--reply", "sim")
        self.assertEqual(code, 0)
        code, out, err = self.run_cli("place", "--index", "1")
        self.assertEqual(code, 0, err)
        t = self.state()[0]
        self.assertEqual(t["status"], "placed")
        oco = [q for m, p, q, _ in self.fake.calls if p == "/api/v3/orderList/oco"][0]
        self.assertEqual(oco["side"], "SELL")
        self.assertEqual(oco["aboveType"], "LIMIT_MAKER")
        self.assertEqual(oco["abovePrice"], "82050")
        self.assertEqual(oco["belowType"], "STOP_LOSS_LIMIT")
        self.assertEqual(oco["belowStopPrice"], "79850")
        self.assertEqual(oco["quantity"], t["qty"])
        code, _, err = self.run_cli("place", "--index", "1")
        self.assertEqual(code, 2, "never twice on one yes")
        self.assertEqual(len([1 for m, p in self.fake.paths() if p == "/api/v3/order"]), 1)

    def test_short_exit_buys_back(self):
        self.run_cli("plan", "--side", "sell", "--stop", "80950", "--take", "79250")
        self.run_cli("approve", "--index", "1", "--reply", "sim")
        code, _, err = self.run_cli("place", "--index", "1")
        self.assertEqual(code, 0, err)
        oco = [q for m, p, q, _ in self.fake.calls if p == "/api/v3/orderList/oco"][0]
        self.assertEqual((oco["side"], oco["aboveType"], oco["belowType"]),
                         ("BUY", "STOP_LOSS_LIMIT", "LIMIT_MAKER"))

    def test_price_already_past_the_stop(self):
        self.run_cli("plan", "--side", "buy", "--stop", "79850", "--take", "82050")
        self.run_cli("approve", "--index", "1", "--reply", "sim")
        self.fake.price = "79800"
        code, _, err = self.run_cli("place", "--index", "1")
        self.assertEqual(code, 2)
        self.assertIn("fora do plano", err)
        self.assertEqual(self.state()[0]["status"], "failed")

    def test_short_needs_btc(self):
        self.fake.btc = "0"
        self.run_cli("plan", "--side", "sell", "--stop", "80950", "--take", "79250")
        self.run_cli("approve", "--index", "1", "--reply", "sim")
        code, _, err = self.run_cli("place", "--index", "1")
        self.assertEqual(code, 2)
        self.assertIn("insuficiente", err)

    def test_failed_oco_says_unprotected_and_close_exits(self):
        self.fake.oco_fails = True
        self.run_cli("plan", "--side", "buy", "--stop", "79850", "--take", "82050")
        self.run_cli("approve", "--index", "1", "--reply", "sim")
        code, out, _ = self.run_cli("place", "--index", "1")
        self.assertEqual(code, 1)
        self.assertIn("SEM STOP", out)
        code, _, _ = self.run_cli("close", "--index", "1", "--reply", "pode")
        self.assertEqual(code, 1)
        code, out, err = self.run_cli("close", "--index", "1", "--reply", "sim")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.state()[0]["status"], "closed")
        sells = [q for m, p, q, _ in self.fake.calls if p == "/api/v3/order" and q.get("side") == "SELL"]
        self.assertEqual(len(sells), 1)

    def test_stale_yes_expires(self):
        self.run_cli("plan", "--side", "buy", "--stop", "79850", "--take", "82050")
        self.run_cli("approve", "--index", "1", "--reply", "sim")
        path = os.path.join(self.tmp, "state", "binance.json")
        with open(path) as fh:
            st = json.load(fh)
        st["tickets"][0]["approved_at"] = "2026-01-01T00:00:00+00:00"
        with open(path, "w") as fh:
            json.dump(st, fh)
        code, _, err = self.run_cli("place", "--index", "1")
        self.assertEqual(code, 2)
        self.assertEqual(self.state()[0]["status"], "expired")


if __name__ == "__main__":
    unittest.main()
