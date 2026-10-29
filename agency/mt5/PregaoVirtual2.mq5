//+------------------------------------------------------------------+
//|                                             PregaoVirtual2.mq5   |
//| Version 2 of the Pregao Virtual desk: the POI after a liquidity  |
//| sweep, the same rules as poiSetups() in agency/method.js.        |
//|  LIQUIDITY (M15): tops and bottoms (pivots, 3 candles each side) |
//|   that price has not traded through yet.                         |
//|  SWEEP (M5): a candle trades past one of them. If price keeps    |
//|   going more than 1.5 M15 ATR it is a breakdown, not a sweep.    |
//|  POI (M5): after the sweep price rises, pulls down breaking a    |
//|   small bottom of that rise but holding a higher bottom close to |
//|   the sweep (within 1 M15 ATR), then closes above the top the    |
//|   pull-down started from. Zone = the last down candle of the     |
//|   pull-down down to its bottom.                                  |
//|  ENTRY: limit order at the top of the zone for 24 M5 candles,    |
//|   stop below the pull-down, target 3R. Cancelled if price        |
//|   reaches the target first. Only with the H1 macro (flow of      |
//|   pivots and control of the last high volume agree).            |
//|  MANAGEMENT: fixed money stop per trade, target 3R (no early     |
//|   exit), at most 2 stops a day, then no new orders that day.     |
//| Sells are the mirror image. DEMO accounts only by default.       |
//+------------------------------------------------------------------+
#property copyright "Pregao Virtual"
#property version   "2.10"
#property description "Versao 2 da agencia Pregao Virtual: POI no M5 depois de limpar a liquidez do M15, alinhado ao macro H1. Stop fixo, alvo 3R, maximo de 2 stops por dia. So conta demo por padrao."

#include <Trade\Trade.mqh>

input double InpStopMoney    = 50.0;     // Stop por operacao (moeda da conta)
input double InpRR           = 3.0;      // Alvo em multiplos do risco
input int    InpMaxStopsDay  = 2;        // Stops por dia antes de fechar a mesa
input string InpSymbols      = "BTCUSD,XAUUSD"; // Ativos (separados por virgula)
input bool   InpAllowReal    = false;    // Permitir conta REAL (deixe false)
input long   InpMagic        = 28102026; // Numero magico das ordens
input bool   InpMacroFilter  = true;     // So operar a favor do macro H1
input int    InpHuntLife     = 36;       // Candles M5 para o POI confirmar depois da varrida
input double InpMaxRunAtr    = 1.5;      // Varrida maxima alem do nivel (ATR do M15)
input double InpNearAtr      = 1.0;      // Fundo mais alto perto da varrida (ATR do M15)
input int    InpEntryLife    = 24;       // Candles M5 que a ordem limitada espera
input double InpStopBuffer   = 0.1;      // Folga do stop alem da puxada (ATR do M5)
input double InpMinRiskAtr   = 0.3;      // Risco minimo (ATR do M5)
input double InpMaxRiskAtr   = 4.0;      // Risco maximo (ATR do M5)
input double InpMaxCostR     = 0.25;     // Spread maximo (fracao do risco)
input double InpClimaxVol    = 2.0;      // Volume que define o controle (x media, H1)
input double InpClimaxSpread = 1.2;      // Tamanho que define o controle (ATR, H1)
input bool   InpBridge       = true;     // Enviar o resumo da conta para a agencia (precisa liberar https://ntfy.sh)
input string InpBridgeTopic  = "pregao-virtual-a224d58b32c0"; // Canal da ponte com a agencia
input int    InpBridgeMinutes = 15;      // Enviar o resumo a cada (minutos)
input bool   InpWyckoffRange = true;     // Wyckoff so em lateralizacao: varredura na borda exige volume baixo (spring)
input int    InpRangeBars    = 32;       // Candles M15 da lateralizacao (8 horas)
input double InpRangeAtr     = 4.0;      // Altura maxima da lateralizacao (ATR do M15)
input double InpRangeDrift   = 0.5;      // Deslocamento maximo dentro da lateralizacao (fracao da altura)
input double InpRangeEdgeAtr = 0.5;      // Varredura perto da borda (ATR do M15)
input double InpSpringVol    = 1.0;      // Volume do spring menor que (x media)

