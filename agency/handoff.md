# Handoff: assistente de trade "Pregao Virtual"

Resumo para continuar o projeto em outra conversa. Usuario fala portugues,
usa **so tablet Android** (com Termux) e prefere instrucoes simples, um comando
por vez.

## Onde o usuario quer chegar

Um sistema de trade que:

1. Analisa **BTC, ouro (XAU) e forex** (nao acoes) com o metodo do curso dele
   (materiais Excelencia Trading: Risco x Retorno, Regioes de Interesse/ICT,
   Preco e Volume, Tendencias Fractais, Volume Profile).
2. Funciona **24/7 sem precisar deixar nada aberto** e abre em qualquer aparelho.
3. Mostra uma **agencia 3D** com agentes por setor (trade, pesquisa, economia,
   laboratorio, diretoria) que estudam, fazem reunioes e operam uma corretora
   virtual com dados reais.
4. Opera de verdade **na conta demo do MetaTrader 5** (MetaQuotes-Demo).

## Regras de gestao definidas pelo usuario (obrigatorias)

- Stop fixo de **US$ 80** por operacao (editavel na pagina).
- Alvo sempre **3R** (3 para 1), sem fechamento antes.
- **Maximo de 2 stops por dia.** Depois disso o setor de trade "vai embora"
  (apaga as luzes) e so volta na proxima abertura/dia. A pesquisa continua
  estudando noticias, reacoes do mercado a eventos (presidente, juros etc.) e
  os melhores ativos para a proxima sessao.
- O usuario escolhe a conta operacional (capital) na pagina.
- Resultados medidos em **blocos de 25 trades**.

## Onde esta tudo

Repositorio: `schipanskibueno-rgb/day-trader-skill`, branch
`claude/practical-keller-hauv05` (antes `ccr-3497652c-mvjbc0`; sem PR aberto). Testes:
`python3 -m unittest discover -s tests` (345 passando). O teste
`tests/test_repo.py` limita as pastas da raiz: arquivos novos vao em
`agency/`, `docs/` ou `tests/`.

| Caminho | O que e |
| --- | --- |
| `agency/method.js` | O metodo em regras (macro H1, regioes M15, gestao, 2 stops/dia, blocos de 25). Causal, testado. |
| `agency/brain.js` | Busca dados reais, roda o metodo, simula a corretora, gera a ata da reuniao. `node agency/brain.js --out state.json --config cfg.json --every-hours 2` |
| `agency/agencia.html` | Pagina 3D (three.js 0.160 via jsdelivr), le o banco do artifact. Aba Ajustes grava capital e stop. |
| `agency/mt5/PregaoVirtual.mq5` | Mesmo metodo como Expert Advisor do MT5. So roda em conta demo. **Ainda nao compilado.** |
| `agency/mt5/LEIAME.md` | Como instalar o EA tendo so tablet. |
| `trader-broker/binance.py` | CLI da Binance Spot **Testnet** (plan/approve/place com OCO/close). Funcionou no tablet do usuario. |
| `docs/` | "Robo Trader": pagina de sinais anterior (engine.js). `python3 docs/robo.py` no Termux abre no navegador. GitHub Pages nunca foi ativado. |

## O que esta no ar

- **Agencia 3D:** https://claude.ai/artifact/CDeFWMwfMpb8i7uG7eRz3r
  (compartilhada por link). Banco do artifact: `agency/state` (saida do brain)
  e `agency/config` (capital, stopUsd). Regra do banco: leitura `view`,
  escrita `admin`.
- **Tarefa agendada** `trig_01KdaTx8SdqMScjZo7kRKrWv`: a cada 2h (minuto 40
  UTC) abre uma sessao nova, clona o repo na branch, le `agency/config`, roda o
  brain e grava `agency/state` com `if_version`. Custa cerca de US$ 0,10 por
  execucao. Para mudar o metodo basta dar push na branch: a proxima execucao
  ja usa.

## O metodo (como esta programado)

1. **Macro H1:** pivos (k=3, conhecidos 3 candles depois), fluxo de topos e
   fundos, CHoCH quando o ultimo pivo rompe contra o fluxo, "controle" do
   ultimo candle com volume >= 2x a media e amplitude >= 1,2 ATR (vira se o
   preco perde o nivel). So ha direcao (bias) quando fluxo e controle concordam.
2. **Micro M15:** 16 candles dentro de 2,5 ATR, rompidos por candle >= 1,2 ATR
   com volume >= 1,5x, viram regiao de interesse. Volume profile da
   lateralizacao (24 faixas, 70%) da POC, VAL e VAH.
3. **Gatilho:** retorno a VAH (compra) ou VAL (venda) com volume medio do
   recuo < 80% do impulso, e candle de absorcao fechando alem da abertura do
   ultimo candle contrario. Precisa estar alinhado com o bias. Uma entrada por
   regiao; regiao vale 96 candles.
4. **Ordem:** entrada na abertura seguinte, stop alem da regiao + 0,2 ATR,
   risco entre 0,3 e 4 ATR, custo (taxa/spread) no maximo 0,25R, alvo 3R.

Mercados: BTC pela Binance; ouro e moedas pelos **futuros CME no Yahoo**
(GC=F, 6E=F, 6B=F, 6J=F, 6A=F), porque o forex a vista nao tem volume.

## Resultados honestos ate agora

- Mesmas regras em 1h com macro 4h, 2 anos: 30 trades, cerca de +0,08R por
  trade. Em 15m, 60 dias: 5 trades, -1,17R. Com alvo 3R o equilibrio e 25% de
  acerto. **Nao ha vantagem comprovada**; amostras pequenas.
