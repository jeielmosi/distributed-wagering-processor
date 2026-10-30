# Distributed Wagering Processor

Processador de apostas distribuído com idempotência, consistência financeira e
mensageria assíncrona. Construído com **NestJS 12**, **Bun 1.4**, **TypeScript**,
**PostgreSQL 16**, **MikroORM 6** e **SQS FIFO** (LocalStack no ambiente local).

O enunciado original do desafio está preservado em [`CHALLENGE.md`](CHALLENGE.md).
As decisões de arquitetura, invariantes e trade-offs estão em
[`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Requisitos

- [Bun](https://bun.sh/) **1.4.x**
- Docker + Docker Compose v2
- (Opcional) k6 ou Docker com a imagem `grafana/k6` para o teste de carga

```bash
bun --version   # >= 1.4.0
docker compose version
```

---

## Setup rápido

```bash
# 1. Dependências
bun install --frozen-lockfile

# 2. Suba PostgreSQL, LocalStack, filas, migrations e a aplicação
docker compose up -d --build

# 3. Verifique
curl http://localhost:3000/health/ready
curl http://localhost:3000/metrics | head
```

O Compose sobe:

1. `postgres` e `localstack` com healthchecks;
2. `init-sqs` one-off (2 filas principais + 2 DLQs FIFO, com redrive de 5 receives);
3. `migrate` one-off (`bun run migration:up`);
4. `app` com `MESSAGING_ENABLED=1` (consumer, outbox e pending worker no mesmo
   processo, pool de 10 conexões).

`init-sqs` e `migrate` não dependem um do outro e podem rodar em paralelo; o
serviço `app` só inicia depois que ambos terminam.

Para derrubar tudo (mantendo os volumes):

```bash
docker compose down
```

Para remover também os dados locais:

```bash
docker compose down -v
```

A aplicação fica em `http://localhost:3000` (ou na porta definida em `APP_PORT`).
Cada resposta inclui `X-Instance-Id`; `X-Correlation-Id` é gerado quando ausente
e ecoado.

O Compose publica `app`, `postgres` e `localstack` apenas em `127.0.0.1`
(loopback), não em todas as interfaces. Isso reduz a exposição local, mas não
substitui o bloqueio de `/metrics` no proxy/rede de produção.

---

## Desenvolvimento local (sem container da app)

Com PostgreSQL e LocalStack já no ar (`docker compose up -d postgres localstack init-sqs`):

```bash
cp .env.example .env   # Bun carrega .env automaticamente
bun run migration:up
bun run dev
```

O `.env.example` aponta para o LocalStack local; `DATABASE_URL` fica comentado
porque o default da aplicação já usa `localhost` e o Compose define o host
`postgres` internamente. Para exercitar consumer/outbox/pending worker, ajuste
`MESSAGING_ENABLED=1`; as URLs default das filas são derivadas de `SQS_ENDPOINT`,
e credenciais de teste podem ser
`AWS_ACCESS_KEY_ID=test`/`AWS_SECRET_ACCESS_KEY=test`.

`bun run dev` usa `bun --watch src/main.ts`; `bun run start` executa `bun src/main.ts` sem watch. Para produção local:

```bash
bun run build
bun run start:prod   # bun dist/main.js
```

### Variáveis de ambiente principais

| Variável | Default | Função |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `INSTANCE_ID` | `<hostname>:<pid>` (app) / `app-1` (Compose) | identificador de instância em logs/métricas; o `.env.example` usa `local-dev` |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/wagering` | PostgreSQL |
| `SQS_ENDPOINT` | `http://localhost:4566` | endpoint LocalStack/AWS |
| `AWS_DEFAULT_REGION` | `us-east-1` | região AWS |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | credenciais |
| `SQS_WAGER_QUEUE_URL` | `<SQS_ENDPOINT>/000000000000/wager-transactions.fifo` | fila de entrada |
| `SQS_WAGER_DLQ_QUEUE_URL` | `<SQS_ENDPOINT>/000000000000/wager-transactions-dlq.fifo` | DLQ de entrada |
| `SQS_EVENTS_QUEUE_URL` | `<SQS_ENDPOINT>/000000000000/wagering-events.fifo` | destino da outbox |
| `SQS_EVENTS_DLQ_QUEUE_URL` | `<SQS_ENDPOINT>/000000000000/wagering-events-dlq.fifo` | DLQ de eventos |
| `SQS_VISIBILITY_TIMEOUT` | `60` | visibility da fila financeira (máx. `43200`) |
| `SQS_MAX_NUMBER_OF_MESSAGES` | `1` | lote do consumer (máx. `10`) |
| `SQS_CONSUMER_NAME` | `wager-transactions` | escopo do inbox |
| `SQS_CONSUMER_MAX_RECEIVE_COUNT` | `5` | limite aplicacional de receives antes da DLQ |
| `MESSAGING_ENABLED` | `0` | liga consumer/outbox/pending workers |
| `MESSAGING_POLL_INTERVAL_MS` | `1000` | intervalo de polling dos workers |
| `MESSAGING_DRAIN_TIMEOUT_MS` | `30000` | espera máxima no shutdown |
| `OUTBOX_LEASE_MS` | `30000` | lease de claim da outbox |
| `OUTBOX_BATCH_SIZE` | `10` | lote de claim da outbox |
| `OUTBOX_PUBLISH_CONCURRENCY` | `4` | publicações simultâneas da outbox (1–10) |
| `PENDING_LEASE_MS` | `30000` | lease de claim de referências pendentes |
| `PENDING_BATCH_SIZE` | `10` | lote de claim de referências pendentes |
| `METRICS_DLQ_ENABLED` | `MESSAGING_ENABLED` | liga coleta de gauges das DLQs |
| `METRICS_DLQ_INTERVAL_MS` | `15000` | intervalo da coleta das DLQs |
| `LOG_LEVEL` | `INFO` | `DEBUG`/`INFO`/`WARN`/`ERROR`/`SILENT` (case-insensitive) |
| `FAULT_AFTER_COMMIT_BEFORE_ACK` | `0` | injeção de crash entre commit e ack |
| `FAULT_AFTER_PUBLISH_BEFORE_MARK` | `0` | injeção de crash entre publish e mark da outbox |
| `MIGRATIONS_PATH` | `src/infrastructure/persistence/migrations` | diretório de migrations (Compose usa `dist/...`) |
| `RETENTION_INBOX_DAYS` | `30` | retenção de inbox processado para o purge opt-in |
| `RETENTION_OUTBOX_DAYS` | `90` | retenção de outbox publicado/dead-lettered para o purge opt-in |
| `RETENTION_BATCH_SIZE` | `1000` | lote do purge opt-in |

O default de `INSTANCE_ID` depende do contexto: a aplicação usa `<hostname>:<pid>`
quando a variável não existe, o Compose usa `app-1` quando ela não é definida, e
o `.env.example` (copiado para `.env` no setup local) define `local-dev`.

No Compose, o serviço `app` injeta explicitamente apenas um subconjunto dessas
variáveis. `OUTBOX_PUBLISH_CONCURRENCY`, `LOG_LEVEL`, `MESSAGING_POLL_INTERVAL_MS`
e outras não são repassadas pelo `docker-compose.yml`; ajuste o `environment` do
serviço `app` ou execute a aplicação fora do container para alterá-las.

Em AWS, defina `SQS_ENDPOINT` explicitamente (por exemplo,
`https://sqs.us-east-1.amazonaws.com`); o default é o LocalStack local.

---

## API

Autenticação não faz parte do escopo do desafio: o guard é no-op e todos os
endpoints são públicos. O ponto de extensão OIDC está descrito em
[`ARCHITECTURE.md`](ARCHITECTURE.md) §2.1.

### Criar wallet

```bash
curl -s -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "100.00", "currency": "BRL" }
  }'
```

`initialBalance` é obrigatório (inclusive `0.00`). Saldo inicial `> 0` cria um
`OPENING` interno e dois eventos de integração na outbox.

### Consultar wallet, ledger e reconciliação

```bash
curl -s http://localhost:3000/wallets/<walletId>
curl -s 'http://localhost:3000/wallets/<walletId>/ledger?limit=50'
curl -s -X POST http://localhost:3000/wallets/<walletId>/reconciliation
```

Além da reconciliação, o schema tem constraint triggers deferidos que exigem, no
commit, saldo/versão/moeda da wallet coerentes com a soma e a última entrada do
ledger, sem lacunas de `wallet_version`. Um `UPDATE` direto de saldo sem
lançamento correspondente ou um lançamento sem atualização da wallet falha no
commit.

### Processar transação (HTTP)

```bash
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-key-1' \
  -H 'X-Correlation-Id: corr-demo-1' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "ext-bet-1",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<walletId>",
    "roundId": "round-1",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "10.00", "currency": "BRL" }
  }'
```

Reenvie com a **mesma** `Idempotency-Key` (`demo-key-1` no exemplo) para replay
idempotente. A mesma key com payload diferente retorna `409`; a mesma key em
outro `providerId` é independente.

O `payload_hash` é SHA-256 hexadecimal de um JSON canônico com chaves ordenadas,
usando apenas os campos de negócio (`providerId`, `externalTransactionId`,
`playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e a referência quando
presente); header, correlação e metadados de transporte ficam fora. Detalhes em
[`ARCHITECTURE.md`](ARCHITECTURE.md#521-algoritmo-do-payload_hash).

Kinds: `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`. `REFUND`/`ROLLBACK` exigem
`referenceExternalTransactionId`; `WIN` exige referência a uma `BET` e sem ela é
rejeitado com `REFERENCE_REQUIRED` (422, sem crédito); `LOSS` aceita referência
opcional; `BET` não aceita. `OPENING` é rejeitado na API.

### Consultar transações

```bash
curl -s http://localhost:3000/wagering/transactions/<transactionId>
curl -s http://localhost:3000/providers/provider-a/wagering/transactions/ext-bet-1
```

### Health e métricas

```bash
curl -s http://localhost:3000/health/live
curl -s http://localhost:3000/health/ready
curl -s http://localhost:3000/metrics
```

- `/health/live`: processo vivo.
- `/health/ready`: `200` somente se PostgreSQL e as quatro URLs de fila
  (`wager`, `wager-dlq`, `events`, `events-dlq`) estiverem acessíveis; caso
  contrário `503` com `checks.postgres`/`checks.sqs`.
- `/metrics`: formato Prometheus (interno; não publicar na internet).

### Exposição de `/metrics`

`/metrics` não tem autenticação e é interno por contrato. O Compose publica a
app em `127.0.0.1:${APP_PORT:-3000}` (default 3000), o que evita exposição em
interfaces externas no ambiente local. Em produção, a regra deve estar no proxy ou na política de rede;
o health (`/health/live`, `/health/ready`) continua público. Exemplo de bloqueio
no nginx:

```nginx
location = /metrics {
    return 404;
}
```

Se o monitoramento precisar coletar as métricas, exponha `/metrics` apenas na
rede interna/VPC ou em um listener administrativo separado, nunca na porta
pública da API.

---

## Mensageria (SQS)

Com `MESSAGING_ENABLED=1`, o processo roda consumer, outbox e pending worker. O
publisher da outbox processa o lote claimado com até
`OUTBOX_PUBLISH_CONCURRENCY` publicações simultâneas (default `4`). O inbox
deduplica pelo hash canônico dos campos de negócio, então JSON reordenado sob o
mesmo `messageId` não é tratado como payload divergente. Updates de estado da
outbox (`published_at`, retry e dead-letter) são condicionais a
`published_at IS NULL AND dead_lettered_at IS NULL`, impedindo que um publisher
atrasado ressuscite uma mensagem já concluída.

### Enviar uma mensagem de teste

Crie um arquivo `mensagem.json`:

```json
{
  "messageId": "msg-demo-1",
  "type": "WagerTransactionRequested",
  "correlationId": "corr-demo-2",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "ext-sqs-1",
    "idempotencyKey": "idem-sqs-1",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<walletId>",
    "roundId": "round-sqs",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "5.00", "currency": "BRL" }
  }
}
```

```bash
bun run sqs:send -- --wallet <walletId> --file mensagem.json
```

O helper usa `MessageGroupId=walletId` e `MessageDeduplicationId=SHA-256(messageId)`.

### Filas

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | entrada de transações |
| `wager-transactions-dlq.fifo` | poison/permanente da entrada |
| `wagering-events.fifo` | eventos publicados pela outbox |
| `wagering-events-dlq.fifo` | eventos que excederam retries/claims |

As duas filas principais têm redrive de 5 receives; as DLQs são apenas destino.
Falhas de negócio depois que a linha pode ser criada (por exemplo
`INSUFFICIENT_FUNDS` e os `REFERENCE_*`) são persistidas como `REJECTED` + evento
e recebem ack; `PENDING_REFERENCE` publica evento e recebe ack sem `REJECTED`.
Falhas pré-linha/estruturais (`INVALID_PAYLOAD`, `OPENING_NOT_ALLOWED`,
`WALLET_NOT_FOUND` no SQS, etc.) não persistem transação e vão para a DLQ;
`WALLET_NOT_FOUND` no HTTP continua `422`. Erros permanentes pós-linha viram
`FAILED` (sem evento); erros `UNKNOWN` são persistidos como `FAILED` e também
enviados à DLQ. Detalhes em [`ARCHITECTURE.md`](ARCHITECTURE.md) §4.4.

---

## Métricas: como interpretar

| Métrica | O que observar |
|---|---|
| `wager_transactions_total{status}` | volume por status; `REJECTED`/`FAILED` crescendo indica regra de negócio ou infra |
| `wager_transaction_processing_seconds` | p50/p95/p99 de processamento (HTTP/SQS/pending) |
| `wager_idempotency_hits_total` | replays; alto volume é normal com retry de cliente |
| `wager_inbox_duplicates_total{outcome}` | duplicatas de inbox no consumer: `DUPLICATE` (replay) e `PAYLOAD_MISMATCH` (DLQ) |
| `wager_retries_total{worker}` | retries por `CONSUMER`/`OUTBOX`/`PENDING_REFERENCE` |
| `wager_dlq_messages_sent_total{queue}` | envios diretos para `WAGER_TRANSACTIONS`/`WAGERING_EVENTS` |
| `sqs_dlq_messages` / `sqs_dlq_oldest_message_age_seconds` | mensagens visíveis aproximadas e idade da mais antiga; não inclui em voo/delayed; idade alta = mensagem esquecida |
| `outbox_pending` / `outbox_dead_lettered` | backlog da outbox e eventos mortos |
| `outbox_publish_lag_seconds` | atraso entre `occurred_at` e `published_at` |
| `reconciliation_divergences_total` | qualquer valor > 0 exige investigação |
| `wager_preline_failures_total{failureCode,httpStatus}` | falhas antes de criar a transação (payload, wallet, conflito, transitório) |
| `wager_uncorrelated_wins_total` | `WIN` sem referência rejeitado com `REFERENCE_REQUIRED` |
| `db_lock_wait_seconds` | contenção no hot wallet |
| `db_lock_timeouts_total` | `55P03`; cliente deve reenviar com a mesma key |
| `db_deadlocks_total` | `40P01`; indica padrão de acesso conflitante |

As gauges de DLQ incluem `collector_instance`; o Prometheus deve agregar com
`max`/`avg` por `queue`. O registry também adiciona `service_instance`. Ambos os
labels usam `INSTANCE_ID` quando definido e `hostname:pid` caso contrário, então
são estáveis entre restarts com `INSTANCE_ID` fixo e devem ser agregados ou
removidos no scrape; não há labels de domínio de alta cardinalidade
(`walletId`, `transactionId`, `providerId`).

`wager_transactions_total` conta **transições persistidas**, não transações
distintas: uma transação que passa por `PENDING_REFERENCE` e depois `PROCESSED`
aparece nos dois status.

Sugestão de consultas:

```promql
sum by (status) (rate(wager_transactions_total[5m]))
histogram_quantile(0.95, sum by (le) (rate(wager_transaction_processing_seconds_bucket[5m])))
max by (queue) (sqs_dlq_messages)
max by (queue) (sqs_dlq_oldest_message_age_seconds)
outbox_pending
histogram_quantile(0.95, sum by (le) (rate(db_lock_wait_seconds_bucket[5m])))
```

Logs são JSON de uma linha e podem ser filtrados por `correlationId`,
`transactionId`, `walletId`, `providerId` e `messageId`. Chaves sensíveis são
redigidas e erros do consumer são reduzidos a metadados (`errorName`,
`failureCode`, `code`, `constraint`), incluindo `cause` quando a falha do driver
foi traduzida na borda de persistência; valores monetários nunca são logados.

---

## Comandos

```bash
# Ambiente
docker compose up -d --build
docker compose down
docker compose down -v