#define ATR_N    14
#define VOL_N    20
#define HTF_K    3
#define LTF_K    2
#define M5_BARS  1500
#define M15_BARS 700
#define H1_BARS  400

CTrade   trade;
string   g_syms[];
bool     g_ok[];
datetime g_lastBar[];
string   g_status[];
datetime g_lastSend = 0;
bool     g_dirty = true;
string   g_bridge = "ponte com a agencia: aguardando o primeiro envio";

// a confirmed POI, in the buy direction (prices of the mirrored chart for sells)
struct Poi
  {
   double zoneHi;
   double stop;
   double plan;
   double level;
   double low;
  };

//------------------------------------------------------------------ helpers

void Atr(const MqlRates &r[], const int n, double &out[])
  {
   ArrayResize(out, n);
   ArrayInitialize(out, 0.0);
   double a = 0.0;
   for(int i = 0; i < n; i++)
     {
      double tr = r[i].high - r[i].low;
      if(i > 0)
         tr = MathMax(tr, MathMax(MathAbs(r[i].high - r[i - 1].close), MathAbs(r[i].low - r[i - 1].close)));
      if(i < ATR_N)
        {
         a += tr;
         if(i == ATR_N - 1) { a /= ATR_N; out[i] = a; }
        }
      else
        {
         a = (a * (ATR_N - 1) + tr) / ATR_N;
         out[i] = a;
        }
     }
  }

void VolSma(const MqlRates &r[], const int n, double &out[])
  {
   ArrayResize(out, n);
   ArrayInitialize(out, 0.0);
   double s = 0.0;
   for(int i = 0; i < n; i++)
     {
      s += (double)r[i].tick_volume;
      if(i >= VOL_N) s -= (double)r[i - VOL_N].tick_volume;
      if(i >= VOL_N - 1) out[i] = s / VOL_N;
     }
  }

// strict pivots: k candles on each side
void Pivots(const MqlRates &r[], const int n, const int k, bool &isHi[], bool &isLo[])
  {
   ArrayResize(isHi, n); ArrayResize(isLo, n);
   ArrayInitialize(isHi, false); ArrayInitialize(isLo, false);
   for(int i = k; i < n - k; i++)
     {
      bool h = true, l = true;
      for(int j = i - k; j <= i + k; j++)
        {
         if(j == i) continue;
         if(r[j].high >= r[i].high) h = false;
         if(r[j].low <= r[i].low) l = false;
        }
      isHi[i] = h; isLo[i] = l;
     }
  }

// the chart upside down: sells become buys
void Mirror(const MqlRates &src[], const int n, MqlRates &dst[])
  {
   ArrayResize(dst, n);
   for(int i = 0; i < n; i++)
     {
      dst[i] = src[i];
      dst[i].open = -src[i].open;
      dst[i].high = -src[i].low;
      dst[i].low = -src[i].high;
      dst[i].close = -src[i].close;
     }
  }

//------------------------------------------------------------------ macro (H1), as in version 1

