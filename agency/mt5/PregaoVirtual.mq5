//+------------------------------------------------------------------+
//|                                              PregaoVirtual.mq5   |
//| The Pregao Virtual desk's method as an Expert Advisor for MT5.   |
//| Same rules as agency/method.js:                                  |
//|  MACRO (H1): flow of pivots (higher/lower highs and lows), CHoCH |
//|   when the last pivot breaks against the flow, and "control" of  |
//|   the last wide high-volume candle. Trades only when flow and    |
//|   control agree.                                                 |
//|  MICRO (M15): a 16-candle range left by a wide, high-volume      |
//|   candle becomes a region of interest, marked by its volume      |
//|   profile (POC, VAL, VAH). Entry on the return to the region     |
//|   with less volume than the impulse and an absorption candle     |
//|   closing beyond the open of the last candle against the trade.  |
//|  MANAGEMENT: fixed money stop per trade, target 3R (no early     |
//|   exit), at most 2 stops a day, then no new trades that day.     |
//| Runs on DEMO accounts only unless InpAllowReal is set to true.   |
//| Volume here is the broker's tick volume.                         |
//+------------------------------------------------------------------+
#property copyright "Pregao Virtual"
#property version   "1.01"
#property description "Metodo da agencia Pregao Virtual: regioes de interesse, preco e volume, stop fixo, alvo 3R, maximo de 2 stops por dia. So conta demo por padrao."

#include <Trade\Trade.mqh>

input double InpStopMoney    = 80.0;     // Stop por operacao (moeda da conta)
input double InpRR           = 3.0;      // Alvo em multiplos do risco
input int    InpMaxStopsDay  = 2;        // Stops por dia antes de fechar a mesa
input string InpSymbols      = "XAUUSD,EURUSD,GBPUSD,USDJPY,AUDUSD,BTCUSD"; // Ativos (separados por virgula)
input bool   InpAllowReal    = false;    // Permitir conta REAL (deixe false)
input long   InpMagic        = 27102026; // Numero magico das ordens
input int    InpBoxBars      = 16;       // Candles da lateralizacao
input double InpBoxAtr       = 2.5;      // Altura maxima da lateralizacao (ATR)
input double InpBreakVol     = 1.5;      // Volume do desequilibrio (x media)
input double InpBreakSpread  = 1.2;      // Tamanho do desequilibrio (ATR)
input int    InpBins         = 24;       // Faixas do volume profile
input double InpValueArea    = 0.70;     // Zona de valor (fracao do volume)
input double InpTestVol      = 0.80;     // Volume do recuo menor que (x impulso)
input int    InpZoneLife     = 96;       // Validade da regiao (candles M15)
input double InpStopBuffer   = 0.2;      // Folga do stop alem da regiao (ATR)
input double InpMinRiskAtr   = 0.3;      // Risco minimo (ATR)
input double InpMaxRiskAtr   = 4.0;      // Risco maximo (ATR)
input double InpMaxCostR     = 0.25;     // Spread maximo (fracao do risco)
input double InpClimaxVol    = 2.0;      // Volume que define o controle (x media, H1)
input double InpClimaxSpread = 1.2;      // Tamanho que define o controle (ATR, H1)

#define ATR_N   14
#define VOL_N   20
#define PIVOT_K 3
#define M15_BARS 420
#define H1_BARS  400

CTrade   trade;
string   g_syms[];
bool     g_ok[];
datetime g_lastBar[];
string   g_status[];

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

//------------------------------------------------------------------ macro (H1)

