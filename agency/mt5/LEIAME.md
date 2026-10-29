# Robo Pregao Virtual para MetaTrader 5

Ha duas versoes. **Instale a versao 2** (`PregaoVirtual2.mq5`):

- **Versao 2, POI depois da limpeza de liquidez** (a da aula ao vivo do curso):
  marca os topos e fundos do grafico de 15 minutos; quando um candle de 5
  minutos passa de um deles, espera o POI (sobe, puxa para baixo quebrando
  um fundinho com fundo mais alto perto da varrida, e fecha acima do topo da
  puxada). Coloca ordem limitada no topo da zona, stop abaixo da puxada,
  alvo 3R. So a favor do macro H1. Ativos padrao: BTCUSD e XAUUSD. A ordem
  limitada e cancelada depois de 2 horas, se o preco for ao alvo sem pegar a
  ordem, ou se a mesa fechar por 2 stops. Numero magico 28102026.
- **Versao 1** (`PregaoVirtual.mq5`), guardada para comparacao, descrita
  abaixo.

Os passos de instalacao sao os mesmos para as duas; troque so o nome do
arquivo. Nao rode as duas na mesma conta: cada uma conta os proprios stops.

Versao 1, o metodo antigo da agencia:

- **Macro H1:** fluxo de topos e fundos, CHoCH e o controle do ultimo volume
  alto. So opera quando fluxo e controle concordam.
- **Micro M15:** lateralizacao de 16 candles abandonada com candle largo e
  volume alto vira regiao de interesse, marcada pelo volume profile (POC, VAL,
  VAH). Entrada no retorno a regiao com menos volume que o impulso e candle de
  absorcao.
- **Gestao:** stop de valor fixo (padrao US$ 50 na versao 2 e US$ 80 na versao 1, na moeda da conta), alvo 3R
  sem fechar antes, no maximo 2 stops por dia. Depois disso nao abre mais nada
  ate o dia seguinte do servidor. Mostra os blocos de 25 trades no grafico.
- **Trava:** so funciona em conta **demo**. Para conta real seria preciso mudar
  `InpAllowReal` de proposito.

O volume no MT5 e o volume de ticks da corretora. A agencia usa o volume dos
futuros da CME, entao os sinais podem nao ser identicos aos da pagina.

## O robo nao roda no celular nem no tablet

O app do MT5 para Android e iOS nao executa robos. Ele precisa de um MT5 de
computador ligado. Ha dois jeitos usando so o tablet na maior parte do tempo:

### Jeito A: computador emprestado uma vez + VPS da MetaQuotes (cerca de US$ 15 por mes)

1. Num computador Windows, instale o MetaTrader 5 de metatrader5.com e entre
   na sua conta demo (Arquivo > Abrir uma conta / Conectar a conta).
2. Arquivo > Abrir pasta de dados > MQL5 > Experts. Copie `PregaoVirtual.mq5`
   para la.
3. No MT5, abra o MetaEditor (F4), abra o arquivo e aperte **Compilar (F7)**.
   Se aparecer erro, copie a mensagem e mande para o Claude.
4. Abra um grafico qualquer (ex.: EURUSD M15), arraste o robo
   **PregaoVirtual** do Navegador para o grafico, marque "Permitir Algo
   Trading" e confira os parametros (stop, ativos). Ligue o botao
   **Algo Trading** na barra de cima.
5. Clique com o botao direito na conta (Navegador) > **Registrar um servidor
   virtual**, escolha o plano e migre o ambiente. A partir dai o robo roda 24h
   na VPS e o computador pode ser desligado.
6. No tablet, abra o app MT5 com a mesma conta: as ordens do robo aparecem em
   Negociacao e Historico.

### Jeito B: Windows na nuvem acessado pelo tablet

1. Alugue um VPS Windows em qualquer provedor.
2. No tablet, instale o app **Windows App / Remote Desktop** e conecte no VPS.
3. Faca os passos 1 a 4 do Jeito A dentro do VPS e deixe o MT5 aberto.

## A agencia decide, o robo executa (versao 2.20)