int MacroBias(const string sym)
  {
   MqlRates h[];
   int n = CopyRates(sym, PERIOD_H1, 1, H1_BARS, h);
   if(n < 60) return 0;
   double a[], vs[];
   Atr(h, n, a);
   VolSma(h, n, vs);
   double hiP[], loP[];
   int hiKnown[], loKnown[];
   int nh = 0, nl = 0;
   ArrayResize(hiP, n); ArrayResize(loP, n); ArrayResize(hiKnown, n); ArrayResize(loKnown, n);
   for(int i = 3; i < n - 3; i++)
     {
      bool isH = true, isL = true;
      for(int j = i - 3; j <= i + 3; j++)
        {
         if(j == i) continue;
         if(h[j].high >= h[i].high) isH = false;
         if(h[j].low <= h[i].low) isL = false;
        }
      if(isH) { hiP[nh] = h[i].high; hiKnown[nh] = i + 3; nh++; }
      if(isL) { loP[nl] = h[i].low; loKnown[nl] = i + 3; nl++; }
     }
   int flow = 0, ctrlDir = 0, kh = 0, kl = 0;
   double ctrlLevel = 0.0;
   for(int k = 0; k < n; k++)
     {
      while(kh < nh && hiKnown[kh] <= k) kh++;
      while(kl < nl && loKnown[kl] <= k) kl++;
      if(kh >= 2 && kl >= 2)
        {
         if(hiP[kh - 1] > hiP[kh - 2] && loP[kl - 1] > loP[kl - 2]) flow = 1;
         else if(hiP[kh - 1] < hiP[kh - 2] && loP[kl - 1] < loP[kl - 2]) flow = -1;
        }
      if(flow < 0 && kh >= 1 && h[k].close > hiP[kh - 1]) flow = 1;
      else if(flow > 0 && kl >= 1 && h[k].close < loP[kl - 1]) flow = -1;
      if(a[k] > 0 && vs[k] > 0 && (double)h[k].tick_volume >= InpClimaxVol * vs[k] && h[k].high - h[k].low >= InpClimaxSpread * a[k])
        {
         ctrlDir = (h[k].close >= h[k].open) ? 1 : -1;
         ctrlLevel = (ctrlDir > 0) ? h[k].low : h[k].high;
        }
      if(ctrlDir != 0 && ((ctrlDir > 0 && h[k].close < ctrlLevel) || (ctrlDir < 0 && h[k].close > ctrlLevel)))
         ctrlDir = -ctrlDir;
     }
   if(ctrlDir != 0 && ctrlDir != flow) return 0;
   return flow;
  }

//------------------------------------------------------------------ Wyckoff, kept in reserve

// a sideways structure on the M15 candles ending at q: narrow and going nowhere; fills its bottom
bool TradingRange(const MqlRates &h[], const double &ha[], const int q, double &lo)
  {
   if(q < InpRangeBars || ha[q] <= 0) return false;
   double hi = -DBL_MAX;
   lo = DBL_MAX;
   for(int k = q - InpRangeBars + 1; k <= q; k++) { hi = MathMax(hi, h[k].high); lo = MathMin(lo, h[k].low); }
   double height = hi - lo, drift = MathAbs(h[q].close - h[q - InpRangeBars + 1].open);
   return height <= InpRangeAtr * ha[q] && drift <= InpRangeDrift * height;
  }

//------------------------------------------------------------------ the POI (buy side)

// follows one sweep at M5 candle s; true only when the POI confirms exactly at the last closed candle
bool Hunt(const MqlRates &b[], const int n, const double &a[], const bool &pHi[], const bool &pLo[],
          const int s, const double lvl, const double hA, Poi &out)
  {
   int last = n - 1;
   double ext = b[s].low;
   int extIdx = s;
   for(int j = s + 1; j < n && j <= s + InpHuntLife; j++)
     {
      if(b[j].low < ext) { ext = b[j].low; extIdx = j; }
      if(ext < lvl - InpMaxRunAtr * hA) return false;                 // not a sweep: price kept going
      // the last bottom of the trigger chart known at j, after the sweep low
      int pl = -1;
      for(int i = j - LTF_K; i > extIdx && pl < 0; i--) if(pLo[i]) pl = i;
      if(pl < 0) continue;
      if(b[pl].low <= ext || b[pl].low - ext > InpNearAtr * hA) continue;
      int ph = -1;
      for(int i = pl - 1; i > extIdx && ph < 0; i--) if(pHi[i]) ph = i;
      if(ph < 0) continue;
      int minor = -1;
      for(int i = ph - 1; i > extIdx && minor < 0; i--) if(pLo[i]) minor = i;
      if(minor < 0 || b[pl].low >= b[minor].low) continue;            // the pull-down broke a small bottom
      if(b[j].close <= b[ph].high) continue;                          // not confirmed yet
      if(j != last) return false;                                     // confirmed earlier: already handled
      int ob = -1;
      for(int k = pl; k >= ph && ob < 0; k--) if(b[k].close < b[k].open) ob = k;
      out.zoneHi = (ob >= 0) ? MathMax(b[ob].open, b[pl].close) : b[pl].high;
      out.stop = b[pl].low - InpStopBuffer * a[j];
      out.plan = out.zoneHi - out.stop;
      out.level = lvl;
      out.low = ext;
      if(out.plan <= 0 || out.plan < InpMinRiskAtr * a[j] || out.plan > InpMaxRiskAtr * a[j]) return false;
      return true;
     }
   return false;
  }