- Variantes no laboratorio: macro completo +0,08R (30), so fluxo -0,21R (44),
  sem filtro +0,07R (74).
- No sistema anterior (indicadores classicos) so o grafico diario teve
  resultado positivo; intraday perdia para taxas e ruido.
- Decisao: **nao ajustar parametros para o passado ficar bonito.** Mudar regra
  so depois de um bloco de 25 trades novos.

## Limites tecnicos ja descobertos

- A sessao na nuvem e bloqueada pela Binance (`api.binance.com`, testnet):
  "restricted location". `data-api.binance.vision` (dados publicos) funciona.
- API do Banco Central (`api.bcb.gov.br`) da timeout a partir da nuvem. GDELT
  devolve 429.
- Artifacts nao fazem fetch externo (CSP): os dados chegam pelo banco do
  artifact, gravados pela tarefa agendada.
- Funcionam: Yahoo Finance chart API (15m ate 60d, 1h ate 730d), Google
  Noticias RSS, MarketWatch RSS, alternative.me.
- O MT5 nao tem API web. O EA precisa de MT5 de computador ou VPS; o app de
  celular nao roda robos.

## MetaTrader 5 (proximo passo principal)

- Conta demo MetaQuotes-Demo, login 114681127. O usuario mandou as senhas no
  chat; foi orientado a troca-las. **Nunca guardar nem repetir senhas.**
- Caminho escolhido (so tem tablet): usar um computador emprestado uma vez,
  instalar o MT5, compilar o EA (F7), anexar a um grafico e migrar para a
  **VPS da MetaQuotes** (cerca de US$ 15/mes). Alternativa: VPS Windows
  acessado pelo app Remote Desktop.
- Se a compilacao der erro, corrigir no `PregaoVirtual.mq5` a partir da
  mensagem do MetaEditor.
- Diferenca a lembrar: o EA usa volume de ticks da corretora; a agencia usa
  volume dos futuros CME.

## Versao 2: POI depois da limpeza de liquidez (2026-10-28)

Vem de uma aula ao vivo do curso (video de 64 min que o usuario mandou). Em
`agency/method.js`, `poiSetups()`:

- Liquidez: topos e fundos (pivos k=3) do grafico maior (15m para gatilho 5m).
- Varrida: um candle passa do nivel. Se o preco seguir mais de 1,5 ATR do
  grafico maior, e rompimento, nao varrida.
- POI: depois da varrida, sobe, puxa para baixo quebrando um fundinho da
  subida, faz fundo mais alto e perto (ate 1 ATR maior) da varrida e fecha
  acima do topo de onde a puxada comecou. Zona = ultimo candle de baixa da
  puxada ate o fundo dela.
- Entrada: ordem limitada no topo da zona por 24 candles; stop abaixo da
  puxada (+0,1 ATR); alvo 3R. Se bater o alvo ou o stop antes, cancela.
- Vendas sao o espelho (roda no grafico invertido).

`node agency/lab-poi.js --out x.json` compara v1 e v2 (resultado salvo em
`agency/lab-poi.json`). Com custo estimado do MT5, gatilho 5m: v1 23 trades
-0,75R; v2 93 trades +0,14R (BTC 75 trades +0,23R, ouro 15 trades -0,28R,
moedas so 60 dias e quase sem trades); v2 com filtro macro H1 21 trades
+0,57R (BTC 19). Em 1h/4h (2 anos) a v2 perde para a v1 (-0,13R contra
+0,29R). Com a taxa da Binance (0,1% por lado) o BTC em 5m nao tem trade
nenhum: o stop e menor que a taxa. Nada disso e prova: e um ano de um ativo.
Robo da v2: `agency/mt5/PregaoVirtual2.mq5` (BTCUSD e XAUUSD, magico
28102026, nao compilado ainda). A agencia (brain.js) tambem passou a operar a
v2 em BTC e ouro com custo estimado do MT5; moedas so observadas. A tarefa
agendada agora le a branch `claude/practical-keller-hauv05`. Nos ultimos 60
dias a v2 com filtro H1 fez 5 trades, todos stop: amostra pequena, segue o
plano dos blocos de 25.

## Consulta antes de operar (2026-10-28)

- `agency/radar-engine.js` e o motor do Radar de Ativos
  (https://claude.ai/artifact/WE7tnuyZmu3in4q1JCxetr, fonte em
  `agency/radar.html`). Antes de cada ordem a mesa le estrutura + sinal do
  Radar em 2, 5, 10 e 15 minutos e guarda em `consult` da operacao.
- Aba Graficos na agencia (BTC e ouro em 2/5/10/15m, liquidez de 15m,
  varridas, POIs). O Radar mostra os mesmos candles para BTC e OURO, lidos do
  banco dele (`radar/candles`), gravado pela tarefa agendada
  (`--radar-out`).
- Gatilho de 2m roda no papel ao lado do de 5m (`desk.compare`). Teste de 6
  meses no BTC: 2m pior que 5m (15 trades -0,39R contra 31 trades +0,25R, sem
  filtro de 1h); o usuario pediu para rodar os dois e comparar em blocos.

## Proximos passos sugeridos

1. Ajudar o usuario a compilar e instalar o EA no MT5 demo e conferir as
   primeiras ordens (lote, stop de US$ 80, alvo 3R).
2. Opcional: mostrar na agencia 3D as ordens reais do MT5 (exigiria uma ponte,
   por exemplo o EA gravando um arquivo/endpoint que a tarefa agendada leia).
3. Acompanhar os blocos de 25 trades e so entao revisar regras no laboratorio.
4. Ajustar a frequencia da tarefa agendada se o custo pesar (4h ou 6h).

Nada aqui e recomendacao de investimento; tudo opera em papel ou demo.
