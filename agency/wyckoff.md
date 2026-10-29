# Wyckoff em reserva

Conhecimento guardado para quando o mercado formar **estrutura lateral**.
Fora da lateralizacao, a mesa opera o POI depois da limpeza de liquidez e o
Wyckoff fica parado. Fonte principal: guia "Wyckoff e SMC em acoes e day
trade" (material do usuario) e StockCharts ChartSchool.

## Quando entra em acao (regra atual, desde 2026-10-29)

O codigo (`wyckoffContext` em `agency/method.js`, `InpWyckoffContext` no robo
MT5, versao 2.30) considera **lateral** o grafico de 15 minutos quando, nos
ultimos 48 candles (12h), a faixa inteira cabe em ate 6 ATR do 15m e o preco
quase nao saiu do lugar (no maximo metade da faixa entre a abertura do
primeiro e o fechamento do ultimo candle).

Dentro de uma lateralizacao, o POI so e operado se ela tiver **contexto de
Wyckoff**:

- **compra** so se a faixa veio **depois de uma queda** (acumulacao): nos 48
  candles antes da faixa o preco caiu pelo menos uma altura da faixa;
- **venda** so se veio **depois de uma alta** (distribuicao);
- faixa sem queda nem alta antes e "mercado sem interesse, aguardando": **nao
  opera** dentro dela ("entrar no meio da guerra").

Fora de lateralizacao, o POI segue igual. O volume do spring **nao** e mais
filtro: o material mostra spring com volume alto (manipulado, spreads amplos)
e com volume baixo (desinteresse extremo); os dois valem.

## As tres leis

- **Oferta e demanda:** demanda maior que oferta, preco sobe; o contrario,
  cai. Le-se comparando barras de preco e volume.
- **Causa e efeito:** a lateralizacao (trading range) constroi a causa; o
  movimento seguinte e o efeito.
- **Esforco e resultado:** volume (esforco) sem deslocamento (resultado)
  avisa mudanca. Volume alto e amplitude curta depois de uma alta, sem nova
  maxima, sugere distribuicao.

## Acumulacao (fases)

| Fase | O que acontece | Eventos |
| --- | --- | --- |
| A | A queda para | PS, SC (climax de venda: volume e amplitude extremos), AR (define o topo do range), ST (teste com volume menor) |
| B | Construcao da causa | Varios testes; upthrusts no topo; volume das quedas diminui |
| C | Teste final da oferta | **Spring** (rompe o fundo e volta para dentro), teste do spring com volume menor |
| D | Demanda domina | SOS (alta com amplitude e volume crescentes), LPS (recuo com volume menor), BU (volta ao riacho) |
| E | Markup | Sai do range; tendencia; podem surgir reacumulacoes |

Spring nao e obrigatorio: existe acumulacao sem spring (fase C mais dificil).

## Distribuicao (espelho)

PSY, BC (climax de compra, muitas vezes com noticia boa), AR, ST, **UT/UTAD**
(rompimento falso do topo, o spring invertido), SOW (fraqueza), LPSY (ultimo
ponto de oferta), markdown.

## Ponte com o metodo da mesa (SMC/POI)

| Wyckoff | Mesa |
| --- | --- |
| Spring / upthrust | Varredura de liquidez (limpeza do fundo/topo) |
| SOS | Fechamento acima do topo da puxada (confirma o POI) |
| LPS / BU | Volta a zona do POI (entrada na ordem limitada) |
| Zona de acumulacao | Zona de demanda / POI |

A sequencia "varredura, virada da estrutura no grafico menor, entrada na zona,
stop alem do pavio, alvo na proxima liquidez" e o spring, SOS e LPS com outro
vocabulario.

## Do material "O metodo Wyckoff" (20 paginas, enviado pelo usuario)

- Os precos andam de lado 70% a 80% do tempo e em tendencia 20% a 30%. Pela lei
  de causa e efeito, precisam passar tempo na faixa para depois sair em
  desequilibrio.