# Build & qualidade
bun run build            # tsc -> dist
bun run start            # bun src/main.ts (sem watch, sem build)
bun run start:prod       # bun dist/main.js (requer build)
bun run lint
bun run typecheck
bun run format:check

# Migrations (versionadas; SQL/constraints são revisados à mão)
bun run migration:create <nome> # cria uma migration em branco para editar
bun run migration:up
bun run migration:down

# Ordem atual (prefixo é apenas identificador de ordenação):
# 1. Migration20261026120000 — schema base: wallets, wager_transactions,
#    wallet_ledger_entries, inbox_messages, outbox_messages e triggers
# 2. Migration20261026190000 — constraints de saldo, FK composta de referência
#    e trigger de imutabilidade de estado terminal
# 3. Migration20261027120000 — tabelas de arquivo do purge de inbox/outbox
# 4. Migration20261027120001 — invariante wallet↔ledger no commit
# 5. Migration20261027130000 — failure code REFERENCE_REQUIRED
# 6. Migration20261027140000 — constraints das tabelas de arquivo

# SQS
bun run sqs:send -- --wallet <walletId> --file <mensagem.json>

# Retenção (opt-in; dry-run por padrão)
bun run retention:purge
bun run retention:purge -- --execute

# Testes
bun run test             # suíte completa (unit + integração + concorrência + smoke + e2e)
bun run test:unit        # domínio/use cases/services/observabilidade
bun run test:integration # PostgreSQL + LocalStack reais (Testcontainers)
bun run test:e2e         # end-to-end (bootstrap, HTTP e observabilidade)
bun run test:e2e:http    # apenas HTTP ponta a ponta
bun run test:concurrency # 3 processos Bun + 4º crash (22 testes: cenários 5.1–5.9 e 5.12–5.19, com subcenários 5.6b/5.6c)
bun run test:smoke       # cadeia determinística completa + reconciliação
bun run test:load        # k6 local (opcional; ver LOAD_TEST.md)
bun run test:load:docker # k6 via container oficial (sem instalar k6)
bun run test:load:full   # stack + wallet + aquecimento + cenário + métricas + reconciliação
```

Os testes de integração/concorrência exigem Docker e baixam imagens de PostgreSQL
e LocalStack na primeira execução. O smoke usa PostgreSQL real; o caminho SQS é
coberto pela suíte de integração. `test:e2e` cobre apenas bootstrap/HTTP/
observabilidade; use `bun run test` para a suíte completa.

---

## Retenção e arquivamento

O expurgo é **opt-in** e roda em dry-run por padrão:

```bash
bun run retention:purge                         # apenas conta elegíveis
bun run retention:purge -- --execute            # arquiva e remove
bun run retention:purge -- --execute --inbox-days 30 --outbox-days 90
```

- Inbox: apenas mensagens com `processed_at` anterior ao cutoff.
- Outbox: apenas mensagens publicadas ou dead-lettered antes do cutoff.
- `wallet_ledger_entries` e `wager_transactions` nunca são apagados.
- Cada lote é arquivado em `*_archive` e removido na mesma transação.
- As tabelas de arquivo mantêm CHECKs de hash, tamanhos, datas, contadores e
  exclusividade entre `published_at` e `dead_lettered_at`.
- Defaults: inbox 30 dias, outbox 90 dias, lote 1000.

---

## Teste de carga (opcional)

O teste de carga é um diferencial e **não faz parte da suíte padrão**. Pré-requisitos
comuns:

1. Bun 1.4.x, `curl` e `jq` no host;
2. k6 instalado (`https://k6.io/docs/get-started/installation/`) **ou** Docker para
   usar a imagem oficial `grafana/k6`;
