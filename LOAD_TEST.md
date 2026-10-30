# Load Test (diferencial, opcional)

Teste de carga **executado manualmente, fora da suíte padrão**. O objetivo é caracterizar throughput,
latência e contenção de lock do caminho crítico, sem meta de RPS pré-definida.

## Pré-requisitos

1. Bun 1.4.x, `curl` e `jq` no host.
2. Docker + Docker Compose v2.
3. [k6](https://k6.io/docs/get-started/installation/) instalado **ou** a imagem
   oficial `grafana/k6` via Docker (não exige instalação no host).
4. Stack no ar:

   ```bash
   docker compose up -d --build
   ```

   O Compose publica a app em `127.0.0.1:${APP_PORT:-3000}` (default 3000). Para
   múltiplas instâncias, use o harness de 3 processos Bun da suíte de concorrência
   ou um proxy/port range; o Compose expõe uma única porta em loopback por
   serviço. Para carga, um processo já satura o PostgreSQL local.

   > **Volume antigo:** se o serviço `migrate` falhar com
   > `TableExistsException: relation "wallets" already exists`, o volume
   > `postgres_data` foi criado por uma versão anterior com migrations
   > renomeadas e a tabela `mikro_orm_migrations` não reconhece os arquivos
   > atuais. Em ambiente local, recrie o volume antes do teste:
   >
   > ```bash
   > docker compose down -v
   > ```

5. Uma wallet com saldo suficiente. Crie via API:

   ```bash
   curl -s -X POST http://localhost:3000/wallets \
     -H 'Content-Type: application/json' \
     -d '{
       "playerId": "<playerId UUID>",
       "initialBalance": { "amount": "1000000.00", "currency": "BRL" }
     }'
   ```

   Use `initialBalance` alto o bastante para a duração do teste: cada iteração
   executa um `BET` de `K6_AMOUNT` (default `1.00`). Se o saldo acabar, a carga
   passa a medir rejeições `INSUFFICIENT_FUNDS` (e o threshold
   `http_req_failed` pode falhar; veja a nota sobre status abaixo).

## Execução

Com k6 instalado no host:

```bash
K6_BASE_URL=http://localhost:3000 \
K6_PLAYER_ID=<playerId> \
K6_WALLET_ID=<walletId> \
K6_VUS=10 K6_DURATION=60s K6_AMOUNT=1.00 \
bun run test:load
```

Sem k6 instalado, usando a imagem oficial via Docker (Linux, `--network host`):

```bash
K6_BASE_URL=http://localhost:3000 \
K6_PLAYER_ID=<playerId> \
K6_WALLET_ID=<walletId> \
K6_VUS=10 K6_DURATION=60s K6_AMOUNT=1.00 \
bun run test:load:docker
```

### Script automatizado

Para executar o fluxo completo (stack + wallet + aquecimento + cenário + métricas +
reconciliação), use:

```bash
bun run test:load:full
```

Requer `curl` e `jq` no host, além de `bun` e Docker/k6. Por padrão, a stack é
derrubada ao final; use `KEEP_STACK=1` para mantê-la.

O script `scripts/load-test.sh`:

1. sobe a stack com `docker compose up -d --build` (configurável);
2. aguarda `/health/ready`;
3. cria uma wallet com `INITIAL_BALANCE` (default `1000000.00`);
4. roda o aquecimento e descarta os números;
5. aguarda a outbox drenar;
6. captura `/metrics` antes do cenário principal;
7. roda o cenário principal;
8. captura `/metrics` imediatamente após a carga;
9. aguarda a outbox drenar novamente e chama a reconciliação;
10. grava as saídas do k6 (`warmup.log`/`main.log`), métricas, wallet,
    reconciliação e `summary.txt` em `load/results/<timestamp>/` (ignorado pelo
    Git). Logs da aplicação não são coletados pelo script.

Variáveis do script:

| Variável | Default | Descrição |
|---|---|---|
| `K6_BASE_URL` | `http://localhost:3000` | URL da API |
| `INITIAL_BALANCE` | `1000000.00` | Saldo inicial da wallet criada |
| `WARMUP_VUS` / `WARMUP_DURATION` | `5` / `15s` | Aquecimento descartado |
| `MAIN_VUS` / `MAIN_DURATION` | `10` / `60s` | Cenário principal |
| `K6_AMOUNT` | `1.00` | Valor de cada `BET` |
| `START_STACK` | `1` | `0` usa uma stack já em execução |
| `SKIP_BUILD` | `0` | `1` evita rebuild da imagem |
| `KEEP_STACK` | `0` | `1` mantém a stack no ar ao final |
| `LOAD_RUNNER` | `auto` | `host` (k6 local) ou `docker` (imagem `grafana/k6`) |
| `RESULTS_DIR` | `load/results/<timestamp>` | Diretório dos artefatos |
| `OUTBOX_DRAIN_TIMEOUT_SECONDS` | `60` | Tempo máximo de espera da outbox |

Exemplo sem rebuild e mantendo a stack:

```bash
SKIP_BUILD=1 KEEP_STACK=1 MAIN_VUS=20 MAIN_DURATION=120s bun run test:load:full
```

Variáveis do k6 (`K6_*`) suportadas:

| Variável | Default | Descrição |
|---|---|---|
| `K6_BASE_URL` | `http://localhost:3000` | URL da API |
| `K6_PLAYER_ID` | — | UUID do jogador (obrigatório) |
| `K6_WALLET_ID` | — | UUID da wallet (obrigatório) |
| `K6_PROVIDER_ID` | `provider-load` | provider da carga |
| `K6_CURRENCY` | `BRL` | moeda |
| `K6_AMOUNT` | `1.00` | valor por `BET` |
| `K6_VUS` | `10` | VUs simultâneos |
| `K6_DURATION` | `30s` | duração do cenário no uso direto; `test:load:full` usa `MAIN_DURATION` |
| `K6_SLEEP_SECONDS` | `0` | pausa entre iterações |

O script valida `/health/ready` no setup, envia `Idempotency-Key` única por
iteração, mede latência e registra `422` em
`load_transactions_rejected_total`, `200` em `load_idempotency_replays_total` e
demais status fora de `{201, 200, 202, 422, 409}` em
`load_unexpected_responses`. Os thresholds padrão são `http_req_failed < 1%`,
`p(95) < 1000ms` e respostas inesperadas `< 1%`. Atenção: o `http_req_failed` do
k6 considera esperados apenas `200-399`, então `422`/`409` contam como falha
nesse threshold mesmo sendo aceitos pelo script; uma carga que esgote o saldo
tende a estourar `http_req_failed`.

## Metodologia

1. Suba a stack e aguarde `health/ready = 200`.
2. Rode um aquecimento curto (`K6_VUS=5 K6_DURATION=15s`) e descarte os números.
3. Rode o cenário principal com duração suficiente para estabilizar (≥ 60s).
4. Colete em paralelo, se possível:

   ```bash
   curl -s http://localhost:3000/metrics > metrics-before.txt
   # durante o teste:
   watch -n 5 'curl -s http://localhost:3000/metrics | grep -E "wager_transactions_total|wager_transaction_processing_seconds|db_lock_wait_seconds|db_lock_timeouts_total|db_deadlocks_total|outbox_pending|outbox_publish_lag_seconds|sqs_dlq_messages"'
   ```

5. Registre o hardware, o número de instâncias e o pool.

## Resultado — execução local

Execução de referência: artefatos locais em `load/results/20261029-222557`
(diretório ignorado pelo Git; os números relevantes estão reproduzidos abaixo).
Para reproduzir, recrie o volume do PostgreSQL com `docker compose down -v`
antes de `bun run test:load:full`; o script sobe a stack, mas não remove volumes
antigos. Números medidos pelo script; p50/p95/p99 de lock wait e de lag da
outbox são interpolados a partir dos buckets dos histogramas.

- Ambiente (CPU/RAM/disco): Intel i5-12450H, 12 vCPU, 23 GiB RAM, NVMe; Pop!_OS
  22.04, Docker Engine 29.9.2 (overlay2), k6 v2.3.0 no host, Bun 1.4.0
- Instâncias da app: 1; `INSTANCE_ID=local-demo` no `.env` da execução (o
  Compose usa `app-1` quando `INSTANCE_ID` não está definido; o `.env.example`
  versionado usa `local-dev`, então ajuste o `.env` para reproduzir o label)
- PostgreSQL: 16.14-alpine, `max_connections=100`; pool da app `max=10`
  (`acquireTimeoutMillis=5000`)
- Cenário: aquecimento 5 VUs/15,1 s descartado (1.298 BETs, 86,2 req/s) +
  principal VUs=10, duração=60,1 s, amount=1.00 BRL
- Throughput: 79,3 req/s (4.768 iterações em 60,1 s). O aquecimento com 5 VUs
  foi mais rápido (86,2 req/s), sinal de saturação ao subir para 10 VUs
- p50 / p95 / p99 (ms): 102,2 / 231,8 / 273,7 (`http_req_duration`; avg 125,6,
  min 8,3, p90 216,7, max 394,0)
- Taxa de erro HTTP: 0,00% (0/4.769)
- `wager_transactions_total` por status: `PROCESSED` +4.768 (1.299 → 6.067);
  sem séries `REJECTED`/`FAILED` no `/metrics` (0 no cenário)
- `wager_idempotency_hits_total`: +0 (cada iteração usa key única)
- `db_lock_wait_seconds` p50/p95/p99: ~84,6 / ~225,6 / ~246,7 ms (4.768
  amostras; soma +475,6 s; média 99,7 ms)
- `db_lock_timeouts_total` / `db_deadlocks_total`: 0 / 0
- `outbox_pending` / `outbox_publish_lag_seconds`: 706 pendentes
  imediatamente após a carga, drenados para 0 dentro do timeout de 60 s do
  script; 8.840 publicações durante a carga + 696 no dreno = 9.536 eventos
  (2 por BET); lag médio ~2,6 s, p50 ~2,3 s, p95 ~8,8 s, p99 ~13,8 s, nenhuma
  amostra acima de 15 s; `outbox_dead_lettered=0`. O gauge `outbox_pending` é
  amostrado periodicamente e pode divergir do histograma em até um batch
- `sqs_dlq_messages` / `sqs_dlq_oldest_message_age_seconds`: 0 / 0 nas duas DLQs
- Wallet final: `993.934,00 BRL`, `version=6067`; reconciliação
  `consistent=true`, `checkedEntries=6.067`, `difference=0.00` (o `OPENING` da
  criação da wallet entra em `wager_transactions_total` e `checkedEntries`)
- Observações e gargalos: o caminho HTTP não apresentou erros, lock timeouts nem
  deadlocks. A contenção no lock da wallet é o principal fator de latência: o
  lock wait p95 (~225,6 ms) responde por quase todo o p95 HTTP (~231,8 ms) e a
  média do lock subiu de ~42 ms no aquecimento (5 VUs) para ~99,7 ms no cenário
  principal (10 VUs), com throughput menor. O `OUTBOX_PUBLISH_CONCURRENCY=4`
  (default do código) reduziu o backlog de outbox de milhares para 706 pendentes
  ao fim da carga, drenados em poucos segundos; a publicação (~147 eventos/s
  durante a carga) ainda fica levemente abaixo da escrita (~159 eventos/s).
  Atenção: o `docker-compose.yml` não repassa `OUTBOX_PUBLISH_CONCURRENCY` ao
  serviço `app`, então alterar essa variável no `.env` não afeta a app
  containerizada; adicione-a ao `environment` do serviço para testar outro
  valor. Para sustentar mais VUs, o gargalo a atacar é a serialização por wallet
  (sharding/batch), não o publisher.

### Comparação com execuções anteriores

As execuções não foram isoladas no host; use a tabela como tendência, não como
benchmark absoluto. As linhas “sem concorrência” correspondem a builds em que o
publisher da outbox publicava serialmente; a linha com
`OUTBOX_PUBLISH_CONCURRENCY=4` usa o default do código. Como o Compose não
repassa essa variável, o valor 4 não foi configurado no ambiente do container:
a comparação é entre builds, não apenas entre valores de variável.

| Publisher | VUs | req/s | p95 HTTP | lock wait médio | outbox ao fim |
|---|---|---|---|---|---|
| sem concorrência | 10 | 145,0 | 149,6 ms | 57,7 ms | 10.330 |
| sem concorrência | 10 | 107,5 | 156,7 ms | 77,9 ms | 7.800 |
| `OUTBOX_PUBLISH_CONCURRENCY=4` | 10 | 79,3 | 231,8 ms | 99,7 ms | 706 |

A execução nova mostra o efeito esperado do publisher concorrente: o backlog de
outbox cai de milhares para centenas. Em contrapartida, throughput e latência
pioraram nesta medição; como o host não estava isolado, a queda não pode ser
atribuída apenas à mudança do publisher. O que se repete em todas as execuções é
a contenção no lock da wallet como fator dominante da latência.

### Template para novas execuções

```markdown
## Resultado — execução local

- Ambiente (CPU/RAM/disco):
- Instâncias da app:
- PostgreSQL (max_connections, pool por instância):
- Cenário: VUs=<n>, duração=<n>s, amount=<valor>
- Throughput: <req/s>
- p50 / p95 / p99 (ms):
- Taxa de erro HTTP:
- `wager_transactions_total` por status:
- `wager_idempotency_hits_total`:
- `db_lock_wait_seconds` p95:
- `db_lock_timeouts_total` / `db_deadlocks_total`:
- `outbox_pending` / `outbox_publish_lag_seconds`:
- `sqs_dlq_messages` / `sqs_dlq_oldest_message_age_seconds`:
- Observações e gargalos:
```

## Interpretação

- **`db_lock_wait_seconds` alto** indica contenção no hot wallet; avalie sharding
  por wallet, batching ou reduzir o tempo dentro da transação.
- **Throughput não cresce com VUs** (ex.: 86,2 req/s com 5 VUs vs 79,3 req/s com
  10 VUs) indica saturação; compare o lock wait médio do aquecimento com o do
  cenário principal antes de aumentar a carga.
- **`db_lock_timeouts_total`/`db_deadlocks_total` > 0** exige investigação; o
  cliente deve reenviar com a mesma `Idempotency-Key`, mas o objetivo é não
  depender disso.
- **`outbox_pending` crescendo** indica publisher abaixo da taxa de escrita;
  **`outbox_publish_lag_seconds` alto** confirma atraso. Ajuste
  `OUTBOX_PUBLISH_CONCURRENCY` (default 4, máximo 10) ou escale publishers. Em
  execução local; no Compose, adicione a variável ao `environment` do serviço
  `app`, conforme o aviso acima.
- **`sqs_dlq_messages`/idade** crescendo indicam mensagens não processadas.
- **`INSUFFICIENT_FUNDS`** em massa pode significar wallet sem saldo, não falha de
  infraestrutura.

O load test nunca deve rodar concorrentemente com as suítes de integração ou
concorrência, pois elas compartilham containers e bancos locais.