// scans the recent sweeps of one chart (buy side) for a POI that confirms on the last closed candle
bool FindPoi(const MqlRates &b[], const int n, const MqlRates &h[], const int nh, Poi &out, int &sweeps)
  {
   sweeps = 0;
   if(n < 200 || nh < 60) return false;
   double a[], ha[], vs[];
   Atr(b, n, a);
   Atr(h, nh, ha);
   VolSma(b, n, vs);
   bool pHi[], pLo[], hHi[], hLo[];
   Pivots(b, n, LTF_K, pHi, pLo);
   Pivots(h, nh, HTF_K, hHi, hLo);
   int htfSec = PeriodSeconds(PERIOD_M15), baseSec = PeriodSeconds(PERIOD_M5);
   // liquidity: M15 bottoms, available once the candle that confirms them has closed
   double lp[];
   datetime from[];
   bool alive[];
   int nl = 0;
   ArrayResize(lp, nh); ArrayResize(from, nh); ArrayResize(alive, nh);
   for(int i = 0; i < nh - HTF_K; i++)
     {
      if(!hLo[i]) continue;
      int known = i + HTF_K;
      lp[nl] = h[i].low;
      from[nl] = h[known].time + htfSec;
      alive[nl] = true;
      // traded through before the M5 window starts
      for(int k = known + 1; k < nh && h[k].time + htfSec <= b[0].time && alive[nl]; k++)
         if(h[k].low < lp[nl]) alive[nl] = false;
      nl++;
     }
   int last = n - 1, q = -1;
   for(int i = 1; i < n; i++)
     {
      int qPrev = q;                                                   // M15 candles closed before this M5 candle
      while(q + 1 < nh && h[q + 1].time + htfSec <= b[i].time + baseSec) q++;
      double lvl = DBL_MAX;
      bool swept = false;
      for(int z = 0; z < nl; z++)
        {
         if(!alive[z] || from[z] > b[i].time) continue;
         if(b[i].low < lp[z]) { alive[z] = false; swept = true; lvl = MathMin(lvl, lp[z]); }
        }
      if(!swept || i < last - InpHuntLife || q < ATR_N - 1) continue;
      // Wyckoff only at the bottom edge of a sideways structure: the sweep must be a spring (low volume)
      double rlo;
      if(InpWyckoffRange && vs[i - 1] > 0 && b[i].tick_volume > 0 && qPrev >= 0 && TradingRange(h, ha, qPrev, rlo) &&
         lvl - rlo <= InpRangeEdgeAtr * ha[qPrev] && (double)b[i].tick_volume >= InpSpringVol * vs[i - 1]) continue;
      sweeps++;
      if(Hunt(b, n, a, pHi, pLo, i, lvl, ha[q], out)) return true;
     }
   return false;
  }

//------------------------------------------------------------------ the desk

datetime DayStart()
  {
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   dt.hour = 0; dt.min = 0; dt.sec = 0;
   return StructToTime(dt);
  }

double DealResult(const ulong d)
  {
   return HistoryDealGetDouble(d, DEAL_PROFIT) + HistoryDealGetDouble(d, DEAL_SWAP) + HistoryDealGetDouble(d, DEAL_COMMISSION);
  }

