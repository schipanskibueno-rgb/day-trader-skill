#!/usr/bin/env python3
"""Binance Spot TESTNET orders for trader-broker. Standard library only.

Fake money only: every request goes to https://testnet.binance.vision. There
is no switch to the live exchange in this file.

  check     reads the account (read only): can it log in, can it trade,
            balances of BTC and USDT.
  price     the last price of a symbol.
  plan      builds a ticket: a market entry plus an OCO exit (stop-loss and
            take-profit that cancel each other). Rounds to the symbol's tick
            and step size, sizes it to max_loss_per_trade_usd when you give
            no --qty, and refuses a stop on the wrong side, a stop too tight,
            a trade over your max loss or under the minimum order.
  show      prints the tickets.
  approve   records your explicit yes ("sim" or "yes") for ONE ticket, word
            for word. "ok", "pode", "sim para todos" or a yes with a doubt in
            it do not count.
  place     sends an approved ticket: the market entry, then the OCO exit.
            Refuses when the yes is older than 30 minutes or the price has
            already passed the stop or the take.
  status    open orders and balances.
  close     cancels the symbol's open orders and exits the ticket at market.
            Needs its own yes.

    python3 binance.py check
    python3 binance.py plan --side buy --stop 79850 --take 82050
    python3 binance.py approve --index 1 --reply "sim"
    python3 binance.py place --index 1

Keys: BINANCE_API_KEY and BINANCE_SECRET_KEY in the environment, or a file
trader/binance_keys.json {"api_key": "...", "secret_key": "..."} on your own
device. Never paste them in a chat. Tickets live in trader/state/binance.json.
"""

import argparse
import datetime
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_UP

BASE_URL = "https://testnet.binance.vision"
RECV_WINDOW = 5000
FEE_RATE = Decimal("0.001")       # 0.1% a side, Binance's standard spot fee
STOP_SLIP = Decimal("0.003")      # the stop-loss limit sits 0.3% past the stop
MIN_RISK_PCT = Decimal("0.0005")  # a stop under 0.05% from the price is noise
APPROVAL_MINUTES = 30
DEFAULTS = {"max_loss_per_trade_usd": 50, "min_reward_risk": 1.0}

YES_WORDS = ("sim", "s", "yes", "y")
BATCH_WORDS = {"todos", "todas", "tudo", "ambos", "ambas", "all", "both", "every", "everything", "rest"}
DOUBT_WORDS = {"nao", "não", "no", "not", "espera", "espere", "esperar", "talvez", "mas", "se",
               "depois", "cancela", "cancelar", "wait", "but", "if", "maybe", "later", "cancel"}


class BinanceError(Exception):
    pass


# ---------------------------------------------------------------- numbers

def D(x):
    return Decimal(str(x))


def to_step(value, step, rounding):
    step = D(step)
    return (D(value) / step).to_integral_value(rounding=rounding) * step


def fmt(d):
    s = format(D(d).normalize(), "f")
    return s if s != "-0" else "0"


def usd(d):
    return "$%s" % "{:,.2f}".format(float(d))


# ---------------------------------------------------------------- client

def load_keys(path):
    key, secret = os.environ.get("BINANCE_API_KEY"), os.environ.get("BINANCE_SECRET_KEY")
    if key and secret:
        return key.strip(), secret.strip()
    if path and os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("api_key") and data.get("secret_key"):
            return data["api_key"].strip(), data["secret_key"].strip()
    raise BinanceError("sem chaves: defina BINANCE_API_KEY e BINANCE_SECRET_KEY, ou crie %s "
                       "com {\"api_key\": \"...\", \"secret_key\": \"...\"}" % path)


def sign(secret, query):
    return hmac.new(secret.encode(), query.encode(), hashlib.sha256).hexdigest()


