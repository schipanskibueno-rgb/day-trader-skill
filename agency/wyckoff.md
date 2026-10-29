# Wyckoff em reserva

Conhecimento guardado para quando o mercado formar **estrutura lateral**.
Fora da lateralizacao, a mesa opera o POI depois da limpeza de liquidez e o
Wyckoff fica parado. Fonte principal: guia "Wyckoff e SMC em acoes e day
trade" (material do usuario) e StockCharts ChartSchool.

## Quando entra em acao

O codigo (`tradingRange` em `agency/method.js`, `TradingRange` no robo MT5)
considera lateral o grafico de 15 minutos quando, nos ultimos 32 candles (8h):

- a faixa inteira (maxima menos minima) cabe em ate 4 ATR do 15m; e
- o preco quase nao saiu do lugar: a diferenca entre a abertura do primeiro e
  o fechamento do ultimo candle e no maximo metade da faixa.

Nessa situacao, uma varredura de liquidez perto da borda (ate 0,5 ATR) so vale
como **spring** (embaixo) ou **upthrust** (em cima) se o candle da varredura
negociar **menos volume que a media** dos ultimos 20. Varredura com volume
alto dentro de lateralizacao e tratada como rompimento de verdade, e o POI
nao e operado. Em 1 ano de BTC em 5m isso aconteceu em 1 de 75 POIs: a regra
e rara de proposito.

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
- Wyckoff so em lateralizacao (`wyckoffRange`): mesmo resultado do POI puro
  em 1 ano de BTC, porque a situacao quase nao apareceu; fica ligado para
  quando aparecer.