// flow (1 up, -1 down, 0 none), control direction and the bias after the last closed H1 candle
int MacroBias(const string sym, int &flowOut, int &controlOut)
  {
   MqlRates h[];
   int n = CopyRates(sym, PERIOD_H1, 1, H1_BARS, h);
   flowOut = 0; controlOut = 0;
   if(n < 60) return 0;
   double a[], vs[];
   Atr(h, n, a);
   VolSma(h, n, vs);
   // pivots, known PIVOT_K candles after they print
   double hiP[], loP[];
   int hiKnown[], loKnown[];
   int nh = 0, nl = 0;
   ArrayResize(hiP, n); ArrayResize(loP, n); ArrayResize(hiKnown, n); ArrayResize(loKnown, n);
   for(int i = PIVOT_K; i < n - PIVOT_K; i++)
     {
      bool isH = true, isL = true;
      for(int j = i - PIVOT_K; j <= i + PIVOT_K; j++)
        {
         if(j == i) continue;
         if(h[j].high >= h[i].high) isH = false;
         if(h[j].low <= h[i].low) isL = false;
        }
      if(isH) { hiP[nh] = h[i].high; hiKnown[nh] = i + PIVOT_K; nh++; }
      if(isL) { loP[nl] = h[i].low; loKnown[nl] = i + PIVOT_K; nl++; }
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
      if(flow < 0 && kh >= 1 && h[k].close > hiP[kh - 1]) flow = 1;        // CHoCH up
      else if(flow > 0 && kl >= 1 && h[k].close < loP[kl - 1]) flow = -1;  // CHoCH down
      if(a[k] > 0 && vs[k] > 0 && (double)h[k].tick_volume >= InpClimaxVol * vs[k] && h[k].high - h[k].low >= InpClimaxSpread * a[k])
        {
         ctrlDir = (h[k].close >= h[k].open) ? 1 : -1;
         ctrlLevel = (ctrlDir > 0) ? h[k].low : h[k].high;
        }
      if(ctrlDir != 0 && ((ctrlDir > 0 && h[k].close < ctrlLevel) || (ctrlDir < 0 && h[k].close > ctrlLevel)))
         ctrlDir = -ctrlDir;                                                // control lost: it changes hands
     }
   flowOut = flow;
   controlOut = ctrlDir;
   if(ctrlDir != 0 && ctrlDir != flow) return 0;                          // no clarity
   return flow;
  }

//------------------------------------------------------------------ micro (M15)

void Profile(const MqlRates &r[], const int from, const int to, double &poc, double &val, double &vah)
  {
   double lo = DBL_MAX, hi = -DBL_MAX;
   for(int i = from; i <= to; i++) { lo = MathMin(lo, r[i].low); hi = MathMax(hi, r[i].high); }
   int nb = InpBins;
   double step = (hi - lo) / nb;
   if(step <= 0) step = 1e-9;
   double vol[];
   ArrayResize(vol, nb);
   ArrayInitialize(vol, 0.0);
   double total = 0.0;
   for(int i = from; i <= to; i++)
     {
      int a = (int)MathMax(0.0, MathFloor((r[i].low - lo) / step));
      int z = (int)MathMin((double)(nb - 1), MathFloor((r[i].high - lo) / step));
      double v = (double)r[i].tick_volume;
      if(v <= 0) v = 1;
      double share = v / (z - a + 1);
      for(int k = a; k <= z; k++) { vol[k] += share; total += share; }
     }
   int p = 0;
   for(int k = 1; k < nb; k++) if(vol[k] > vol[p]) p = k;
   int dn = p, up = p;
   double inside = vol[p];
   while(inside < InpValueArea * total && (dn > 0 || up < nb - 1))
     {
      double below = (dn > 0) ? vol[dn - 1] : -1.0;
      double above = (up < nb - 1) ? vol[up + 1] : -1.0;
      if(above >= below) { up++; inside += vol[up]; }
      else { dn--; inside += vol[dn]; }
     }
   poc = lo + (p + 0.5) * step;
   val = lo + dn * step;
   vah = lo + (up + 1) * step;
  }