- **Nem toda lateralizacao e Wyckoff**: nem todo equilibrio tem interesse
  profissional acumulando ou distribuindo. As vezes o preco flutua aleatorio
  esperando interesse.
- Operar dentro do equilibrio e "entrar no meio da guerra": esperar o
  desequilibrio ficar evidente. Um ciclo pode sempre se estender mais um pouco.
- **Acumulacao**: lateral depois de queda substancial; o estoque passa das maos
  fracas para as fortes. **Distribuicao**: lateral depois de alta substancial;
  das maos fortes para as fracas, e precisa de tempo.
- Durante a construcao ha **manobras** para verificar o caminho de menor
  resistencia: varias capturas de liquidez dentro da faixa (testes), para
  levar a maioria ao lado errado.
- Cinco caracteristicas da acumulacao: (1) volume e volatilidade diminuindo;
  (2) testes no topo e no fundo com pouco volume; (3) movimentos mais fluidos
  para cima e mais custosos para baixo (impulso para cima com volume excessivo
  e fraqueza, nao forca); (4) spring na fase C, com volume alto ou baixo;
  (5) topos e fundos ascendentes com harmonia na fase D (altas impulsivas com
  volume, baixas com desinteresse).
- Esquema basico: PS, SC, AR, ST, UA, SOW, SP (spring), TEST, LPS, SOS, BU
  (creek), LPS, SOS. Os esquemas sao ideais: o mercado nem sempre os mostra
  igual; a leitura precisa de flexibilidade com alguns elementos fixos.

## Estudo no historico (2026-10-29)

BTC 5m, POI sem filtro de 1h, lateralizacao de 12h/6 ATR (BTC fica lateral
18% do tempo; 29% com 16h/8 ATR):

| Onde a varredura aconteceu (ultimo ano) | Trades | Media |
| --- | --- | --- |
| Fora de lateralizacao | 63 | +0,30R |
| Dentro, faixa sem queda/alta antes | 10 | cerca de -0,74R |
| Dentro, faixa com contexto (acumulacao/distribuicao) | 3 | positivos (amostra minima) |

Regra de contexto (`node agency/lab-variants.js`, custos do MT5):

| | Ultimo ano, sem 1h | Ultimo ano, com 1h | Ano anterior, sem 1h | Ano anterior, com 1h |
| --- | --- | --- | --- | --- |
| POI | 96 trades +0,11R | 22 trades +0,50R | 70 trades -0,24R | 15 trades -0,37R |
| POI + contexto Wyckoff | 83 trades +0,20R | 18 trades +0,85R | 60 trades -0,09R | 14 trades -0,32R |

A regra ajudou nos dois anos (o ano anterior nao foi usado para cria-la). O
POI em si **perdeu** no ano anterior: nao ha vantagem comprovada. Continua so
em conta demo.

## Cuidados (do guia)

- Nao ha estudo revisado por pares provando lucro com springs, esquemas ou
  VSA; um backtest de SMC em 738 ativos nao bateu o buy and hold.
- Volume real faz diferenca: BTC (Binance) e futuros CME tem volume real; no
  MT5 o forex tem so volume de ticks da corretora.
- Rotulos de fase sao subjetivos; da para "explicar" qualquer movimento depois
  que ele acontece. Por isso a mesa usa regra escrita e testada, nao rotulo.
- Gestao: risco de 0,5% a 1% por operacao (a mesa usa US$ 50 numa conta de
  US$ 5.000), limite diario (2 stops), julgar em blocos de 25 trades.

## Testes ja feitos

`node agency/lab-variants.js` (resultado em `agency/lab-variants.json`):

- filtro de volume em toda varredura: poucos trades e negativo;
- spring com volume baixo so na borda de lateralizacao estreita
  (`wyckoffRange`, regra antiga): nao mudou nada e contradiz o material;
  substituida pela regra de contexto (`wyckoffContext`).