3. Docker + Docker Compose v2 para subir a stack.

Fluxo automatizado (sobe a stack, cria a wallet e roda tudo):

```bash
bun run test:load:full
```

O fluxo automatizado não exige wallet prévia. Para o fluxo manual, suba a stack com
`docker compose up -d --build` (a app fica em `127.0.0.1:${APP_PORT:-3000}`, default
3000) e informe uma wallet com saldo suficiente; o provider padrão é `provider-load`
e pode ser alterado por `K6_PROVIDER_ID`.

```bash
# k6 local
K6_BASE_URL=http://localhost:3000 \
K6_PLAYER_ID=<uuid> K6_WALLET_ID=<uuid> \
bun run test:load

# sem k6 no host (Linux, --network host)
K6_BASE_URL=http://localhost:3000 \
K6_PLAYER_ID=<uuid> K6_WALLET_ID=<uuid> \
bun run test:load:docker
```

Metodologia, ambiente, resultados da execução e como preencher
`LOAD_TEST.md` estão em [`LOAD_TEST.md`](LOAD_TEST.md). Execute somente com o core
verde e sem concorrência com outras suítes.

---

## Estrutura

```
src/
├── domain/            # Money, Wallet, Ledger, WagerTransaction, eventos
├── application/       # use cases, ports, services
├── infrastructure/    # MikroORM, SQS, observabilidade
├── presentation/      # controllers, DTOs, filtros, interceptors
└── shared/            # UUIDv7, hash canônico, ISO-4217, erros
test/
├── integration/       # HTTP, persistência, mensageria, observabilidade
├── concurrency/       # 3 processos Bun + crash
├── smoke/             # cadeia determinística + reconciliação
├── support/           # utilitários de log compartilhados
└── app.e2e.spec.ts    # bootstrap, headers e health

scripts/               # migrations, init-sqs, sqs:send e load-test
load/                  # k6.js e resultados locais (ignorados pelo Git)
```