class Client(object):
    def __init__(self, key=None, secret=None, opener=None):
        self.key, self.secret = key, secret
        self.opener = opener or self._urlopen
        self.offset_ms = None

    @staticmethod
    def _urlopen(method, url, headers):
        req = urllib.request.Request(url, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.status, resp.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    def request(self, method, path, params=None, signed=False):
        params = dict(params or {})
        headers = {"User-Agent": "trader-broker-binance-testnet"}
        if signed:
            if not (self.key and self.secret):
                raise BinanceError("esta chamada precisa das chaves da testnet")
            if self.offset_ms is None:
                server = self.request("GET", "/api/v3/time")["serverTime"]
                self.offset_ms = server - int(time.time() * 1000)
            params["recvWindow"] = RECV_WINDOW
            params["timestamp"] = int(time.time() * 1000) + self.offset_ms
            query = urllib.parse.urlencode(params)
            query += "&signature=" + sign(self.secret, query)
            headers["X-MBX-APIKEY"] = self.key
        else:
            query = urllib.parse.urlencode(params)
        url = BASE_URL + path + ("?" + query if query else "")
        status, body = self.opener(method, url, headers)
        try:
            data = json.loads(body) if body else {}
        except ValueError:
            raise BinanceError("resposta inesperada (%s): %s" % (status, body[:200]))
        if status >= 400 or (isinstance(data, dict) and "code" in data and data.get("code", 0) < 0):
            msg = data.get("msg", body[:200]) if isinstance(data, dict) else body[:200]
            if "restricted location" in str(msg):
                msg += " (a Binance bloqueia este local; rode do seu proprio aparelho)"
            raise BinanceError("Binance recusou (%s): %s" % (data.get("code", status)
                                                              if isinstance(data, dict) else status, msg))
        return data

    def price(self, symbol):
        return D(self.request("GET", "/api/v3/ticker/price", {"symbol": symbol})["price"])

    def symbol_info(self, symbol):
        data = self.request("GET", "/api/v3/exchangeInfo", {"symbol": symbol})
        info = data["symbols"][0]
        out = {"symbol": symbol, "base": info["baseAsset"], "quote": info["quoteAsset"],
               "tick": "0.01", "step": "0.00001", "min_qty": "0", "min_notional": "0",
               "oco": bool(info.get("ocoAllowed", True))}
        for f in info.get("filters", []):
            t = f.get("filterType")
            if t == "PRICE_FILTER":
                out["tick"] = f["tickSize"]
            elif t == "LOT_SIZE":
                out["step"], out["min_qty"] = f["stepSize"], f["minQty"]
            elif t in ("NOTIONAL", "MIN_NOTIONAL"):
                out["min_notional"] = f.get("minNotional", "0")
        return out

    def account(self):
        return self.request("GET", "/api/v3/account", {"omitZeroBalances": "true"}, signed=True)


def balances(account):
    return {b["asset"]: (D(b["free"]), D(b["locked"])) for b in account.get("balances", [])}


# ---------------------------------------------------------------- the plan

def build_plan(info, price, side, stop, take, qty=None, max_loss=50, min_rr=1.0):
    """Round, size and check a ticket. Raises BinanceError with the reason."""
    side = side.upper()
    if side not in ("BUY", "SELL"):
        raise BinanceError("--side tem que ser buy ou sell")
    price, tick, step = D(price), D(info["tick"]), D(info["step"])
    long_ = side == "BUY"
    # the stop rounds away from the price, the take toward it: never better than you asked
    stop = to_step(stop, tick, ROUND_FLOOR if long_ else ROUND_CEILING)
    take = to_step(take, tick, ROUND_FLOOR if long_ else ROUND_CEILING)
    if long_ and not stop < price < take:
        raise BinanceError("compra: o stop (%s) tem que ficar abaixo do preco (%s) e o take (%s) acima"
                           % (fmt(stop), fmt(price), fmt(take)))
    if not long_ and not take < price < stop:
        raise BinanceError("venda: o stop (%s) tem que ficar acima do preco (%s) e o take (%s) abaixo"
                           % (fmt(stop), fmt(price), fmt(take)))
    risk = abs(price - stop)
    if risk < price * MIN_RISK_PCT:
        raise BinanceError("stop apertado demais: %s do preco, o minimo e 0.05%%"
                           % ("%.3f%%" % float(risk / price * 100)))
    reward = abs(take - price)
    rr = reward / risk
    fee_unit = (price + stop) * FEE_RATE
    max_loss = D(max_loss)
    if qty is None:
        qty = to_step(max_loss / (risk + fee_unit), step, ROUND_FLOOR)
    else:
        qty = to_step(qty, step, ROUND_FLOOR)
    if qty <= 0 or qty < D(info["min_qty"]):
        raise BinanceError("quantidade %s abaixo do minimo do par (%s)" % (fmt(qty), info["min_qty"]))
    if qty * price < D(info["min_notional"]) or qty * take < D(info["min_notional"]) \
            or qty * stop < D(info["min_notional"]):
        raise BinanceError("ordem de %s abaixo do minimo de %s %s" % (usd(qty * price), info["min_notional"],
                                                                     info["quote"]))
    loss = qty * (risk + fee_unit)
    if loss > max_loss:
        raise BinanceError("perda maxima de %s passa do seu limite de %s por trade"
                           % (usd(loss), usd(max_loss)))
    if float(rr) < float(min_rr):
        raise BinanceError("risco:retorno %.2f abaixo do minimo %.2f" % (float(rr), float(min_rr)))
    slip = STOP_SLIP * (-1 if long_ else 1)
    stop_limit = to_step(stop * (1 + slip), tick, ROUND_FLOOR if long_ else ROUND_CEILING)
    plan = {"symbol": info["symbol"], "base": info["base"], "quote": info["quote"], "side": side,
            "qty": fmt(qty), "ref_price": fmt(price), "stop": fmt(stop), "stop_limit": fmt(stop_limit),
            "take": fmt(take), "risk_per_unit": fmt(risk), "reward_risk": round(float(rr), 2),
            "max_loss": fmt(loss.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
            "step": info["step"], "tick": info["tick"]}
    plan["fingerprint"] = fingerprint(plan)
    return plan


def fingerprint(plan):
    raw = "|".join(str(plan[k]) for k in ("symbol", "side", "qty", "stop", "stop_limit", "take"))
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def plain(t):
    verb = "COMPRA" if t["side"] == "BUY" else "VENDA"
    return ("%s %s %s a mercado (~%s) / stop %s (limite %s) / take %s / perda maxima ~%s no stop, "
            "com taxas (pode ser pior num mercado rapido)"
            % (verb, t["qty"], t["symbol"], t["ref_price"], t["stop"], t["stop_limit"], t["take"],
               usd(t["max_loss"])))


def render(t, idx):
    lines = ["TICKET %d  [%s]  TESTNET Binance (dinheiro ficticio)" % (idx, t["status"].upper()),
             "  " + plain(t),
             "  risco por unidade %s | risco:retorno %.2f" % (t["risk_per_unit"], t["reward_risk"])]
    if t.get("reply"):
        lines.append("  seu sim: \"%s\" em %s" % (t["reply"], t.get("approved_at", "")))
    if t.get("entry"):
        e = t["entry"]
        lines.append("  entrada: %s a %s (ordem %s)" % (e["qty"], e["avg_price"], e["order_id"]))
    if t.get("oco"):
        lines.append("  OCO de saida: lista %s" % t["oco"]["order_list_id"])
    if t.get("note"):
        lines.append("  nota: " + t["note"])
    return "\n".join(lines)


# ---------------------------------------------------------------- the yes

def parse_yes(reply, ticket):
    """Is this reply an explicit yes for THIS one ticket? Returns (ok, why)."""
    raw = (reply or "").strip()
    if not raw:
        return False, "a resposta esta vazia"
    if "?" in raw:
        return False, "a resposta e uma pergunta, nao um sim"
    words = re.findall(r"[a-zà-ÿ']+", raw.lower())
    if not words or words[0] not in YES_WORDS:
        return False, "so vale uma resposta que comeca com \"sim\" (nao vale ok, pode, manda, vai)"
    if BATCH_WORDS & set(words):
        return False, "um sim vale para um ticket so, nao para varios"
    if DOUBT_WORDS & set(words[1:]):
        return False, "a resposta tem uma condicao ou uma duvida; pergunte de novo"
    symbols = {w.upper() for w in words if w.endswith("usdt") and len(w) > 4}
    if symbols - {ticket["symbol"]}:
        return False, "a resposta fala de %s, mas este ticket e %s" % (
            ", ".join(sorted(symbols - {ticket["symbol"]})), ticket["symbol"])
    nums = [D(n.replace(",", ".")) for n in re.findall(r"\d+(?:[.,]\d+)?", raw)]
    want = [D(ticket[k]) for k in ("qty", "stop", "take")]
    for n in nums:
        if not any(n == w for w in want):
            return False, "a resposta diz %s, mas o ticket e %s" % (fmt(n), plain(ticket))
    return True, "sim explicito para " + plain(ticket)


# ---------------------------------------------------------------- state

def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()


def load_state(path):
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    return {"tickets": []}


def save_state(path, state):
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, path)


def load_config(folder):
    cfg = dict(DEFAULTS)
    path = os.path.join(folder, "config.json")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            cfg.update(json.load(fh))
    return cfg


def pick(state, index):
    tickets = state["tickets"]
    if not 1 <= index <= len(tickets):
        raise BinanceError("nao existe o ticket %d (ha %d)" % (index, len(tickets)))
    return tickets[index - 1]


def minutes_since(iso):
    then = datetime.datetime.fromisoformat(iso)
    return (datetime.datetime.now(datetime.timezone.utc) - then).total_seconds() / 60.0


# ---------------------------------------------------------------- orders

def entry_fill(resp, base):
    qty = D(resp.get("executedQty", "0"))
    quote = D(resp.get("cummulativeQuoteQty", "0"))
    fee_base = sum((D(f["commission"]) for f in resp.get("fills", []) if f.get("commissionAsset") == base),
                   Decimal("0"))
    avg = quote / qty if qty else Decimal("0")
    return qty, avg, fee_base


def oco_params(t, qty):
    """The exit: the opposite side, a LIMIT_MAKER at the take and a STOP_LOSS_LIMIT at the stop."""
    p = {"symbol": t["symbol"], "quantity": fmt(qty), "newOrderRespType": "RESULT"}
    stop = {"Type": "STOP_LOSS_LIMIT", "StopPrice": t["stop"], "Price": t["stop_limit"], "TimeInForce": "GTC"}
    take = {"Type": "LIMIT_MAKER", "Price": t["take"]}
    if t["side"] == "BUY":       # long: sell above at the take, sell below at the stop
        p["side"], above, below = "SELL", take, stop
    else:                        # short from your BTC: buy back above at the stop, below at the take
        p["side"], above, below = "BUY", stop, take
    for prefix, leg in (("above", above), ("below", below)):
        for k, v in leg.items():
            p[prefix + k] = v
    return p


def place(client, t):
    price = client.price(t["symbol"])
    stop, take = D(t["stop"]), D(t["take"])
    if t["side"] == "BUY" and not stop < price < take or t["side"] == "SELL" and not take < price < stop:
        raise BinanceError("o preco agora (%s) ja esta fora do plano (stop %s, take %s): faca um novo plan"
                           % (fmt(price), t["stop"], t["take"]))
    have = balances(client.account())
    qty = D(t["qty"])
    if t["side"] == "BUY":
        need = qty * price * (1 + FEE_RATE) * D("1.01")
        free = have.get(t["quote"], (Decimal("0"), 0))[0]
        if free < need:
            raise BinanceError("saldo de %s insuficiente: %s livre, precisa ~%s" % (t["quote"], fmt(free),
                                                                                   fmt(need.quantize(D("0.01")))))
    else:
        free = have.get(t["base"], (Decimal("0"), 0))[0]
        if free < qty:
            raise BinanceError("saldo de %s insuficiente: %s livre, a venda precisa de %s"
                               % (t["base"], fmt(free), t["qty"]))
    resp = client.request("POST", "/api/v3/order", {"symbol": t["symbol"], "side": t["side"],
                                                     "type": "MARKET", "quantity": t["qty"],
                                                     "newOrderRespType": "FULL"}, signed=True)
    filled, avg, fee_base = entry_fill(resp, t["base"])
    t["entry"] = {"order_id": resp.get("orderId"), "qty": fmt(filled),
                  "avg_price": fmt(avg.quantize(D(t["tick"]))), "at": now_iso()}
    t["status"] = "entered"
    if filled <= 0:
        t["status"], t["note"] = "failed", "a entrada nao executou"
        return t
    exit_qty = filled - fee_base if t["side"] == "BUY" else filled
    exit_qty = to_step(exit_qty, t["step"], ROUND_FLOOR)
    try:
        oco = client.request("POST", "/api/v3/orderList/oco", oco_params(t, exit_qty), signed=True)
    except BinanceError as e:
        t["status"] = "unprotected"
        t["note"] = "ENTROU MAS SEM STOP: %s. Rode close --index para sair." % e
        return t
    t["oco"] = {"order_list_id": oco.get("orderListId"), "qty": fmt(exit_qty), "at": now_iso()}
    t["status"] = "placed"
    return t


def close(client, t):
    try:
        client.request("DELETE", "/api/v3/openOrders", {"symbol": t["symbol"]}, signed=True)
    except BinanceError as e:
        if "-2011" not in str(e):   # -2011: nothing open to cancel
            raise
    have = balances(client.account())
    qty = D(t.get("oco", {}).get("qty") or t.get("entry", {}).get("qty") or "0")
    side = "SELL" if t["side"] == "BUY" else "BUY"
    if side == "SELL":
        qty = min(qty, have.get(t["base"], (Decimal("0"), 0))[0])
    qty = to_step(qty, t["step"], ROUND_FLOOR)
    if qty <= 0:
        t["status"], t["note"] = "closed", "nada para fechar (o stop ou o take ja executou?)"
        return t
    resp = client.request("POST", "/api/v3/order", {"symbol": t["symbol"], "side": side, "type": "MARKET",
                                                     "quantity": fmt(qty), "newOrderRespType": "FULL"},
                          signed=True)
    filled, avg, _ = entry_fill(resp, t["base"])
    t["exit"] = {"order_id": resp.get("orderId"), "qty": fmt(filled),
                 "avg_price": fmt(avg.quantize(D(t["tick"]))), "at": now_iso()}
    t["status"] = "closed"
    return t


# ---------------------------------------------------------------- commands

def make_client(a, signed):
    if signed:
        key, secret = load_keys(a.keys or os.path.join(a.dir, "binance_keys.json"))
        return Client(key, secret)
    return Client()


def cmd_check(a, client):
    acct = client.account()
    perms = acct.get("permissions") or []
    print("Conta TESTNET ok. Pode negociar: %s. Permissoes: %s"
          % ("sim" if acct.get("canTrade") else "NAO", ", ".join(perms) or "-"))
    have = balances(acct)
    for asset in ("BTC", "USDT"):
        free, locked = have.get(asset, (Decimal("0"), Decimal("0")))
        print("  %-5s livre %s  travado %s" % (asset, fmt(free), fmt(locked)))
    if len(have) > 2:
        print("  (+%d outros ativos de teste)" % (len(have) - len(set(have) & {"BTC", "USDT"})))
    return 0


def cmd_price(a, client):
    print("%s %s (testnet)" % (a.symbol, fmt(client.price(a.symbol))))
    return 0


def cmd_plan(a, client):
    cfg = load_config(a.dir)
    info = client.symbol_info(a.symbol)
    price = D(a.price) if a.price else client.price(a.symbol)
    plan = build_plan(info, price, a.side, a.stop, a.take, a.qty,
                      cfg.get("max_loss_per_trade_usd", 50), cfg.get("min_reward_risk", 1.0))
    plan.update({"status": "planned", "created_at": now_iso()})
    path = os.path.join(a.dir, "state", "binance.json")
    state = load_state(path)
    state["tickets"].append(plan)
    save_state(path, state)
    idx = len(state["tickets"])
    print(render(plan, idx))
    print("Colocar esta ordem na testnet? Responda sim ou nao, e depois rode:\n"
          "  python3 binance.py approve --index %d --reply \"sim\"" % idx)
    return 0


def cmd_show(a, client):
    state = load_state(os.path.join(a.dir, "state", "binance.json"))
    if not state["tickets"]:
        print("Nenhum ticket ainda. Rode plan.")
    for i, t in enumerate(state["tickets"], 1):
        print(render(t, i))
    return 0


def cmd_approve(a, client):
    path = os.path.join(a.dir, "state", "binance.json")
    state = load_state(path)
    t = pick(state, a.index)
    if t["status"] != "planned":
        raise BinanceError("o ticket %d esta %s; so um ticket planned pode ser aprovado" % (a.index, t["status"]))
    ok, why = parse_yes(a.reply, t)
    if not ok:
        print("Nao registrado: " + why)
        return 1
    t.update({"status": "approved", "reply": a.reply, "approved_at": now_iso(), "approved_fp": t["fingerprint"]})
    save_state(path, state)
    print("Registrado seu sim: " + why)
    print("Envie com: python3 binance.py place --index %d  (vale por %d minutos)" % (a.index, APPROVAL_MINUTES))
    return 0


def cmd_place(a, client):
    path = os.path.join(a.dir, "state", "binance.json")
    state = load_state(path)
    t = pick(state, a.index)
    if t["status"] != "approved":
        raise BinanceError("o ticket %d esta %s: precisa do seu sim (approve) antes" % (a.index, t["status"]))
    if t.get("approved_fp") != fingerprint(t):
        raise BinanceError("o ticket mudou depois do seu sim; faca um novo plan")
    if minutes_since(t["approved_at"]) > APPROVAL_MINUTES:
        t["status"], t["note"] = "expired", "o sim tinha mais de %d minutos" % APPROVAL_MINUTES
        save_state(path, state)
        raise BinanceError("o seu sim tem mais de %d minutos; faca um novo plan" % APPROVAL_MINUTES)
    t["status"] = "sending"   # saved first: a crash mid-send never sends the same ticket twice
    save_state(path, state)
    try:
        place(client, t)
    except BinanceError as e:
        if not t.get("entry"):
            t["status"], t["note"] = "failed", str(e)
        save_state(path, state)
        raise
    save_state(path, state)
    print(render(t, a.index))
    return 0 if t["status"] == "placed" else 1


def cmd_status(a, client):
    orders = client.request("GET", "/api/v3/openOrders", {"symbol": a.symbol}, signed=True)
    print("Ordens abertas em %s (testnet): %d" % (a.symbol, len(orders)))
    for o in orders:
        print("  %s %s %s %s preco %s stop %s" % (o["orderId"], o["side"], o["type"], o["origQty"],
                                                  o.get("price"), o.get("stopPrice")))
    return cmd_check(a, client)


def cmd_close(a, client):
    path = os.path.join(a.dir, "state", "binance.json")
    state = load_state(path)
    t = pick(state, a.index)
    if t["status"] not in ("placed", "entered", "unprotected"):
        raise BinanceError("o ticket %d esta %s; nao ha posicao aberta por ele" % (a.index, t["status"]))
    ok, why = parse_yes(a.reply, t)
    if not ok:
        print("Nao registrado: " + why)
        return 1
    t["close_reply"] = a.reply
    close(client, t)
    save_state(path, state)
    print(render(t, a.index))
    if t.get("exit"):
        print("  saida: %s a %s" % (t["exit"]["qty"], t["exit"]["avg_price"]))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Binance Spot TESTNET (dinheiro ficticio) para trader-broker.")
    ap.add_argument("--dir", default="trader", help="pasta do estado (padrao: trader)")
    ap.add_argument("--keys", help="arquivo de chaves (padrao: trader/binance_keys.json)")
    sub = ap.add_subparsers(dest="cmd")
    sub.required = True
    sub.add_parser("check")
    p = sub.add_parser("price")
    p.add_argument("--symbol", default="BTCUSDT")
    p = sub.add_parser("plan")
    p.add_argument("--symbol", default="BTCUSDT")
    p.add_argument("--side", required=True, help="buy ou sell")
    p.add_argument("--stop", required=True)
    p.add_argument("--take", required=True)
    p.add_argument("--qty", help="quantidade; sem ela, dimensiona pela sua perda maxima por trade")
    p.add_argument("--price", help="preco de referencia (padrao: o ultimo preco da testnet)")
    sub.add_parser("show")
    for name in ("approve", "close"):
        p = sub.add_parser(name)
        p.add_argument("--index", type=int, required=True)
        p.add_argument("--reply", required=True, help="a sua resposta, palavra por palavra")
    p = sub.add_parser("place")
    p.add_argument("--index", type=int, required=True)
    p = sub.add_parser("status")
    p.add_argument("--symbol", default="BTCUSDT")
    a = ap.parse_args(argv)
    signed = a.cmd in ("check", "place", "status", "close")
    try:
        if getattr(a, "symbol", None):
            a.symbol = a.symbol.upper()
        client = make_client(a, signed)
        return {"check": cmd_check, "price": cmd_price, "plan": cmd_plan, "show": cmd_show,
                "approve": cmd_approve, "place": cmd_place, "status": cmd_status,
                "close": cmd_close}[a.cmd](a, client)
    except BinanceError as e:
        print("Recusado: %s" % e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