int StopsToday()
  {
   if(!HistorySelect(DayStart(), TimeCurrent() + 60)) return 0;
   int c = 0;
   for(int k = HistoryDealsTotal() - 1; k >= 0; k--)
     {
      ulong d = HistoryDealGetTicket(k);
      if(HistoryDealGetInteger(d, DEAL_MAGIC) != InpMagic) continue;
      if(HistoryDealGetInteger(d, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;
      if(DealResult(d) < 0) c++;
     }
   return c;
  }

string Blocks()
  {
   if(!HistorySelect(0, TimeCurrent() + 60)) return "";
   int n = 0, wins = 0, bn = 0, bw = 0;
   double sum = 0, bsum = 0;
   for(int k = 0; k < HistoryDealsTotal(); k++)
     {
      ulong d = HistoryDealGetTicket(k);
      if(HistoryDealGetInteger(d, DEAL_MAGIC) != InpMagic) continue;
      if(HistoryDealGetInteger(d, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;
      double p = DealResult(d);
      n++; sum += p; if(p > 0) wins++;
      if(bn == 25) { bn = 0; bw = 0; bsum = 0; }
      bn++; bsum += p; if(p > 0) bw++;
     }
   return StringFormat("Trades: %d (%d ganhos) %s | Bloco atual de 25: %d/%d %s",
                       n, wins, DoubleToString(sum, 2), bw, bn, DoubleToString(bsum, 2));
  }

bool HasPosition(const string sym)
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(PositionGetSymbol(i) != sym) continue;
      if(PositionGetInteger(POSITION_MAGIC) == InpMagic) return true;
     }
   return false;
  }

bool HasOrder(const string sym)
  {
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong t = OrderGetTicket(i);
      if(t == 0) continue;
      if(OrderGetString(ORDER_SYMBOL) == sym && OrderGetInteger(ORDER_MAGIC) == InpMagic) return true;
     }
   return false;
  }

// pending orders: gone after InpEntryLife candles, when the desk closes, or when price reaches the target first
void ManageOrders(const bool deskOpen)
  {
   int life = InpEntryLife * PeriodSeconds(PERIOD_M5);
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong t = OrderGetTicket(i);
      if(t == 0 || OrderGetInteger(ORDER_MAGIC) != InpMagic) continue;
      string sym = OrderGetString(ORDER_SYMBOL);
      long type = OrderGetInteger(ORDER_TYPE);
      double tp = OrderGetDouble(ORDER_TP);
      datetime setup = (datetime)OrderGetInteger(ORDER_TIME_SETUP);
      MqlTick tk;
      bool ranAway = false;
      if(SymbolInfoTick(sym, tk))
         ranAway = (type == ORDER_TYPE_BUY_LIMIT && tk.bid >= tp) || (type == ORDER_TYPE_SELL_LIMIT && tk.ask <= tp);
      string why = !deskOpen ? "mesa fechada" : ranAway ? "preco foi ao alvo sem pegar a ordem" :
                   (TimeCurrent() - setup > life) ? "ordem venceu" : "";
      if(why == "") continue;
      if(trade.OrderDelete(t)) Print(sym, ": ordem limitada cancelada (", why, ")");
     }
  }

// lots so that the stop costs InpStopMoney; 0 if the minimum lot would cost more
double LotsFor(const string sym, const double riskPrice)
  {
   double tickSize = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tickValue <= 0) tickValue = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   if(tickSize <= 0 || tickValue <= 0 || riskPrice <= 0) return 0;
   double lossPerLot = riskPrice / tickSize * tickValue;
   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   double minLot = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double lots = InpStopMoney / lossPerLot;
   if(step > 0) lots = MathFloor(lots / step) * step;
   if(lots < minLot) return 0;
   return MathMin(lots, maxLot);
  }

