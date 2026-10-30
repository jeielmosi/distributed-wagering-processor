# Arquitetura — Distributed Wagering Processor

Documento de decisões técnicas, invariantes e trade-offs do processador de apostas.
O enunciado original está preservado em [`CHALLENGE.md`](CHALLENGE.md); o guia de
execução está em [`README.md`](README.md).

---

## 1. Visão geral

O sistema é um monólito modular NestJS com fronteiras **DDD + Hexagonal**:

```
src/
├── domain/            # entidades, value objects e eventos; sem NestJS/MikroORM/AWS SDK
├── application/       # use cases, ports e services de aplicação
├── infrastructure/    # adapters: MikroORM, SQS, observabilidade, auth no-op
├── presentation/      # controllers HTTP, DTOs, filtros e interceptors
└── shared/            # UUIDv7, hash canônico, ISO-4217, taxonomia de erros
```

```
HTTP ──► Controller ──► ProcessWagerTransactionUseCase ──► Wallet + Ledger + Tx + Outbox
SQS  ──► Consumer ────► (mesmo use case, mesmo EntityManager, Inbox insert-first)
                            │
                            ├─ PostgreSQL (fonte da verdade)
                            └─ Outbox Worker ──► wagering-events.fifo
Pending Worker ──► ResolvePendingReferenceUseCase ──► mesma transação financeira
```

A **fonte da verdade é o PostgreSQL**. SQS é transporte e a Outbox é o único caminho
de publicação de eventos de integração. Nenhuma decisão financeira depende de estado
efêmero em memória, fila ou cache.

### Princípios

- Domínio puro: `domain/` importa apenas `decimal.js` e utilitários de `shared/`.
- Use cases dependem de **ports** (`application/ports/`) para repositórios, relógio,
  logging, métricas, readiness e tradução de erros; nunca de adapters.
- `application/` e `presentation/` não importam `infrastructure/`. O binding das
  portas e a composição dos adapters ficam no composition root (`app.module.ts`,
  `main.ts` e `configure-app.ts`), sempre via tokens.
- Detalhes do PostgreSQL (SQLSTATE, nome de constraint) ficam restritos à
  infraestrutura: o `MikroOrmUnitOfWork` traduz falhas do driver para erros
  semânticos da aplicação antes de cruzar a fronteira.
- Invariantes são garantidas em dois níveis: no modelo de domínio **e** no schema
  relacional (CHECKs, FKs, índices parciais e triggers).
- Uma transação SQL encapsula Inbox + lock da wallet + Ledger + WagerTransaction +
  Outbox. Não existe escrita financeira fora desse limite.

---

## 2. Stack e justificativas

| Decisão | Escolha | Justificativa |
|---|---|---|
| Runtime | Bun 1.4 + TypeScript 5.9 strict | `Bun.randomUUIDv7()` nativo, test runner rápido, execução direta de TypeScript |
| Build | `tsc` (`tsconfig.build.json`) → `bun dist/main.js` | Build determinístico; runtime Bun em produção |
| Framework | NestJS 12 | DI, módulos, pipes/filtros/interceptors |
| ORM | MikroORM 6 | Unit of Work, Identity Map, `LockMode.PESSIMISTIC_WRITE`, migrations versionadas |
| Banco | PostgreSQL 16 | Constraints/índices parciais/triggers, `FOR UPDATE SKIP LOCKED`, `REPEATABLE READ` |
| Decimal | `decimal.js` | Precisão financeira sem `number`/float |
| Fila | SQS FIFO no LocalStack | Semântica AWS fiel, DLQ e redrive |
| Métricas | `prom-client` | Registry padrão Prometheus |
| Auth | Guard no-op | Não pontua no desafio; ponto de extensão documentado |

O adaptador oficial `@mikro-orm/nestjs` 6.x é CJS e incompatível com NestJS 12 ESM.
Foi substituído por `src/infrastructure/persistence/mikro-orm.module.ts`, que expõe
`MIKRO_ORM` e integra o `EntityManager` ao ciclo de vida do Nest. É a única
divergência consciente do plano.

O build usa `tsc` (`tsconfig.build.json`) com `experimentalDecorators`,
`emitDecoratorMetadata` e `useDefineForClassFields: false`; `reflect-metadata` é
carregado no `main.ts`. `class-validator`/`class-transformer` rodam no
`ValidationPipe` global com `whitelist`, `forbidNonWhitelisted`, `transform` e
`enableImplicitConversion: false`. Em produção, `bun dist/main.js`; em dev,
`bun --watch src/main.ts`.

O Compose sobe PostgreSQL e LocalStack com healthchecks, `init-sqs` one-off
idempotente (2 filas principais + 2 DLQs FIFO, redrive 5) e `migrate` one-off;
`init-sqs` e `migrate` podem executar em paralelo, e o `app` depende de ambos
concluídos e dos serviços saudáveis.

### 2.1 Autenticação — decisão e desenho de extensão

Autenticação **não** é implementada, pois não pontua no CHALLENGE e competiria com
correção financeira. O ponto de extensão está explícito em
`src/infrastructure/auth/noop-auth.guard.ts`, registrado como `APP_GUARD`; ele
permite todas as requisições e pode ser substituído sem tocar em domínio/use cases.

Desenho que seria adotado com um IdP externo (Keycloak/Zitadel via OIDC):

1. O guard valida o JWT (issuer, audience, assinatura via JWKS e expiração) ou
   delega ao API gateway; nenhum segredo fica hardcoded.
2. Claims `sub`/`provider_id`/`roles` são mapeadas para um `ProviderIdentityPort`
   (`application/ports/`), que o adapter OIDC implementa.
3. O `providerId` do payload SQS/HTTP é confrontado com a identidade autenticada
   quando a origem é externa; mensagens SQS são canal interno confiável, mas as
   validações de domínio de provider/player/wallet/round continuam valendo.
4. Health (`/health/live`, `/health/ready`) permanece público; `/metrics` fica
   restrito à rede interna, não a um papel de usuário.
5. Erros de autenticação usariam o mesmo envelope (`401`/`403`), sem vazar
   detalhes do token.

Nenhuma tabela local de usuários/senhas seria criada.

---

## 3. Domínio

### 3.1 Money

- Value object imutável, **assinado internamente**, com `decimal.js`.
- `Money.from` e os contratos de entrada **rejeitam negativo**; `negate()`,
  `subtract()` e `difference` produzem os negativos usados apenas em contextos
  internos (reconciliação e aritmética assinada).