Com `InpFollowAgency = true` (padrao) o robo so opera dentro do **plano da
agencia**: a cada 3 horas a agencia diz, para cada ativo, "so compras", "so
vendas" ou "nao operar", com o motivo (macro 1h, Radar contra, mesa fechada,
ativo inexistente). O plano vale 4 horas; sem plano valido o robo nao opera.
A agencia tambem pode mandar **ordens diretas** (por exemplo, a ordem de
teste), sempre com stop em fracao do preco e alvo 3R.

As mensagens chegam pelo canal `pregao-virtual-a224d58b32c0-cmd` e sao
**assinadas** com a chave da agencia. O robo so aceita mensagens com a chave
digitada em **InpAgencyKey** (nas Entradas do robo). Mesmo com ordem da
agencia, o robo mantem os proprios limites: so conta demo, so os ativos de
InpSymbols, no maximo InpStopMoney por operacao, 2 stops por dia, uma
posicao por ativo e conferencia de margem. O lote e calculado pela propria
corretora (quanto se perde por lote ate o stop) e reduzido se faltar margem.

Cada resultado (executada, recusada pelo robo ou pela corretora, com o
motivo em portugues) volta para a agencia pela ponte abaixo.

## Ponte com a agencia (versao 2.10)

O robo envia um resumo da conta para a agencia 3D: saldo, posicoes, ordens
limitadas, ultimas 10 operacoes e o que ele esta vendo em cada ativo. Envia a
cada 15 minutos e logo depois de cada operacao, pelo canal
`pregao-virtual-a224d58b32c0` do ntfy.sh (gratuito, guarda 12 horas). A
agencia le a cada 3 horas e mostra na aba Corretora. A agencia nunca manda
ordens para o robo.

Para funcionar, o MetaTrader precisa deixar o robo acessar o endereco:

1. **Ferramentas > Opcoes > aba Expert Advisors**.
2. Marque **Permitir WebRequest para os URL listados**.
3. Clique na lista, adicione `https://ntfy.sh` e clique **OK**.

A ultima linha do texto do robo no grafico diz se a ponte esta funcionando
("resumo enviado as ...") ou o que falta. O canal e publico para quem souber o
nome; os dados sao so da conta demo. Para desligar, mude `InpBridge` para
false.

## Conferindo as primeiras ordens

No canto do grafico o robo escreve o estado da mesa (aberta ou fechada, stops
do dia, bloco de 25) e uma linha por ativo dizendo o que viu. Quando abrir uma
ordem, confira na aba Negociacao:

1. **Stop:** passe o dedo/mouse no preco do stop. A perda ate ele deve ficar
   perto de US$ 50 na versao 2 (um pouco menos, porque o lote e arredondado para baixo).
2. **Alvo:** a distancia entrada-alvo deve ser 3 vezes a distancia
   entrada-stop.
3. **Comentario:** a ordem aparece como `PregaoVirtual2 POI 3R` (versao 2) ou
   `PregaoVirtual 3R` (versao 1). Na versao 2 a ordem pode aparecer primeiro
   como **ordem limitada** (pendente) e so vira posicao quando o preco voltar
   a zona.

Mensagens comuns na linha do ativo:

- `ativo nao existe nesta corretora`: o nome do ativo e diferente na sua
  conta (ex.: `BTCUSD` pode nao existir). Ajuste o parametro de ativos.
- `lote minimo arriscaria mais que o stop definido`: o stop tecnico ficou
  largo demais para o stop em dinheiro com o menor lote. A ordem e pulada de proposito.
- `ordem recusada: ...`: copie a frase e mande para o Claude.

## Seguranca

- Nunca envie a senha da corretora por chat, e-mail ou mensagem. Digite so
  dentro do MT5.
- Se ja enviou, troque a senha no MT5: Ferramentas > Opcoes > Servidor > Alterar.
- O metodo ainda nao tem vantagem comprovada nos testes (ver a aba Corretora da
  agencia). Use em demo e avalie em blocos de 25 trades. Nao e recomendacao de
  investimento.