// places the order for a POI in direction d (prices already back on the real chart)
void Place(const int s, const int d, const double zone, const double stop, const string why)
  {
   string sym = g_syms[s];
   MqlTick tk;
   if(!SymbolInfoTick(sym, tk)) return;
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double minDist = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * point;
   double now = (d > 0) ? tk.ask : tk.bid;
   bool atMarket = (d > 0) ? now <= zone : now >= zone;               // price is already inside the zone
   double entry = atMarket ? now : zone;
   double risk = d * (entry - stop);
   if(risk <= 0) { g_status[s] = sym + ": preco ja passou do stop do POI"; return; }
   if(tk.ask - tk.bid > InpMaxCostR * risk) { g_status[s] = sym + ": spread caro demais para o risco"; return; }
   if(risk <= minDist || (!atMarket && MathAbs(now - entry) <= minDist)) { g_status[s] = sym + ": distancia menor que o minimo da corretora"; return; }
   double lots = LotsFor(sym, risk);
   if(lots <= 0) { g_status[s] = sym + ": lote minimo arriscaria mais que o stop definido"; return; }
   double sl = NormalizeDouble(stop, digits), tp = NormalizeDouble(entry + d * InpRR * risk, digits), px = NormalizeDouble(entry, digits);
   string comment = "PregaoVirtual2 POI 3R";
   trade.SetTypeFillingBySymbol(sym);
   bool ok;
   if(atMarket) ok = (d > 0) ? trade.Buy(lots, sym, 0, sl, tp, comment) : trade.Sell(lots, sym, 0, sl, tp, comment);
   else ok = (d > 0) ? trade.BuyLimit(lots, px, sym, sl, tp, ORDER_TIME_GTC, 0, comment)
                     : trade.SellLimit(lots, px, sym, sl, tp, ORDER_TIME_GTC, 0, comment);
   ok = ok && (trade.ResultRetcode() == TRADE_RETCODE_DONE || trade.ResultRetcode() == TRADE_RETCODE_PLACED);
   g_status[s] = sym + ": " + (ok ? (d > 0 ? "COMPRA " : "VENDA ") + (atMarket ? "a mercado " : "limitada em " + DoubleToString(px, digits) + " ") +
                 DoubleToString(lots, 2) + " lotes, stop " + DoubleToString(sl, digits) + ", alvo " + DoubleToString(tp, digits) + "; " + why
                 : "ordem recusada: " + trade.ResultRetcodeDescription());
   Print(g_status[s]);
  }

void Evaluate(const int s, const bool deskOpen)
  {
   string sym = g_syms[s];
   int bias = InpMacroFilter ? MacroBias(sym) : 0;
   string macro = InpMacroFilter ? "macro H1 " + (bias > 0 ? "de alta" : bias < 0 ? "de baixa" : "sem clareza") : "sem filtro macro";
   if(InpMacroFilter && bias == 0) { g_status[s] = sym + ": " + macro + ", so observando"; return; }
   MqlRates b[], h[], mb[], mh[];
   int n = CopyRates(sym, PERIOD_M5, 1, M5_BARS, b);
   int nh = CopyRates(sym, PERIOD_M15, 1, M15_BARS, h);
   if(n < 200 || nh < 60) { g_status[s] = sym + ": carregando historico"; return; }
   int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   int sweeps = 0;
   Poi p;
   for(int d = 1; d >= -1; d -= 2)
     {
      if(InpMacroFilter && bias != d) continue;
      bool found;
      if(d > 0) found = FindPoi(b, n, h, nh, p, sweeps);
      else { Mirror(b, n, mb); Mirror(h, nh, mh); found = FindPoi(mb, n, mh, nh, p, sweeps); }
      if(!found) continue;
      double zone = d * p.zoneHi, stop = d * p.stop;
      string why = StringFormat("limpou a liquidez de %s e confirmou o POI", DoubleToString(d * p.level, dg));
      if(!deskOpen) { g_status[s] = sym + ": POI ignorado, mesa fechada (2 stops hoje)"; return; }
      if(HasPosition(sym) || HasOrder(sym)) { g_status[s] = sym + ": POI ignorado, ja posicionado"; return; }
      Place(s, d, zone, stop, why);
      return;
     }
   if(HasPosition(sym)) g_status[s] = sym + ": posicionado (stop e alvo 3R na corretora)";
   else if(HasOrder(sym)) g_status[s] = sym + ": ordem limitada aguardando o preco voltar a zona";
   else g_status[s] = sym + ": " + macro + StringFormat(", %d varrida(s) recente(s), aguardando POI", sweeps);
  }

//------------------------------------------------------------------ the bridge to the agency
// A short JSON summary of this robot's account goes to an ntfy.sh channel; the agency's
// reading every 3 hours picks it up. Nothing comes back: the agency never sends orders.

string Js(const string s)
  {
   string r = s;
   StringReplace(r, "\\", "\\\\");
   StringReplace(r, "\"", "\\\"");
   StringReplace(r, "\n", " ");
   if(StringLen(r) > 140) r = StringSubstr(r, 0, 140);
   return "\"" + r + "\"";
  }