- **Sem arredondamento:** mais de 2 casas decimais é erro. O domínio nunca trunca,
  arredonda ou “conserta” entrada. Valores negativos, `NaN`, `Infinity`, notação
  científica, string vazia, overflow de `NUMERIC(18,2)` e moeda fora da allowlist
  ISO-4217 são rejeitados.
- `Wallet` e `WalletLedgerEntry` exigem valores/saldos não-negativos. O sinal
  financeiro é expresso por `LedgerDirection` (`DEBIT`/`CREDIT`).
- `Money` aceita `0.00`; `Wallet.open` aceita saldo inicial `0.00`; transações
  (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) exigem valor `> 0`.
- Serialização canônica: `{ amount: "25.00", currency: "BRL" }`.
- Na entrada, 1 ou 2 casas são aceitas e normalizadas para 2 (`"25"`/`"25.5"` → `"25.00"`/`"25.50"`); mais de 2 casas é erro, sem arredondamento. O contrato de saída é sempre 2 casas.

### 3.2 Wallet e ledger

- `Wallet` é o aggregate root; `debit`/`credit` co-criam o `WalletLedgerEntry`,
  garantindo que nenhuma mudança de saldo exista sem lançamento correspondente.
- `version` inicia em `1` e incrementa a cada mudança de saldo.
- `WalletLedgerEntry.walletVersion` é a versão **após** a movimentação e forma uma
  cadeia consecutiva por wallet (`UNIQUE (wallet_id, wallet_version)`).
- Com `OPENING`, o primeiro lançamento tem `walletVersion = 1`; sem `OPENING`
  (saldo inicial `0.00`), o primeiro lançamento tem `walletVersion = 2`.
- O ledger é imutável: triggers `BEFORE UPDATE OR DELETE` e `BEFORE TRUNCATE`
  bloqueiam alterações físicas.
- A correspondência wallet↔ledger também é verificada no commit por constraint
  triggers deferidos (detalhes em §4.3.1).

### 3.3 WagerTransaction

Estados: `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`.
Kinds: `OPENING`, `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`.

- Transições só saem de estados não-terminais; terminal → `InvalidTransactionStateError`.
- `PROCESSED` guarda snapshot histórico de `balanceAfter` para replay fiel.
- `resolvedAt` é preenchido em `PROCESSED`/`REJECTED`/`FAILED` e nulo em
  `PENDING_REFERENCE`.
- `PENDING` existe no enum/contrato, mas o fluxo single-transaction não o persiste.
- `OPENING` é interno: criado apenas por `CreateWalletUseCase`, com
  `provider_id`/`external_transaction_id`/`round_id`/`game_id` nulos,
  `idempotency_key = internal:opening:{walletId}` e `walletVersion = 1`.
  Emite `WagerTransactionProcessed` (campos de provedor nulos) +
  `WalletBalanceChanged`. Sentinelas vazias não vazam para eventos/consultas.

### 3.4 Eventos de integração

Envelope: `eventId` (UUIDv7), `aggregateId`, `correlationId`, `causationId?`,
`occurredAt` (relógio do PostgreSQL), `version = 1`, `data`.

| Transição | Eventos |
|---|---|
| `PROCESSED` (BET/WIN/REFUND/ROLLBACK) | `WagerTransactionProcessed` + `WalletBalanceChanged` |
| `PROCESSED` (LOSS) | `WagerTransactionProcessed` (sem mudança de saldo) |
| `PROCESSED` (OPENING) | `WagerTransactionProcessed` (provider nulo) + `WalletBalanceChanged` |
| `PENDING_REFERENCE` | `WagerTransactionPendingReference` |
| `REJECTED` | `WagerTransactionRejected` |
| `FAILED` | nenhum evento; auditável por `failure_code`/`resolved_at` |

### 3.5 Taxonomia de falhas