// looks for a region whose entry trigger is the LAST closed M15 candle.
// returns the direction (0 if none) and fills the stop price
int Signal(const string sym, const int bias, double &stopPrice, double &atrNow, string &why)
  {
   MqlRates r[];
   int n = CopyRates(sym, PERIOD_M15, 1, M15_BARS, r);
   why = "";
   if(n < InpBoxBars + ATR_N + InpZoneLife + 5) { why = "poucos candles"; return 0; }
   double a[], vs[];
   Atr(r, n, a);
   VolSma(r, n, vs);
   int last = n - 1;
   atrNow = a[last];
   int first = (int)MathMax(InpBoxBars + ATR_N, last - InpZoneLife);
   int nRegions = 0;
   for(int i = first; i <= last; i++)
     {
      // a range of InpBoxBars candles before i
      int from = i - InpBoxBars;
      double hi = -DBL_MAX, lo = DBL_MAX;
      for(int j = from; j < i; j++) { hi = MathMax(hi, r[j].high); lo = MathMin(lo, r[j].low); }
      if(a[i - 1] <= 0 || hi - lo > InpBoxAtr * a[i - 1]) continue;
      bool wide = (r[i].high - r[i].low) >= InpBreakSpread * a[i - 1];
      bool loud = vs[i - 1] > 0 && (double)r[i].tick_volume >= InpBreakVol * vs[i - 1];
      int d = (r[i].close > hi) ? 1 : (r[i].close < lo) ? -1 : 0;
      if(d == 0 || !wide || !loud) continue;
      nRegions++;
      double poc, val, vah;
      Profile(r, from, i - 1, poc, val, vah);
      // walk the region forward to the last candle
      double peak = (d > 0) ? -DBL_MAX : DBL_MAX;
      int peakIdx = i;
      double impVol = 0;
      int impN = 0;
      for(int j = i; j <= last && j - i <= InpZoneLife; j++)
        {
         if((d > 0 && r[j].high > peak) || (d < 0 && r[j].low < peak))
           {
            peak = (d > 0) ? r[j].high : r[j].low;
            peakIdx = j;
            impVol = 0; impN = 0;
            for(int k = i; k <= j; k++) { impVol += (double)r[k].tick_volume; impN++; }
           }
         double farLevel = (d > 0) ? val : vah;
         if((d > 0 && r[j].close < farLevel - 0.5 * a[j]) || (d < 0 && r[j].close > farLevel + 0.5 * a[j])) break;  // region lost
         if(j <= peakIdx) continue;
         double nearLevel = (d > 0) ? vah : val;
         bool touched = (d > 0) ? (r[j].low <= nearLevel) : (r[j].high >= nearLevel);
         if(!touched) continue;
         double pbVol = 0;
         for(int k = peakIdx + 1; k <= j; k++) pbVol += (double)r[k].tick_volume;
         double pbAvg = pbVol / (j - peakIdx), impAvg = impVol / (impN > 0 ? impN : 1);
         bool quiet = impAvg == 0 || pbAvg < InpTestVol * impAvg;
         int against = -1;
         for(int k = j - 1; k > peakIdx && against < 0; k--)
            if((d > 0 && r[k].close < r[k].open) || (d < 0 && r[k].close > r[k].open)) against = k;
         bool absorb = against >= 0 && ((d > 0) ? (r[j].close > r[j].open && r[j].close > r[against].open)
                                                : (r[j].close < r[j].open && r[j].close < r[against].open));
         if(!quiet || !absorb) continue;
         if(bias != d) continue;                                             // only aligned with the macro
         if(j < last) break;                                                  // this region already traded (or was skipped) earlier
         stopPrice = ((d > 0) ? val : vah) - d * InpStopBuffer * a[j];
         int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
         why = StringFormat("regiao %s POC %s VAL %s VAH %s, recuo com %d%% do volume do impulso",
                            d > 0 ? "compradora" : "vendedora", DoubleToString(poc, dg), DoubleToString(val, dg),
                            DoubleToString(vah, dg), (int)MathRound(pbAvg / (impAvg > 0 ? impAvg : 1) * 100));
         return d;
        }
     }
   why = StringFormat("%d regioes recentes, sem gatilho alinhado agora", nRegions);
   return 0;
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

// all closed trades of this EA: count, wins and money, plus the current block of 25
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

void Evaluate(const int s, const bool deskOpen)
  {
   string sym = g_syms[s];
   int flow = 0, ctrl = 0;
   int bias = MacroBias(sym, flow, ctrl);
   string macro = StringFormat("fluxo H1 %s, controle %s", flow > 0 ? "alta" : flow < 0 ? "baixa" : "lateral",
                               ctrl > 0 ? "comprador" : ctrl < 0 ? "vendedor" : "-");
   if(bias == 0) { g_status[s] = sym + ": " + macro + " (sem clareza)"; return; }
   double stopPrice = 0, atrNow = 0;
   string why;
   int d = Signal(sym, bias, stopPrice, atrNow, why);
   if(d == 0) { g_status[s] = sym + ": " + macro + "; " + why; return; }
   if(!deskOpen) { g_status[s] = sym + ": gatilho ignorado, mesa fechada (2 stops hoje)"; return; }
   if(HasPosition(sym)) { g_status[s] = sym + ": gatilho ignorado, ja posicionado"; return; }
   MqlTick tk;
   if(!SymbolInfoTick(sym, tk)) return;
   double entry = (d > 0) ? tk.ask : tk.bid;
   double risk = d * (entry - stopPrice);
   if(risk < InpMinRiskAtr * atrNow || risk > InpMaxRiskAtr * atrNow) { g_status[s] = sym + ": risco fora da faixa (ATR)"; return; }
   if(tk.ask - tk.bid > InpMaxCostR * risk) { g_status[s] = sym + ": spread caro demais para o risco"; return; }
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double minDist = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * point;
   if(risk <= minDist) { g_status[s] = sym + ": stop mais curto que o minimo da corretora"; return; }
   double sl = NormalizeDouble(stopPrice, digits);
   double tp = NormalizeDouble(entry + d * InpRR * risk, digits);
   double lots = LotsFor(sym, risk);
   if(lots <= 0) { g_status[s] = sym + ": lote minimo arriscaria mais que o stop definido"; return; }
   string comment = "PregaoVirtual 3R";
   trade.SetTypeFillingBySymbol(sym);                                     // each symbol accepts its own filling mode
   bool ok = (d > 0) ? trade.Buy(lots, sym, 0, sl, tp, comment) : trade.Sell(lots, sym, 0, sl, tp, comment);
   ok = ok && (trade.ResultRetcode() == TRADE_RETCODE_DONE || trade.ResultRetcode() == TRADE_RETCODE_PLACED);
   g_status[s] = sym + ": " + (ok ? (d > 0 ? "COMPRA " : "VENDA ") + DoubleToString(lots, 2) + " lotes, stop " + DoubleToString(sl, digits) +
                 ", alvo " + DoubleToString(tp, digits) + "; " + why
                 : "ordem recusada: " + trade.ResultRetcodeDescription());
   Print(g_status[s]);
  }

//------------------------------------------------------------------ events

int OnInit()
  {
   if(!InpAllowReal && AccountInfoInteger(ACCOUNT_TRADE_MODE) != ACCOUNT_TRADE_MODE_DEMO)
     {
      Alert("Pregao Virtual: esta conta NAO e demo. O robo so opera em conta demo (InpAllowReal = false).");
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
      g_status[i] = g_syms[i] + (g_ok[i] ? ": aguardando o proximo candle de 15m" : ": ativo nao existe nesta corretora");
     }
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(30);
   EventSetTimer(15);
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   Comment("");
  }

void OnTick() { }

void OnTimer()
  {
   int stops = StopsToday();
   bool deskOpen = stops < InpMaxStopsDay;
   for(int s = 0; s < ArraySize(g_syms); s++)
     {
      if(!g_ok[s]) continue;
      datetime t[];
      if(CopyTime(g_syms[s], PERIOD_M15, 1, 1, t) != 1) continue;
      if(t[0] == g_lastBar[s]) continue;                                     // once per closed 15m candle
      g_lastBar[s] = t[0];
      Evaluate(s, deskOpen);
     }
   string txt = "PREGAO VIRTUAL  |  " + (deskOpen ? "MESA ABERTA" : "MESA FECHADA: volta no proximo dia do servidor") +
                StringFormat("  |  stops hoje %d/%d  |  stop %s, alvo %.0fR", stops, InpMaxStopsDay, DoubleToString(InpStopMoney, 2), InpRR) +
                "\n" + Blocks() + "\n";
   for(int s = 0; s < ArraySize(g_syms); s++) txt += g_status[s] + "\n";
   Comment(txt);
  }
//+------------------------------------------------------------------+