string Snapshot(const int stops, const bool deskOpen)
  {
   long off = (long)MathRound(((double)TimeTradeServer() - (double)TimeGMT()) / 1800.0) * 1800;   // server time -> UTC
   string j = "{\"v\":1,\"acc\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) +
              ",\"srv\":" + Js(AccountInfoString(ACCOUNT_SERVER)) +
              ",\"demo\":" + (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO ? "true" : "false") +
              ",\"t\":" + IntegerToString((long)TimeGMT()) +
              ",\"cur\":" + Js(AccountInfoString(ACCOUNT_CURRENCY)) +
              ",\"bal\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) +
              ",\"eq\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) +
              ",\"stops\":" + IntegerToString(stops) + ",\"open\":" + (deskOpen ? "true" : "false") +
              ",\"stop\":" + DoubleToString(InpStopMoney, 2) +
              ",\"algo\":" + (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) ? "true" : "false");
   string a = "";
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      string sym = PositionGetSymbol(i);
      if(sym == "" || PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      a += (a == "" ? "" : ",") + "{\"s\":" + Js(sym) + ",\"d\":" + (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "1" : "-1") +
           ",\"lot\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + ",\"p\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), dg) +
           ",\"sl\":" + DoubleToString(PositionGetDouble(POSITION_SL), dg) + ",\"tp\":" + DoubleToString(PositionGetDouble(POSITION_TP), dg) +
           ",\"pl\":" + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2) + ",\"t\":" + IntegerToString((long)PositionGetInteger(POSITION_TIME) - off) + "}";
     }
   j += ",\"pos\":[" + a + "]";
   a = "";
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong tk = OrderGetTicket(i);
      if(tk == 0 || OrderGetInteger(ORDER_MAGIC) != InpMagic) continue;
      string sym = OrderGetString(ORDER_SYMBOL);
      int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      long type = OrderGetInteger(ORDER_TYPE);
      a += (a == "" ? "" : ",") + "{\"s\":" + Js(sym) + ",\"d\":" + (type == ORDER_TYPE_BUY_LIMIT || type == ORDER_TYPE_BUY_STOP ? "1" : "-1") +
           ",\"lot\":" + DoubleToString(OrderGetDouble(ORDER_VOLUME_CURRENT), 2) + ",\"p\":" + DoubleToString(OrderGetDouble(ORDER_PRICE_OPEN), dg) +
           ",\"sl\":" + DoubleToString(OrderGetDouble(ORDER_SL), dg) + ",\"tp\":" + DoubleToString(OrderGetDouble(ORDER_TP), dg) +
           ",\"t\":" + IntegerToString((long)OrderGetInteger(ORDER_TIME_SETUP) - off) + "}";
     }
   j += ",\"ord\":[" + a + "]";
   // closed trades of this robot: totals and the last 10
   int n = 0, wins = 0, shown = 0;
   double sum = 0;
   a = "";
   if(HistorySelect(0, TimeCurrent() + 60))
      for(int k = HistoryDealsTotal() - 1; k >= 0; k--)
        {
         ulong d = HistoryDealGetTicket(k);
         if(HistoryDealGetInteger(d, DEAL_MAGIC) != InpMagic || HistoryDealGetInteger(d, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;
         double pl = DealResult(d);
         n++; sum += pl; if(pl > 0) wins++;
         if(shown >= 10) continue;
         shown++;
         string sym = HistoryDealGetString(d, DEAL_SYMBOL);
         int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
         // the deal that closes a buy is a sell: report the direction of the trade
         a += (a == "" ? "" : ",") + "{\"s\":" + Js(sym) + ",\"d\":" + (HistoryDealGetInteger(d, DEAL_TYPE) == DEAL_TYPE_SELL ? "1" : "-1") +
              ",\"lot\":" + DoubleToString(HistoryDealGetDouble(d, DEAL_VOLUME), 2) + ",\"p\":" + DoubleToString(HistoryDealGetDouble(d, DEAL_PRICE), dg) +
              ",\"pl\":" + DoubleToString(pl, 2) + ",\"t\":" + IntegerToString((long)HistoryDealGetInteger(d, DEAL_TIME) - off) + "}";
        }
   j += ",\"deals\":[" + a + "],\"n\":" + IntegerToString(n) + ",\"w\":" + IntegerToString(wins) + ",\"sum\":" + DoubleToString(sum, 2);
   a = "";
   for(int s = 0; s < ArraySize(g_status); s++) a += (a == "" ? "" : ",") + Js(g_status[s]);
   j += ",\"st\":[" + a + "]}";
   return j;
  }

// sends the summary every InpBridgeMinutes, and on the next timer after any trade
void Bridge(const int stops, const bool deskOpen)
  {
   if(!InpBridge || InpBridgeTopic == "") return;
   if(!g_dirty && TimeLocal() - g_lastSend < InpBridgeMinutes * 60) return;
   if(g_dirty && g_lastSend > 0 && TimeLocal() - g_lastSend < 30) return;          // at most one send every 30 s
   string json = Snapshot(stops, deskOpen);
   char data[], res[];
   string resHeaders;
   int len = StringToCharArray(json, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(len > 0) ArrayResize(data, len - 1);                                         // drop the trailing zero
   ResetLastError();
   int code = WebRequest("POST", "https://ntfy.sh/" + InpBridgeTopic, "Content-Type: application/json\r\n", 5000, data, res, resHeaders);
   int err = GetLastError();
   g_lastSend = TimeLocal();
   g_dirty = false;                                                               // a failure waits for the next interval
   if(code == 200) g_bridge = "ponte com a agencia: resumo enviado as " + TimeToString(TimeLocal(), TIME_MINUTES);
   else if(err == 4014) g_bridge = "ponte com a agencia DESLIGADA: libere https://ntfy.sh em Ferramentas > Opcoes > Expert Advisors";
   else g_bridge = StringFormat("ponte com a agencia: envio falhou (codigo %d, erro %d), tenta de novo em %d min", code, err, InpBridgeMinutes);
  }

//------------------------------------------------------------------ events

int OnInit()
  {
   if(!InpAllowReal && AccountInfoInteger(ACCOUNT_TRADE_MODE) != ACCOUNT_TRADE_MODE_DEMO)
     {
      Alert("Pregao Virtual 2: esta conta NAO e demo. O robo so opera em conta demo (InpAllowReal = false).");
      return INIT_FAILED;
     }
   int n = StringSplit(InpSymbols, ',', g_syms);
   if(n <= 0) return INIT_PARAMETERS_INCORRECT;
   ArrayResize(g_ok, n); ArrayResize(g_lastBar, n); ArrayResize(g_status, n);
   for(int i = 0; i < n; i++)
     {
      StringTrimLeft(g_syms[i]);
      StringTrimRight(g_syms[i]);
      g_ok[i] = SymbolSelect(g_syms[i], true);
      g_lastBar[i] = 0;
      g_status[i] = g_syms[i] + (g_ok[i] ? ": aguardando o proximo candle de 5m" : ": ativo nao existe nesta corretora");
     }
   trade.SetExpertMagicNumber((ulong)InpMagic);
   trade.SetDeviationInPoints(30);
   EventSetTimer(10);
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   Comment("");
  }

void OnTick() { }

void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
  {
   g_dirty = true;                                                               // something changed: tell the agency
  }

void OnTimer()
  {
   int stops = StopsToday();
   bool deskOpen = stops < InpMaxStopsDay;
   ManageOrders(deskOpen);
   for(int s = 0; s < ArraySize(g_syms); s++)
     {
      if(!g_ok[s]) continue;
      datetime t[];
      if(CopyTime(g_syms[s], PERIOD_M5, 1, 1, t) != 1) continue;
      if(t[0] == g_lastBar[s]) continue;                                 // once per closed 5m candle
      g_lastBar[s] = t[0];
      Evaluate(s, deskOpen);
     }
   string txt = "PREGAO VIRTUAL 2 (POI)  |  " + (deskOpen ? "MESA ABERTA" : "MESA FECHADA: volta no proximo dia do servidor") +
                StringFormat("  |  stops hoje %d/%d  |  stop %s, alvo %.0fR", stops, InpMaxStopsDay, DoubleToString(InpStopMoney, 2), InpRR) +
                "\n" + Blocks() + "\n";
   for(int s = 0; s < ArraySize(g_syms); s++) txt += g_status[s] + "\n";
   Bridge(stops, deskOpen);
   if(InpBridge) txt += g_bridge + "\n";
   Comment(txt);
  }
//+------------------------------------------------------------------+