Lista formal em `src/shared/errors/failure-code.ts` e CHECK no banco. Principais
grupos: saldo (`INSUFFICIENT_FUNDS`, `INSUFFICIENT_FUNDS_FOR_REVERSAL`),
referência (`REFERENCE_REQUIRED`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`,
`REFERENCE_ALREADY_REVERTED`, `REFERENCE_ALREADY_SETTLED`,
`REFERENCE_HAS_PROCESSED_WIN`, `REFERENCE_AMOUNT_MISMATCH`,
`REFERENCE_CONTEXT_MISMATCH`, `INVALID_REFERENCE_KIND`), idempotência
(`IDEMPOTENCY_PAYLOAD_MISMATCH`, `DUPLICATE_EXTERNAL_TRANSACTION`), wallet
(`WALLET_NOT_FOUND`, `WALLET_PLAYER_MISMATCH`, `WALLET_ALREADY_EXISTS`),
consulta (`TRANSACTION_NOT_FOUND`, apenas HTTP; `ROUTE_NOT_FOUND` para rotas
inexistentes), estrutura (`INVALID_PAYLOAD`,
`OPENING_NOT_ALLOWED`, `CURRENCY_MISMATCH`) e infraestrutura
(`TRANSIENT_INFRA_FAILURE` para 503, não persistido; `PERMANENT_INFRA_FAILURE`
para `FAILED`/500, persistido).

`WALLET_NOT_FOUND` tem status dependente do contexto: no
`POST /wagering/transactions` é rejeição de negócio (`422`); em consultas (`GET`)
é recurso inexistente (`404`).

---

## 4. Persistência

### 4.1 MikroORM, pool e timeouts

- Pool `max = 10` por instância (API + consumer + outbox + pending compartilham o
  mesmo pool), `acquireTimeoutMillis = 5000`, `idleTimeoutMillis = 30000`.
- Cálculo com 3 réplicas: `3 × 10 = 30` conexões de aplicação. O `migrate` one-off
  pode abrir mais conexões durante o deploy; o `consumer-crash` de teste adiciona
  mais 10. Pior caso observado em dev/test: **~50 conexões** contra
  `max_connections = 100` do PostgreSQL 16. Em produção, dimensionar
  `max_connections ≥ réplicas × 10 + margem operacional`.
- `SET LOCAL lock_timeout = '10s'` e `statement_timeout = '30s'` em toda transação
  financeira. Esperas no hot wallet viram erro transitório `55P03` (`503`).
- A reconciliação usa `statement_timeout = 60s` porque é read-only e varre o ledger
  inteiro em `REPEATABLE READ`.
- Migrations versionadas, transacionais e reversíveis (`migration:up`/`down`):
  `Migration20261026120000` (schema base), `Migration20261026190000` (constraints
  de saldo, FK composta de referência e trigger de imutabilidade terminal),
  `Migration20261027120000` (tabelas `*_archive` para o purge opt-in de
  inbox/outbox), `Migration20261027120001` (invariante wallet↔ledger deferida),
  `Migration20261027130000` (`REFERENCE_REQUIRED`) e `Migration20261027140000`
  (constraints das tabelas de arquivo).
- Falhas do driver são traduzidas no `MikroOrmUnitOfWork` para erros semânticos
  (`TransientFailureError`, `UniqueConstraintConflictError`,
  `InvalidPersistenceDataError`, `PersistenceFailureError`), com a causa original
  preservada em `cause`. Os helpers `postgres-error.ts` e `database-constraint.ts`
  vivem em `infrastructure/persistence/postgres/`.

### 4.2 Relógio canônico

`occurredAt`, `created_at`, `updated_at`, `received_at`, `next_attempt_at`,
`reference_last_attempt_at` e `resolved_at` usam `now()` do PostgreSQL via port
`Clock` (`SELECT now()` na mesma transação). O defer de referência pendente
recebe o instante do `Clock` explicitamente, em vez de chamar `now()` no SQL.
Isso elimina clock skew entre instâncias e evita violar o CHECK
`next_attempt_at >= occurred_at` da outbox.

### 4.3 Schema, constraints e triggers

Principais barreiras estruturais:

- `wallets`: saldo `>= 0`, `version >= 1`, UNIQUE `(player_id, currency)`.
- `wager_transactions`:
  - UNIQUE `(provider_id, external_transaction_id)`; idempotência por provider via
    índices parciais `uq_wager_tx_idempotency_provider` e
    `uq_wager_tx_idempotency_opening`; no máximo um `OPENING` por wallet.
  - `uq_wager_tx_reversal`: uma transação-alvo é revertida no máximo uma vez por
    qualquer kind de reversão.
  - `uq_wager_tx_settlement`: no máximo um `WIN`/`LOSS` `PROCESSED` por
    `(provider_id, reference_external_transaction_id)`. Cobre múltiplos `WIN` e a
    corrida `WIN` × `LOSS` sem FK.
  - CHECKs de kind/estado/aridade, tamanhos `1..255`, `payload_hash` `CHAR(64)`,
    `amount > 0`, `balance_after` consistente, `resolved_at`/`failure_code` por
    estado, e agendamento de referência apenas em `PENDING_REFERENCE`.
  - `chk_wager_tx_balance_after_non_negative`: o snapshot
    `balance_after_amount` também é `>= 0` no banco.
  - FK composta `UNIQUE (wallet_id, id)` suporta a FK do ledger.
  - `fk_wager_tx_reference_wallet`: a referência auto-relacionada é validada no
    banco por `(wallet_id, reference_transaction_id)`, impedindo referência
    cross-wallet mesmo por escrita direta.
- `wallet_ledger_entries`: FK composta ledger ↔ transação, UNIQUE
  `(wallet_id, transaction_id)` e `(wallet_id, wallet_version)`, CHECK aritmético
  DEBIT/CREDIT e saldos `>= 0`.
- Invariante wallet↔ledger no schema: constraint triggers deferidos em `wallets`
  (INSERT/UPDATE) e `wallet_ledger_entries` (INSERT) exigem, no commit, que o
  saldo/versão da wallet coincidam com a soma e a última entrada do ledger. Um
  UPDATE direto de saldo sem lançamento, ou um lançamento sem atualização da
  wallet, falham no commit.
- `inbox_messages`: PK `(consumer_name, message_id)`, `payload_hash` `CHAR(64)`;
  mesmo messageId com payload de negócio divergente é conflito/DLQ, nunca ack
  silencioso. O hash usa o JSON canônico dos campos de negócio parseados, não o
  body bruto, para ser insensível a ordem de chaves e formatação.
- `outbox_messages`: `next_attempt_at` NOT NULL, `attempts`, `claim_count`,
  `published_at`, `dead_lettered_at`, `last_error`, índice parcial de pendentes.
- `inbox_messages_archive`/`outbox_messages_archive`: mantêm os mesmos CHECKs de
  tamanho, hash, aritmética de datas, contadores e exclusividade
  `published_at`/`dead_lettered_at` aplicáveis às linhas arquivadas.
- `wager_transactions` em estado terminal (`PROCESSED`/`REJECTED`/`FAILED`) é
  imutável no banco: `trg_prevent_terminal_wager_transaction_modification` bloqueia
  UPDATE/DELETE depois da transição terminal.
- Triggers `set_updated_at()` em wallets/transações; triggers de imutabilidade do
  ledger para UPDATE/DELETE/TRUNCATE.

#### 4.3.1 Invariante wallet↔ledger deferida

A migration `Migration20261027120001` instala a função
`assert_wallet_ledger_consistency()` e dois constraint triggers
`DEFERRABLE INITIALLY DEFERRED`:

- `trg_wallets_ledger_consistency` em `wallets` (INSERT/UPDATE);
- `trg_ledger_wallet_consistency` em `wallet_ledger_entries` (INSERT).

No commit, para a wallet afetada, o banco exige:

1. `wallet.balance_amount = SUM(CREDIT) - SUM(DEBIT)`;
2. `wallet.version = última wallet_ledger_entries.wallet_version`;
3. `wallet.balance_amount = última balance_after_amount`;
4. moeda da wallet = moeda da última entrada;
5. sequência de `wallet_version` sem lacunas
   (`max - min + 1 = count`).

Assim, um `UPDATE` direto em `wallets.balance_amount` sem lançamento, um
lançamento sem atualização correspondente da wallet ou uma cadeia com versão
faltante falham no commit. O caminho normal da aplicação (wallet + ledger na
mesma transação) passa; fixtures de teste criam o `OPENING` correspondente.
A cobertura está em `test/integration/persistence-schema.spec.ts`
(`invariante wallet↔ledger é verificada no commit`) e nos testes de repositório.

### 4.4 Falha terminal (`FAILED`) e auditabilidade

| Estado terminal | Quem produz | Como fica auditável |
|---|---|---|
| `PROCESSED` | `ProcessWagerTransactionUseCase` / `ResolvePendingReferenceUseCase` | `processed_at`, `resolved_at`, `balance_after`, evento `WagerTransactionProcessed` |
| `REJECTED` | use case/worker após a linha ser criável | `failure_code`, `resolved_at`, evento `WagerTransactionRejected`, outbox |
| `FAILED` | **pós-linha**: erro inesperado/permanente com banco disponível; rollback da tx original e **nova tx** grava `FAILED` | `failure_code = PERMANENT_INFRA_FAILURE`, `resolved_at`; sem evento de integração |
| Sem transação | erro pré-linha/estrutural no SQS | DLQ + ack; `last_error`/logs/métricas; nenhum `transactionId` |
| Transitório | lock timeout/deadlock/serialização/timeout/conexão | sem terminal persistido no HTTP (`503`); no SQS retry/visibility; no pending worker backoff curto |

Regra única: toda falha de negócio **depois que a linha pode ser criada**
(`INSUFFICIENT_FUNDS`, `INSUFFICIENT_FUNDS_FOR_REVERSAL`, todos os `REFERENCE_*`)
persiste `REJECTED` + evento na mesma transação. Falhas antes da linha
(`OPENING_NOT_ALLOWED`, `INVALID_PAYLOAD`, `WALLET_NOT_FOUND`,
`WALLET_PLAYER_MISMATCH`, `CURRENCY_MISMATCH`, `IDEMPOTENCY_PAYLOAD_MISMATCH`,
`DUPLICATE_EXTERNAL_TRANSACTION`) não persistem nem emitem evento.

Erros `UNKNOWN` (não classificados como transitórios, permanentes ou conflito)
são uma decisão explícita: a linha é persistida como `FAILED` **e** a mensagem é
enviada à DLQ, sem retry automático. Repetir um erro de programação determinístico
apenas queimaria tentativas; a evidência fica em `failure_code`, na DLQ, em logs
estruturados e em métricas. O limite de tentativas do broker
(`maxReceiveCount = 5`) é espelhado no consumer
(`SQS_CONSUMER_MAX_RECEIVE_COUNT`, default `5`) como defesa em profundidade para
configuração incorreta da fila.

---

## 5. Concorrência e idempotência

### 5.1 Lock pessimista por wallet

- `SELECT ... FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`) restrito à `walletId`,
  dentro da transação financeira, com `lock_timeout = 10s`.
- Não há lock global de tabela nem lock de duas wallets na mesma transação.
  Wallets distintas processam em paralelo; a mesma wallet serializa naturalmente.
- O lock é a garantia contra double-spend; o FIFO por wallet é apenas otimização.

### 5.2 Idempotência

- Escopo: `(provider_id, Idempotency-Key)`; a mesma key em providers diferentes é
  independente. `OPENING` usa `internal:opening:{walletId}`.
- Fast path sem lock + **recheck obrigatório após o lock**, na mesma transação,
  antes de qualquer mutação de saldo. O recheck fecha a corrida entre requisições
  que passaram pelo fast path vazio.
- O UNIQUE `(provider_id, idempotency_key)` é o árbitro final. Em `23505`, a
  transação é abortada; uma nova transação relê e discrimina a constraint:
  - idempotência → replay (ou `409` se `payload_hash` divergir);
  - `(provider_id, external_transaction_id)` → `409 DUPLICATE_EXTERNAL_TRANSACTION`;
  - `uq_wager_tx_reversal` → reinserir a transação atual como `REJECTED`
    (`REFERENCE_ALREADY_REVERTED`) + evento + `422`;
  - `uq_wager_tx_settlement` → reinserir como `REJECTED`
    (`REFERENCE_ALREADY_SETTLED`) + evento + `422`.
- Replay espelha o estado persistido: `PROCESSED` → `200` com `balanceAfter`
  histórico (nunca o saldo atual); `PENDING_REFERENCE` → `202`; `REJECTED` →
  `422`; `FAILED` → `500` com `failureCode`; `idempotentReplay: true` em todos.
- O header `Idempotency-Key` obrigatório tem `trim`, 1..255 caracteres e **não**
  entra no `payload_hash`.

#### 5.2.1 Algoritmo do `payload_hash`

Implementação: `src/shared/hash/canonical-hash.ts`.

1. Monta um JSON canônico com **chaves ordenadas recursivamente**; `null` e
   `undefined` são omitidos e a ordem de arrays é preservada.
2. Campos de negócio incluídos: `providerId`, `externalTransactionId`, `playerId`,
   `walletId`, `roundId`, `gameId`, `kind`, `money { amount, currency }` e
   `referenceExternalTransactionId` (quando presente).
3. `amount` é normalizado para 2 casas e `currency` sofre `trim` + `uppercase`.
4. O JSON canônico é serializado e convertido em **SHA-256 hexadecimal** (64
   caracteres).
5. `Idempotency-Key`, `correlationId`, `causationId`, `occurredAt` e metadados de
   transporte **não** entram no hash.

### 5.3 Atomicidade

- Inbox insert-first (`ON CONFLICT DO NOTHING RETURNING`) no **mesmo
  `EntityManager`** do use case, no início da transação.
- Wallet + Ledger + WagerTransaction + Outbox commitam juntos.
- No SQS, `DeleteMessage` ocorre **somente após o commit**.
- `FAILED` pós-linha abre nova transação; se ela colidir em 23505, relê o estado
  existente (replay/`409`) em vez de sobrescrever.

---

## 6. Referências, reversões e `PENDING_REFERENCE`

### 6.1 Regras

- `REFUND`/`ROLLBACK` exigem `referenceExternalTransactionId`; `BET` a rejeita;
  `OPENING` a rejeita; `WIN` **exige** referência a uma `BET`; `LOSS` aceita
  referência opcional.
- Auto-referência (mesmo provider + mesmo external id) → `INVALID_PAYLOAD`.
- Contexto de referência = provider, player, wallet, moeda e round. `gameId` não
  entra na igualdade, alinhado ao enunciado.
- Alvos permitidos: `WIN`→`BET`; `LOSS`→`BET` (quando presente); `REFUND`→`BET`;
  `ROLLBACK`→`BET`, `WIN` ou `REFUND`.
- `REFUND`/`ROLLBACK` exigem alvo `PROCESSED`, valor estritamente igual e ausência
  de reversão anterior de **qualquer kind**.
- `WIN`/`LOSS` com referência exigem `BET` `PROCESSED`, não revertida e sem
  `WIN`/`LOSS` `PROCESSED`.
  - alvo ausente → `PENDING_REFERENCE`;
  - alvo pendente → aguarda;
  - alvo `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED`;
  - alvo já revertido → `REFERENCE_ALREADY_REVERTED`;
  - alvo já liquidado → `REFERENCE_ALREADY_SETTLED`.
- `WIN` sem referência é rejeitado com `REFERENCE_REQUIRED` (sem crédito),
  persiste `REJECTED`, publica `WagerTransactionRejected`, incrementa
  `wager_uncorrelated_wins_total` e registra log estruturado
  `win_without_reference_rejected`.

### 6.2 Divergências conscientes do enunciado

1. **Reversão única por qualquer kind.** O CHALLENGE diz “pelo mesmo tipo”; o
   sistema bloqueia uma segunda reversão do mesmo alvo por `REFUND` **ou**
   `ROLLBACK`, pois reverter o mesmo débito duas vezes é incorreto. O índice
   `uq_wager_tx_reversal` é único por `reference_transaction_id` para os kinds
   `REFUND` e `ROLLBACK` em `PROCESSED`; o comportamento é fixado pelo teste
   `7.4: reversão única por alvo vale entre REFUND e ROLLBACK` em
   `test/integration/wagering-api.e2e.spec.ts`.
2. **`WALLET_NOT_FOUND` no SQS é permanente → DLQ.** Erro de negócio não melhora
   com retry. No HTTP continua `422`.
3. **`REFUND`/`ROLLBACK` de `BET` com `LOSS` `PROCESSED` são permitidos** como void
   pós-settlement. O `LOSS` permanece auditável e o slot de
   `uq_wager_tx_settlement` continua consumido; um novo settlement é
   `REFERENCE_ALREADY_SETTLED`.
4. **`REFUND`/`ROLLBACK` de `BET` com `WIN` ativo é bloqueado**
   (`REFERENCE_HAS_PROCESSED_WIN`): reverta o `WIN` primeiro.
5. **`WIN` exige referência a uma `BET`.** O CHALLENGE diz que `WIN` “pode”
   referenciar; o sistema adota o modo mais restritivo para não creditar sem
   lastro. `WIN` sem referência é `REJECTED` com `REFERENCE_REQUIRED`; `LOSS`
   continua aceitando referência opcional.

### 6.3 `PENDING_REFERENCE` não reserva saldo nem alvo

O `202` é um aceite assíncrono, não uma garantia. Se o saldo cair antes da
resolução, o worker rejeita com `INSUFFICIENT_FUNDS_FOR_REVERSAL`. Isso evita um
modelo `available/reserved` e mantém o ledger com uma única semântica de saldo.

- Backoff de ausência: `min(2^(n-1) × 5s, 60s)`, até 10 tentativas.
- Esperar por alvo `PENDING_REFERENCE` **não** incrementa `reference_attempts` e usa
  backoff curto de 45s.
- `reference_expires_at = created_at + 1h`;
  `next_reference_attempt_at = LEAST(backoff, reference_expires_at)` garante que a
  expiração seja sempre um wakeup.
- Erro transitório no worker agenda `now() + 5s` sem consumir tentativas.
- Ao persistir `PROCESSED`/`REJECTED`, os campos de agendamento são limpos
  (exigido pelo CHECK do schema).

---

## 7. Mensageria

### 7.1 Consumer SQS

- Fila `wager-transactions.fifo`, `MaxNumberOfMessages=1`,
  `VisibilityTimeout=60s` (acima do pior caso de 30s de `statement_timeout` + 10s
  de lock), `MessageGroupId = walletId`,
  `MessageDeduplicationId = SHA-256(messageId)`.
- Envelope validado: `type = WagerTransactionRequested`, `messageId` 1..255, `data`
  objeto. `occurredAt` do SQS é informativo; `created_at` vem do banco.
- Inbox insert-first por `(consumer_name, messageId)`. Hash divergente → DLQ.
- Negócio persistível → `REJECTED` + evento + ack. `PENDING_REFERENCE` → evento +
  ack. Duplicata idêntica → replay + ack.
- Transitório (`55P03`, `40P01`, `40001`, `57014`, conexão) → rollback (inclusive
  Inbox) + `ChangeMessageVisibility` com backoff exponencial de base 5s
  (`min(2^(n-1) × 5s, 60s)`); redrive após 5 receives.
- Estrutural/permanente sem transação → DLQ direto + ack, com `MessageGroupId` e
  `MessageDeduplicationId` na DLQ FIFO.
- `FAILED` pós-linha → rollback da tx original, nova tx grava `FAILED`, comita,
  publica na DLQ e então deleta a mensagem original (ack após a DLQ). Se a nova tx
  ou a publicação na DLQ falhar, não ack (retry/DLQ).

### 7.2 Inbox

O insert-first no mesmo `EntityManager` fecha a duplicata concorrente: ou a linha
é inserida e o processamento segue, ou o `ON CONFLICT DO NOTHING` retorna vazio e
a mensagem é tratada como duplicata. O `payload_hash` do inbox é o mesmo hash
canônico dos campos de negócio usado pela idempotência, então reordenação de
chaves/whitespace no JSON não gera falso `PAYLOAD_MISMATCH`. O inbox e a transação
financeira commitam juntos; não existe estado persistido “received mas não
processado” no fluxo single-transaction.

### 7.3 Outbox

- `enqueue` grava `next_attempt_at = occurred_at` (mesmo relógio do banco).
- Claim em transação curta: `SELECT ... FOR UPDATE SKIP LOCKED` das linhas devidas
  e `UPDATE next_attempt_at = now() + lease, claim_count = claim_count + 1`
  (lease de 30s). Cada claim conta para `claim_count`, não para `attempts`.
- Publicação **fora da transação** em `wagering-events.fifo`, com
  `groupId = aggregateId` e `MessageDeduplicationId = eventId`; o `MessageId` do
  SQS é gerado pelo broker.
- Sucesso grava `published_at`; o lag `published_at - occurred_at` é observado no
  histograma `outbox_publish_lag_seconds`.
- `markPublished`, `scheduleRetry` e `markDeadLettered` usam `UPDATE ... WHERE
  published_at IS NULL AND dead_lettered_at IS NULL`: uma mensagem já publicada
  ou dead-lettered não é ressuscitada por um publisher atrasado.
- Falha incrementa `attempts` e agenda backoff. `attempts >= 10` **ou**
  `claim_count >= 20` → DLQ `wagering-events-dlq.fifo`,
  `dead_lettered_at` + `last_error`.
- Crash pós-claim: o lease expira e outro publisher assume. Crash após publish
  antes de `published_at`: duplicata segura (consumidores deduplicam por
  `eventId`); a evidência permanece na DLQ se o `claim_count` estourar.
- Entrega at-least-once, **sem garantia de ordem** entre eventos da mesma wallet.

### 7.4 Pending Reference Worker

- Claim no PostgreSQL com `FOR UPDATE SKIP LOCKED` sobre
  `next_reference_attempt_at <= now()`; processamento em transação separada.
- **Retry store no PostgreSQL em vez de Redis:** o estado de retry
  (`reference_attempts`, `next_reference_attempt_at`, `reference_expires_at`,
  `reference_last_attempt_at`) avança na mesma transação que resolve a
  transação-alvo. Isso elimina uma segunda fonte de falha, dispensa coordenação
  distribuída e mantém resolução + agendamento atômicos; o `SKIP LOCKED` já
  coordena múltiplas instâncias. Redis exigiria reconciliação entre dois stores e
  não conseguiria commitar o retry junto com o ledger.
- Usa `ResolvePendingReferenceUseCase`, que **não** faz fast-path/recheck de
  idempotência e **não** insere nova linha; reusa `ReferenceResolverService` +
  `Wallet` + `TransactionContext` sob o lock.
- Expiração/TTL ou 10 tentativas sem alvo → `REFERENCE_NOT_FOUND`; alvo que nunca
  chegou a `PROCESSED` → `REFERENCE_NOT_PROCESSED`.
- `23505` em `uq_wager_tx_reversal`/`uq_wager_tx_settlement` → nova transação grava
  `REJECTED` com o `failureCode` correspondente, sem retry infinito.
- Crash após claim aguarda o lease; SIGTERM para o poll e termina o lote.

### 7.5 FIFO, head-of-line e shutdown

- `MessageGroupId = walletId` ordena por wallet. Uma mensagem transitória bloqueia
  o grupo daquela wallet até o redrive (até 60s × 5). **FIFO é otimização, o banco
  é a garantia.**
- Graceful shutdown em todos os workers: `AbortController` interrompe polling,
  drain de até 30s com saída antecipada quando não há mensagens em voo; não há
  `ChangeMessageVisibility(0)` explícito, e uma mensagem em voo volta a ficar
  visível pelo `VisibilityTimeout`; outbox/pending param o poll e terminam o lote,
  liberando locks ao final da transação e leases por expiração.

### 7.6 Ingresso de teste

`bun run sqs:send -- --wallet <walletId> --file <mensagem.json>` publica no
LocalStack com os atributos FIFO corretos. Não existe endpoint público novo para
ingresso SQS.

---

## 8. Observabilidade

### 8.1 Logs estruturados

Todos os logs são JSON de uma linha, incluindo logs do framework: o adapter
`NestLoggerAdapter` (presentation) implementa `LoggerService` e delega ao
`LoggerPort`. Campos de correlação: `correlationId`, `causationId`,
`messageId`, `transactionId`, `walletId`, `playerId`, `providerId`, além de
`timestamp`, `level`, `service`, `instanceId`, `event`.

Sanitização estrita:

- chaves com `payload`, `body`, `card`, `pan`, `iban`, `account`, `token`,
  `secret`, `password`, `authorization` ou `cvv` são redigidas;
- corpo de requisições e payload completo de mensagens **nunca** são logados;
- mensagens de `Error` não são serializadas em caminhos financeiros; erros do
  consumer são reduzidos a `errorName`, `failureCode`, `code`, `constraint` e
  `cause.code`/`cause.constraint` quando a falha foi traduzida;
- strings são truncadas em 2000 caracteres e a profundidade é limitada;
- `Error` é reduzido a `name`/`code`/`failureCode`, sem `message` em caminhos
  financeiros.

`LOG_LEVEL` controla o nível (`DEBUG`, `INFO`, `WARN`, `ERROR`, `SILENT`,
case-insensitive); testes usam `ERROR` para reduzir ruído.

### 8.2 Métricas (`GET /metrics`)

`prom-client`, registry próprio com labels default `service` e `service_instance`
(o label `instance` é reservado ao Prometheus).
O endpoint é **interno**: deve ser acessado apenas na rede do Compose/VPC; não é
autenticado e não deve ser publicado na internet.

| Métrica | Tipo | Labels | Origem |
|---|---|---|---|
| `wager_transactions_total` | counter | `status` | transições persistidas no `TransactionApplicationService` e `OPENING` criado por `CreateWalletUseCase` |
| `wager_transaction_processing_seconds` | histogram | `status` | use case HTTP/SQS e resolução pendente |
| `wager_idempotency_hits_total` | counter | — | replays por `(provider, key)` |
| `wager_inbox_duplicates_total` | counter | `outcome` | duplicatas no inbox do consumer: `DUPLICATE`/`PAYLOAD_MISMATCH` |
| `wager_retries_total` | counter | `worker` | `CONSUMER`, `OUTBOX`, `PENDING_REFERENCE` |
| `wager_dlq_messages_sent_total` | counter | `queue` | `WAGER_TRANSACTIONS`, `WAGERING_EVENTS` |
| `sqs_dlq_messages` | gauge | `queue`, `collector_instance` | `WAGER_TRANSACTIONS_DLQ`, `WAGERING_EVENTS_DLQ` |
| `sqs_dlq_oldest_message_age_seconds` | gauge | `queue`, `collector_instance` | `GetQueueAttributes` |
| `outbox_pending` / `outbox_dead_lettered` | gauge | — | contagem no PostgreSQL |
| `outbox_publish_lag_seconds` | histogram | — | `published_at - occurred_at` |
| `reconciliation_divergences_total` | counter | — | reconciliação com `consistent=false` |
| `wager_preline_failures_total` | counter | `failureCode`, `httpStatus` | falhas HTTP antes da linha (sem `transactionId`) |
| `wager_uncorrelated_wins_total` | counter | — | `WIN` sem referência rejeitado |
| `db_lock_wait_seconds` | histogram | — | aquisição do `SELECT FOR UPDATE` |
| `db_lock_timeouts_total` | counter | — | SQLSTATE `55P03` |
| `db_deadlocks_total` | counter | — | SQLSTATE `40P01` |

Não há labels de domínio de alta cardinalidade (sem `walletId`, `transactionId`,
`providerId`). `service_instance` e `collector_instance` usam `INSTANCE_ID` quando definido e,
caso contrário, `hostname:pid`. No Compose, o default é `app-1` quando
`INSTANCE_ID` não está definido; o `.env.example` define `local-dev`, valor que
também é usado pelo Compose quando o arquivo `.env` é copiado. Os labels são
estáveis entre restarts quando `INSTANCE_ID` é fixo e mudam quando ele não é
definido. O Prometheus deve agregar ou remover esses labels no scrape. As métricas de processo padrão (`nodejs_*`,
`process_*`) também são expostas. Todas as instâncias coletam as DLQs; o
Prometheus agrega `max`/`avg` por `queue`. A coleta é habilitada com `METRICS_DLQ_ENABLED` (default:
`MESSAGING_ENABLED`) e o intervalo é `METRICS_DLQ_INTERVAL_MS` (default 15s).

Validação operacional: comparar `db_lock_wait_seconds` e os contadores de timeout
com `pg_stat_database`/`pg_stat_activity`; acompanhar `outbox_pending` e
`outbox_publish_lag_seconds` para detectar publisher parado; `sqs_dlq_messages`
e `sqs_dlq_oldest_message_age_seconds` para mensagens não tratadas.

### 8.3 Health checks

- `GET /health/live`: apenas o processo está vivo (`200 { status: "OK" }`).
- `GET /health/ready`: verifica PostgreSQL (`select 1`) e SQS
  (`GetQueueAttributes` nas filas de entrada, eventos e respectivas DLQs). Retorna
  `200` com `checks` quando
  ambos estão `UP`; `503` quando qualquer um está `DOWN`. A resposta não inclui
  segredos nem URLs.

O readiness não derruba o processo nem reinicia workers; ele informa o orquestrador.

---

## 9. Reconciliação e consultas

- `ReconcileWalletUseCase` roda em `REPEATABLE READ` **read-only** com
  `statement_timeout = 60s`, garantindo que wallet, soma e cadeia usem o mesmo
  snapshot.
- `calculatedBalance = SUM(CREDIT) - SUM(DEBIT)` — não o último `balance_after`.
- Cadeia: primeira entrada com `balanceBefore = 0.00`; primeira `walletVersion`
  igual a `1` se existe `OPENING`, senão `2`; `walletVersion` consecutivo;
  `balanceBefore` da entrada `n` = `balanceAfter` da `n-1`; última
  `walletVersion = wallet.version` e `balanceAfter = wallet.balance`; moedas
  iguais.
- Ledger vazio → saldo calculado `0.00`, consistente somente se a wallet tem
  `0.00`.
- Divergência → `200` com `consistent: false`, `difference` assinado, log
  estruturado e `reconciliation_divergences_total`; **nada é corrigido**.
- `checkedEntries` é o número de lançamentos lidos.
- A reconciliação é defesa em profundidade: a invariante deferida impede
  divergência por escrita SQL normal; o endpoint detecta dados legados ou
  alterações feitas com triggers desabilitados, sem corrigi-los silenciosamente.

### 9.1 Cursor do ledger por `wallet_version`

O cursor é base64url de `{ walletVersion }`. A ordenação por `wallet_version` é
monotônica sob o lock e imune a clock skew de UUIDv7 entre instâncias. O cursor é
opaco para o cliente (contrato), mas validado no servidor: base64url, JSON,
inteiro `>= 1`, coerência com a wallet e `limit` 50/máx 200. Inválido → `400
INVALID_PAYLOAD`, sem clamp silencioso.

---

## 10. API HTTP

Endpoints:

- `POST /wallets` — `initialBalance` obrigatório (inclusive `0.00`).
- `GET /wallets/:walletId` — `{ id, playerId, balance, version }`.
- `GET /wallets/:walletId/ledger?cursor=...&limit=50`.
- `POST /wallets/:walletId/reconciliation`.
- `POST /wagering/transactions` — header `Idempotency-Key` obrigatório.
- `GET /wagering/transactions/:transactionId`.
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId`.
- `GET /health/live`, `GET /health/ready`, `GET /metrics`.

Contrato de consulta retorna o estado armazenado, incluindo `referenceTransactionId`
(quando resolvido), sem `idempotentReplay` e sem expor
`referenceExternalTransactionId`. Em `OPENING`, os campos de provedor são `null`.

Status: `201` primeira transação `PROCESSED`; `200` replay/consultas; `202`
`PENDING_REFERENCE`; `400` payload inválido; `404` recurso inexistente em consultas
(`TRANSACTION_NOT_FOUND` e wallet inexistente em `GET`) ou rota inexistente
(`ROUTE_NOT_FOUND`); `409` conflito
de idempotência/unicidade; `422` rejeição de negócio, incluindo
`WALLET_NOT_FOUND` no `POST /wagering/transactions`, `WALLET_PLAYER_MISMATCH` e
`CURRENCY_MISMATCH`; `500` `FAILED`/`PERMANENT_INFRA_FAILURE`; `503` transitório
(`TRANSIENT_INFRA_FAILURE`) com `Retry-After`.

Todo não-2xx usa o envelope único:
`{ failureCode, message, correlationId?, transactionId?, status?, idempotentReplay?, details? }`.
Campos de transação aparecem apenas quando há transação.

`X-Correlation-Id` é opcional (gera UUIDv7 se ausente, valida 1..255, ecoa);
`X-Instance-Id` é ecoado em todas as respostas para testes/dev.

O CHALLENGE *recomenda* o default `"{providerId}:{externalTransactionId}"` para a
`Idempotency-Key`, mas ela é **obrigatória e explícita**: não há derivação
automática. Isso evita colisões silenciosas entre operações distintas do mesmo
external id (por exemplo retry legítimo vs. intenção diferente) e torna o contrato
do cliente explícito. O header não entra no `payload_hash`; a chave é trimada e
limitada a 1..255.

---

## 11. Retenção, TTL e crescimento

`wager_transactions` e o ledger continuam sem expurgo automático: a cadeia
financeira é imutável e precisa permanecer auditável. Para as tabelas
operacionais existe um comando opt-in, desabilitado por padrão:

```bash
bun run retention:purge                 # dry-run: apenas conta elegíveis
bun run retention:purge -- --execute    # arquiva e remove
```

O comando:

- processa apenas `inbox_messages` com `processed_at` anterior ao cutoff e
  `outbox_messages` publicadas ou dead-lettered antes do cutoff;
- arquiva as linhas em `inbox_messages_archive`/`outbox_messages_archive` e as
  remove na mesma transação, em lotes com `FOR UPDATE SKIP LOCKED`; as tabelas de
  arquivo têm CHECKs de hash, tamanho, datas e estado de publicação;
- nunca toca em `wallet_ledger_entries` nem em `wager_transactions`;
- usa `RETENTION_INBOX_DAYS` (default 30), `RETENTION_OUTBOX_DAYS` (default 90)
  e `RETENTION_BATCH_SIZE` (default 1000).

O publisher da outbox continua publicando cada mensagem individualmente, mas
processa o lote claimado com concorrência limitada por
`OUTBOX_PUBLISH_CONCURRENCY` (default 4, faixa 1–10). Lease, retry, DLQ e
`markPublished` permanecem por mensagem; a ordem entre eventos não é garantida.

As consequências de manter os dados financeiros são crescimento linear das
tabelas e dos índices e necessidade futura de particionamento/arquivamento por
período ou wallet. Qualquer evolução nessa direção deve preservar
`(provider_id, idempotency_key)`, `(provider_id, external_transaction_id)`,
`payload_hash` e a cadeia do ledger.

---

## 12. Limitações e trade-offs

- `WIN` sem referência é rejeitado (`REFERENCE_REQUIRED`); `LOSS` sem referência
  continua aceito como resultado sem efeito no saldo.
- Uma `BET` que já teve `WIN`/`LOSS` (mesmo revertido) não aceita novo settlement:
  o slot de `uq_wager_tx_settlement` permanece consumido, por segurança.
- `PENDING_REFERENCE` não reserva saldo nem alvo; a resolução pode rejeitar.
- `ROLLBACK` de um `REFUND` mantém o `REFUND` e o slot de
  `uq_wager_tx_reversal` do alvo: a `BET` original continua marcada como revertida
  e um novo `REFUND`/`WIN` sobre ela é rejeitado. É a consequência conservadora da
  decisão “reversão única por alvo” (não há “des-reversão”).
- `LOSS` antes da `BET` fica `PENDING_REFERENCE` até a `BET` chegar ou expirar.
- `REFUND`/`ROLLBACK` após `LOSS` é void e mantém o slot de settlement.
- FIFO tem head-of-line por wallet; hot wallets podem ter latência elevada.
- Crash pós-publish da outbox pode dead-letterar um evento já entregue; a duplicata
  é segura (consumidores deduplicam por `eventId`).
- Não há autenticação/IdP; o guard no-op é o ponto de extensão.
- `/metrics` é interno e sem autenticação; deve ser protegido por rede. No
  Compose, a app é publicada apenas em `127.0.0.1`; em produção, o bloqueio de
  `/metrics` deve estar no proxy ou na política de rede/VPC.
- O `Claim`/lease da outbox é at-least-once; ordem entre eventos não é garantida.
- A reconciliação é read-only e não corrige divergências.
- O `migrate` one-off e o processo de crash somam conexões ao pool durante
  operações; dimensionar `max_connections` com margem.
- Erros `Unknown` do consumer são persistidos como `FAILED` e enviados à DLQ, sem
  retry automático. É uma escolha auditável, não um ack silencioso.
- O limite de tentativas do consumer é `SQS_CONSUMER_MAX_RECEIVE_COUNT` (default
  `5`, alinhado ao `maxReceiveCount` do broker), com backoff por
  `ApproximateReceiveCount`.
- No SIGTERM, se o drain de 30s não concluir, a visibilidade é devolvida pelo
  `VisibilityTimeout` do SQS; não há `ChangeMessageVisibility(0)` explícito.
- `MikroOrmWalletRepository.save` faz CAS por `version` (`loadedVersion`); uma
  escrita obsoleta falha com `40001` e vira retry/`503`. O caller ainda deve usar
  `findByIdWithLock` para serializar a mesma wallet e evitar retrabalho.
- `LOSS`/`REJECTED` não geram ledger é garantido pela aplicação; a invariante
  wallet↔ledger valida saldo/versão/cadeia, mas não inspeciona o status da
  transação, então um lançamento direto para esses estados não é bloqueado
  semanticamente. A referência exige a mesma wallet também no schema
  (`fk_wager_tx_reference_wallet`).
- A tradução na borda normaliza a mensagem do driver; a causa original fica em
  `cause` e nos logs. Callers de infraestrutura que antes comparavam a mensagem
  crua devem inspecionar o tipo semântico ou `cause`.

---

## 13. Estratégia de testes

- **Unitários** (`bun run test:unit`): domínio puro, use cases, services, logger,
  métricas, readiness, collector de DLQ, tradutor de erros PostgreSQL e regras de
  dependência (`src/application/architecture.spec.ts`, cobrindo `application`,
  `presentation` e `domain`/`shared`). Cobrem também a taxonomia com
  `REFERENCE_REQUIRED`, a rejeição de `WIN` sem referência e o hash canônico do
  inbox com JSON reordenado.
- **Integração** (`bun run test:integration`): PostgreSQL e LocalStack reais via
  Testcontainers; migrations, constraints, triggers, HTTP, inbox/outbox, workers,
  observabilidade e readiness. Inclui a invariante wallet↔ledger deferida,
  ausência de lacunas de `wallet_version`, constraints das tabelas de arquivo,
  updates condicionais da outbox, defer de referência guiado pelo `Clock` e
  reversão de migration com transação terminal existente.
- **E2E** (`bun run test:e2e`): bootstrap da aplicação, fluxos HTTP e
  observabilidade; `test:e2e:http` restringe aos endpoints HTTP. A suíte completa
  continua em `bun run test`, que soma unitários, integração, concorrência, smoke
  e e2e.
- **Concorrência** (`bun run test:concurrency`): 3 processos Bun + 4º processo de
  crash; 50 apostas idempotentes, 100/80/80, wallets distintas, settlement e
  reversão concorrentes, crash pós-commit, reinício de HTTP e de workers
  (pending/outbox), referências fora de ordem com sucesso e invariante
  `wallet.balance == SUM(ledger)`.
- **Smoke** (`bun run test:smoke`): cadeia determinística completa + reconciliação.
- **Carga** (`bun run test:load`): k6 opcional, com execução manual; ver
  [`LOAD_TEST.md`](LOAD_TEST.md).

### Injeção de falha e isolamento

`FAULT_AFTER_COMMIT_BEFORE_ACK=1` faz o processo sair entre o commit e o ack,
provando a redelivery deduplicada pelo Inbox. Cada suíte usa template database
próprio e teardown de containers/processos para evitar interferência.