## Avaliação — critério → evidência

| Área (CHALLENGE §14) | Implementação | Evidência de teste |
|---|---|---|
| Correção financeira (20) | `src/domain/money/money.ts`, `src/domain/wallet`, `src/domain/ledger`, `src/application/use-cases/reconcile-wallet.use-case.ts` | `src/domain/money/money.spec.ts`, `src/domain/ledger/wallet-ledger-entry.spec.ts`, `test/integration/wagering-api.e2e.spec.ts`, `test/concurrency/wagering-concurrency.spec.ts` (5.9, 5.14) |
| Concorrência (20) | lock pessimista por wallet em `src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.ts`; ledger e wallet na mesma transação | `test/concurrency/wagering-concurrency.spec.ts` (22 testes: cenários 5.1–5.9 e 5.12–5.19, com subcenários 5.6b/5.6c), incluindo 3 processos Bun, 50 apostas, disputa de saldo e settlements concorrentes |
| Idempotência (15) | `src/application/services/idempotency.service.ts`, `src/domain/messaging/inbox-message.ts`, índices únicos da migration | `src/application/services/idempotency.service.spec.ts`, `test/integration/wagering-api.e2e.spec.ts`, `test/integration/sqs-messaging.spec.ts` (redelivery, payload divergente, 50 duplicatas concorrentes) |
| Mensageria e falhas (15) | `src/infrastructure/messaging/wager-transaction.consumer.ts`, `outbox-publisher.worker.ts`, `pending-reference.worker.ts`, outbox transacional | `test/integration/sqs-messaging.spec.ts` (DLQ direta, redrive 5 receives, outbox, pending reference), `test/concurrency/wagering-concurrency.spec.ts` (crash pós-commit, SIGTERM com mensagem em voo) |
| Modelagem e arquitetura (10) | `src/domain`, `src/application/ports` (`LoggerPort`/`MetricsPort`/`ReadinessPort`/`PersistenceErrorTranslatorPort`), use cases e adapters; invariantes encapsuladas | `ARCHITECTURE.md` (§4–§6), `src/application/architecture.spec.ts` (fronteiras application/presentation/domain/shared) e testes de domínio/use case em `src/**/*.spec.ts` |
| Testes (10) | unitários, integração com PostgreSQL/LocalStack reais, concorrência com processos reais, smoke e e2e | `bun run test:unit`, `bun run test:integration`, `bun run test:concurrency`, `bun run test:smoke`, `bun run test:e2e` e `bun run test` |
| Observabilidade (5) | `src/infrastructure/observability/metrics.ts`, `structured-logger.ts`, `safe-error.ts`, `readiness.service.ts`, `/metrics`, `/health/live`, `/health/ready` | `src/infrastructure/observability/metrics.spec.ts`, `structured-logger.spec.ts`, `wager-transaction.consumer.spec.ts` (não vazamento de valor), `readiness.service.spec.ts`, `test/integration/observability.e2e.spec.ts` |
| Documentação (5) | `README.md`, `ARCHITECTURE.md`, `LOAD_TEST.md` | esta matriz + seções de setup, API, mensageria, métricas e trade-offs |

### Interpretação explícita da regra 7.4

O CHALLENGE diz que uma referência não pode ser revertida duas vezes **pelo mesmo
tipo** de operação. A implementação é intencionalmente mais restritiva: o índice
`uq_wager_tx_reversal` é único por `reference_transaction_id` para `REFUND` **ou**
`ROLLBACK` `PROCESSED`, então uma `BET` já revertida por `REFUND` também não pode
ser revertida por `ROLLBACK` (e vice-versa). Reverter o mesmo movimento duas
vezes produziria crédito/débito duplicado; o comportamento conservador está
documentado em `ARCHITECTURE.md` (§6.2 e §12) e fixado pelo teste
`7.4: reversão única por alvo vale entre REFUND e ROLLBACK` em
`test/integration/wagering-api.e2e.spec.ts`.

---

## Documentos

- [`CHALLENGE.md`](CHALLENGE.md) — enunciado original preservado.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — decisões, invariantes, trade-offs e limitações.
- [`LOAD_TEST.md`](LOAD_TEST.md) — metodologia do teste de carga.
