import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand
} from '@aws-sdk/client-sqs';
import type { INestApplication } from '@nestjs/common';
import { WagerTransactionConsumer } from '../../src/infrastructure/messaging/wager-transaction.consumer';
import { PendingReferenceWorker } from '../../src/infrastructure/messaging/pending-reference.worker';
import {
  ensurePostgres,
  PostgresHarness,
  SuiteDatabase
} from '../integration/support/postgres-harness';
import { ensureLocalStack, LocalStackHarness } from '../integration/support/localstack-harness';
import { createApplicationOnDatabase } from '../integration/support/app-harness';
import { insertOutboxMessage } from '../integration/support/sql-fixtures';
import { newUuidV7 } from '../../src/shared/id/uuid';
import { sha256Hex } from '../../src/shared/hash/canonical-hash';
import { AppProcess, spawnApp } from './support/cluster-harness';
import { logCleanupFailure } from '../support/test-log';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction-status';
import { FailureCode } from '../../src/shared/errors/failure-code';
import { WagerTransactionKind } from '../../src/domain/wager-transaction/wager-transaction-kind';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction';

const PROVIDER = 'provider-concurrency';
const CURRENCY = 'BRL';
const ROUND = 'round-concurrency';
const GAME = 'fortune-chimp';

interface WalletFixture {
  walletId: string;
  playerId: string;
}

interface TransactionFixture {
  walletId: string;
  playerId: string;
  kind: string;
  amount: string;
  externalTransactionId: string;
  referenceExternalTransactionId?: string;
  roundId?: string;
  providerId?: string;
  currency?: string;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

describe('Concorrência e resiliência', () => {
  let harness: PostgresHarness;
  let localstack: LocalStackHarness;
  let database: SuiteDatabase;
  let cluster: AppProcess[] = [];
  let roundRobin = 0;
  let sequence = 0;
  let helperApp: INestApplication | undefined;
  let helperConsumer: WagerTransactionConsumer | undefined;
  let helperPending: PendingReferenceWorker | undefined;

  const helperEnvironment = (): Record<string, string> => ({
    SQS_ENDPOINT: localstack.endpoint,
    AWS_DEFAULT_REGION: localstack.region,
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_WAGER_QUEUE_URL: localstack.queues.wager,
    SQS_WAGER_DLQ_QUEUE_URL: localstack.queues.wagerDlq,
    SQS_EVENTS_QUEUE_URL: localstack.queues.events,
    SQS_EVENTS_DLQ_QUEUE_URL: localstack.queues.eventsDlq,
    SQS_VISIBILITY_TIMEOUT: '60',
    SQS_MAX_NUMBER_OF_MESSAGES: '1',
    MESSAGING_ENABLED: '0',
    FAULT_AFTER_COMMIT_BEFORE_ACK: '0'
  });

  function next(prefix: string): string {
    sequence += 1;
    return `${prefix}-${Date.now()}-${sequence}`;
  }

  function nextBaseUrl(): string {
    const instance = cluster[roundRobin % cluster.length];
    roundRobin += 1;
    if (instance === undefined) {
      throw new Error('HTTP cluster is not running');
    }
    return instance.baseUrl;
  }

  async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return database.orm.em.fork().execute<T[]>(sql, params);
  }

  async function waitForTransactionStatus(
    transactionId: string,
    status: string,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await rows<{ status: string }>(
        'select status from wager_transactions where id = ?',
        [transactionId]
      );
      if (result[0]?.status === status) {
        return;
      }
      await Bun.sleep(100);
    }
    throw new Error(`Transaction ${transactionId} did not reach ${status} within ${timeoutMs}ms`);
  }

  async function waitForOutboxPublished(outboxId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await rows<{ published_at: Date | null }>(
        'select published_at from outbox_messages where id = ?',
        [outboxId]
      );
      if (result[0]?.published_at != null) {
        return;
      }
      await Bun.sleep(100);
    }
    throw new Error(`Outbox ${outboxId} was not published within ${timeoutMs}ms`);
  }

  async function http(
    baseUrl: string,
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}
  ): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000)
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { message: text };
      }
    }
    return { status: response.status, body, headers: response.headers };
  }

  async function withRetry(
    operation: () => Promise<HttpResult>,
    attempts = 10
  ): Promise<HttpResult> {
    let last: HttpResult | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      last = await operation();
      if (last.status !== 503) {
        return last;
      }
      await Bun.sleep(20 + Math.floor(Math.random() * 120));
    }
    if (last === undefined) {
      throw new Error('Retry operation never executed');
    }
    return last;
  }

  async function createWallet(
    initialBalance = '100.00',
    baseUrl?: string
  ): Promise<WalletFixture & { version: number; baseUrl: string }> {
    const target = baseUrl ?? nextBaseUrl();
    const playerId = newUuidV7();
    const response = await http(target, 'POST', '/wallets', {
      body: { playerId, initialBalance: { amount: initialBalance, currency: CURRENCY } }
    });
    expect(response.status).toBe(201);
    return {
      walletId: String(response.body.id),
      playerId,
      version: Number(response.body.version),
      baseUrl: target
    };
  }

  function transactionBody(fixture: TransactionFixture): Record<string, unknown> {
    return {
      providerId: fixture.providerId ?? PROVIDER,
      externalTransactionId: fixture.externalTransactionId,
      playerId: fixture.playerId,
      walletId: fixture.walletId,
      roundId: fixture.roundId ?? ROUND,
      gameId: GAME,
      kind: fixture.kind,
      money: { amount: fixture.amount, currency: fixture.currency ?? CURRENCY },
      ...(fixture.referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId: fixture.referenceExternalTransactionId })
    };
  }

  function postTransaction(
    fixture: TransactionFixture,
    idempotencyKey: string,
    baseUrl?: string
  ): Promise<HttpResult> {
    return http(baseUrl ?? nextBaseUrl(), 'POST', '/wagering/transactions', {
      body: transactionBody(fixture),
      headers: { 'Idempotency-Key': idempotencyKey }
    });
  }

  async function getWallet(walletId: string, baseUrl?: string) {
    const response = await http(baseUrl ?? nextBaseUrl(), 'GET', `/wallets/${walletId}`);
    expect(response.status).toBe(200);
    return response.body as {
      balance: { amount: string; currency: string };
      version: number;
    };
  }

  async function forcePendingDue(ids: string[]): Promise<void> {
    for (const id of ids) {
      await rows(
        `update wager_transactions
            set next_reference_attempt_at = now() - interval '1 second'
          where id = ?`,
        [id]
      );
    }
  }

  async function helper(): Promise<{
    app: INestApplication;
    consumer: WagerTransactionConsumer;
    pending: PendingReferenceWorker;
  }> {
    if (helperApp === undefined) {
      helperApp = await createApplicationOnDatabase(database, helperEnvironment());
      helperConsumer = helperApp.get(WagerTransactionConsumer);
      helperPending = helperApp.get(PendingReferenceWorker);
    }
    if (helperConsumer === undefined || helperPending === undefined) {
      throw new Error('Helper application did not expose the workers');
    }
    return { app: helperApp, consumer: helperConsumer, pending: helperPending };
  }

  async function drain(queueUrl: string, limit = 200): Promise<string[]> {
    const bodies: string[] = [];
    while (bodies.length < limit) {
      const response = await localstack.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
          VisibilityTimeout: 1
        })
      );
      const messages = response.Messages ?? [];
      if (messages.length === 0) {
        break;
      }
      for (const message of messages) {
        if (message.Body !== undefined) {
          bodies.push(message.Body);
        }
        if (message.ReceiptHandle !== undefined) {
          await localstack.client.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle
            })
          );
        }
      }
    }
    return bodies;
  }

  async function queueDepth(queueUrl: string): Promise<number> {
    const response = await localstack.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages']
      })
    );
    return Number(response.Attributes?.ApproximateNumberOfMessages ?? '0');
  }

  async function inFlight(queueUrl: string): Promise<number> {
    const response = await localstack.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessagesNotVisible']
      })
    );
    return Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0');
  }

  async function waitFor<T>(
    operation: () => Promise<T>,
    predicate: (value: T) => boolean
  ): Promise<T> {
    const deadline = Date.now() + 20000;
    let last = await operation();
    while (!predicate(last) && Date.now() < deadline) {
      await Bun.sleep(50);
      last = await operation();
    }
    return last;
  }

  async function resetQueues(): Promise<void> {
    await localstack.purgeAll();
    for (const url of [
      localstack.queues.wager,
      localstack.queues.wagerDlq,
      localstack.queues.events,
      localstack.queues.eventsDlq
    ]) {
      await drain(url);
    }
  }

  async function startCluster(): Promise<void> {
    const processes: AppProcess[] = [];
    for (let index = 1; index <= 3; index += 1) {
      processes.push(
        await spawnApp({
          database,
          localstack,
          instanceId: `concurrency-http-${index}`,
          messaging: false
        })
      );
    }
    cluster = processes;
  }

  async function stopCluster(): Promise<void> {
    const processes = cluster;
    cluster = [];
    await Promise.all(processes.map(async (process) => await process.stop()));
  }

  async function installOutboxFailureTrigger(walletId: string): Promise<void> {
    await rows(
      `create or replace function concurrency_fail_outbox() returns trigger as $$
       begin
         if new.payload->'data'->>'walletId' = tg_argv[0] then
           raise exception 'concurrency injected outbox failure';
         end if;
         return new;
       end;
       $$ language plpgsql`
    );
    await rows('drop trigger if exists concurrency_fail_outbox_trigger on outbox_messages');
    await rows(
      `create trigger concurrency_fail_outbox_trigger before insert on outbox_messages
       for each row execute function concurrency_fail_outbox('${walletId}')`
    );
  }

  async function removeOutboxFailureTrigger(): Promise<void> {
    await rows('drop trigger if exists concurrency_fail_outbox_trigger on outbox_messages');
    await rows('drop function if exists concurrency_fail_outbox()');
  }

  function pendingMessage(wallet: WalletFixture, messageId: string, external: string): string {
    return JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: PROVIDER,
        externalTransactionId: external,
        idempotencyKey: `key-${external}`,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: ROUND,
        gameId: GAME,
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: CURRENCY }
      }
    });
  }

  async function sendMessage(body: string, groupId: string, dedup?: string): Promise<void> {
    await localstack.client.send(
      new SendMessageCommand({
        QueueUrl: localstack.queues.wager,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: dedup ?? sha256Hex(`${body}-${newUuidV7()}`)
      })
    );
  }

  beforeAll(async () => {
    harness = await ensurePostgres();
    localstack = await ensureLocalStack();
    database = await harness.createSuiteDatabase('concurrency_suite');
    await startCluster();
  }, 240000);

  afterAll(async () => {
    await stopCluster();
    if (helperApp !== undefined) {
      await helperApp.close();
    }
    await database?.close();
    await localstack?.stop();
    await harness?.stop();
  }, 240000);

  test('5.2 mesma aposta 50x em paralelo: 1 débito e 49 replays idempotentes', async () => {
    await resetQueues();
    const wallet = await createWallet('100.00');
    const idempotencyKey = newUuidV7();
    const external = next('bet-race-50');
    const fixture: TransactionFixture = {
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Bet,
      amount: '25.00',
      externalTransactionId: external
    };

    const responses = await Promise.all(
      Array.from({ length: 50 }, async () =>
        withRetry(async () => await postTransaction(fixture, idempotencyKey))
      )
    );

    const created = responses.filter((response) => response.status === 201);
    const replays = responses.filter((response) => response.status === 200);
    expect(created).toHaveLength(1);
    expect(replays).toHaveLength(49);

    const winner = created[0]?.body;
    expect(winner?.status).toBe(WagerTransactionStatus.Processed);
    expect(winner?.idempotentReplay).toBe(false);
    const withoutReplay = ({
      idempotentReplay: _idempotentReplay,
      ...rest
    }: Record<string, unknown>): Record<string, unknown> => rest;
    for (const response of responses) {
      expect(response.body.transactionId).toBe(winner?.transactionId);
      expect(response.body.status).toBe(WagerTransactionStatus.Processed);
      expect(response.body.balance).toEqual({ amount: '75.00', currency: CURRENCY });
      expect(response.body.idempotentReplay).toBe(response.status === 200);
      expect(withoutReplay(response.body)).toEqual(withoutReplay(winner ?? {}));
    }

    const view = await getWallet(wallet.walletId);
    expect(view.balance.amount).toBe('75.00');
    expect(view.version).toBe(2);

    const stats = await rows<{ bet_count: number; ledger_count: number }>(
      `select
           (select count(*)::int from wager_transactions
             where wallet_id = ? and kind = ?) as bet_count,
           (select count(*)::int from wallet_ledger_entries
             where wallet_id = ?) as ledger_count`,
      [wallet.walletId, WagerTransactionKind.Bet, wallet.walletId]
    );
    expect(stats[0]?.bet_count).toBe(1);
    expect(stats[0]?.ledger_count).toBe(2);
  }, 120000);

  test('5.3 duas apostas de R$80 com saldo R$100: 1 PROCESSED, 1 REJECTED e saldo R$20', async () => {
    await resetQueues();
    const wallet = await createWallet('100.00');
    const first = {
      fixture: {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '80.00',
        externalTransactionId: next('bet-80-a')
      } satisfies TransactionFixture,
      key: newUuidV7()
    };
    const second = {
      fixture: {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '80.00',
        externalTransactionId: next('bet-80-b')
      } satisfies TransactionFixture,
      key: newUuidV7()
    };

    const responses = await Promise.all([
      withRetry(async () => await postTransaction(first.fixture, first.key)),
      withRetry(async () => await postTransaction(second.fixture, second.key))
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
    const processed = responses.find((response) => response.status === 201);
    const rejected = responses.find((response) => response.status === 422);
    expect(processed?.body.status).toBe(WagerTransactionStatus.Processed);
    expect(processed?.body.balance).toEqual({ amount: '20.00', currency: CURRENCY });
    expect(rejected?.body.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected?.body.failureCode).toBe(FailureCode.InsufficientFunds);

    const view = await getWallet(wallet.walletId);
    expect(view.balance.amount).toBe('20.00');
    expect(view.version).toBe(2);

    const stored = await rows<{ status: string; failure_code: string | null }>(
      `select status, failure_code from wager_transactions
          where wallet_id = ? and kind = ?
          order by status`,
      [wallet.walletId, WagerTransactionKind.Bet]
    );
    expect(stored).toEqual([
      { status: WagerTransactionStatus.Processed, failure_code: null },
      { status: WagerTransactionStatus.Rejected, failure_code: FailureCode.InsufficientFunds }
    ]);
    const ledger = await rows<{ count: number }>(
      'select count(*)::int as count from wallet_ledger_entries where wallet_id = ?',
      [wallet.walletId]
    );
    expect(ledger[0]?.count).toBe(2);
  }, 60000);

  test('5.4 lock é restrito à walletId: outra wallet processa com a primeira travada', async () => {
    await resetQueues();
    const lockedWallet = await createWallet('100.00');
    const freeWallet = await createWallet('100.00');

    const locker = new Client({ connectionString: database.url });
    await locker.connect();
    try {
      await locker.query('begin');
      await locker.query('select id from wallets where id = $1 for update', [
        lockedWallet.walletId
      ]);

      const startedAt = Date.now();
      const response = await withRetry(
        async () =>
          await postTransaction(
            {
              walletId: freeWallet.walletId,
              playerId: freeWallet.playerId,
              kind: WagerTransactionKind.Bet,
              amount: '10.00',
              externalTransactionId: next('bet-free')
            },
            newUuidV7()
          )
      );
      const elapsed = Date.now() - startedAt;

      expect(response.status).toBe(201);
      expect(elapsed).toBeLessThan(5000);

      const lockerPid = await locker.query<{ pid: number }>('select pg_backend_pid() as pid');
      const pid = lockerPid.rows[0]?.pid;
      const lockerLocks = await rows<{ mode: string }>(
        `select mode
             from pg_locks
            where pid = ? and relation = 'wallets'::regclass`,
        [pid]
      );
      expect(lockerLocks.map((lock) => lock.mode)).toContain('RowShareLock');
      const tableLocks = await rows<{ mode: string }>(
        `select l.mode
             from pg_locks l
             join pg_class c on c.oid = l.relation
            where c.relname = 'wallets'`
      );
      expect(tableLocks.some((lock) => lock.mode === 'AccessExclusiveLock')).toBe(false);
    } finally {
      await locker.query('rollback');
      await locker.end();
    }

    const view = await getWallet(freeWallet.walletId);
    expect(view.balance.amount).toBe('90.00');

    const parallelWallets = await Promise.all(
      Array.from({ length: 8 }, async () => await createWallet('100.00'))
    );
    const parallelResponses = await Promise.all(
      parallelWallets.map(
        async (wallet) =>
          await withRetry(
            async () =>
              await postTransaction(
                {
                  walletId: wallet.walletId,
                  playerId: wallet.playerId,
                  kind: WagerTransactionKind.Bet,
                  amount: '10.00',
                  externalTransactionId: next('bet-parallel-wallet')
                },
                newUuidV7()
              )
          )
      )
    );
    expect(parallelResponses.every((response) => response.status === 201)).toBe(true);
    for (const wallet of parallelWallets) {
      expect((await getWallet(wallet.walletId)).balance.amount).toBe('90.00');
    }
  }, 60000);

  test('5.5 três instâncias Bun independentes atendem em round-robin', async () => {
    const instances = new Set<string>();
    for (let index = 0; index < 9; index += 1) {
      const response = await http(nextBaseUrl(), 'GET', '/health/live');
      expect(response.status).toBe(200);
      const instanceId = response.headers.get('x-instance-id');
      expect(instanceId).not.toBeNull();
      instances.add(String(instanceId));
    }
    expect(instances.size).toBeGreaterThanOrEqual(3);

    const wallets = await Promise.all([
      createWallet('10.00'),
      createWallet('10.00'),
      createWallet('10.00')
    ]);
    const writes = new Set<string>();
    for (const wallet of wallets) {
      const response = await http(wallet.baseUrl, 'GET', `/wallets/${wallet.walletId}`);
      writes.add(String(response.headers.get('x-instance-id')));
    }
    expect(writes.size).toBeGreaterThanOrEqual(3);
  }, 60000);

  test('5.1 atomicidade HTTP: falha na outbox desfaz wallet, ledger e transação', async () => {
    await resetQueues();
    const wallet = await createWallet('100.00');
    const key = newUuidV7();
    const fixture: TransactionFixture = {
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Bet,
      amount: '25.00',
      externalTransactionId: next('bet-atomic')
    };

    try {
      await installOutboxFailureTrigger(wallet.walletId);
      const failed = await withRetry(async () => await postTransaction(fixture, key));
      expect(failed.status).toBe(500);
      expect(failed.body.status).toBe(WagerTransactionStatus.Failed);
      expect(failed.body.failureCode).toBe(FailureCode.PermanentInfraFailure);

      const replay = await postTransaction(fixture, key);
      expect(replay.status).toBe(500);
      expect(replay.body.idempotentReplay).toBe(true);
      expect(replay.body.failureCode).toBe(FailureCode.PermanentInfraFailure);
    } finally {
      await removeOutboxFailureTrigger();
    }

    const view = await getWallet(wallet.walletId);
    expect(view.balance.amount).toBe('100.00');
    expect(view.version).toBe(1);

    const state = await rows<{ ledger_count: number; processed: number; failed: number }>(
      `select
           (select count(*)::int from wallet_ledger_entries where wallet_id = ?) as ledger_count,
           (select count(*)::int from wager_transactions
             where wallet_id = ? and status = ?) as processed,
           (select count(*)::int from wager_transactions
             where wallet_id = ? and status = ?) as failed`,
      [
        wallet.walletId,
        wallet.walletId,
        WagerTransactionStatus.Processed,
        wallet.walletId,
        WagerTransactionStatus.Failed
      ]
    );
    expect(state[0]).toEqual({ ledger_count: 1, processed: 1, failed: 1 });
  }, 60000);

  test('5.1 atomicidade SQS: falha na outbox desfaz o efeito e persiste FAILED com inbox', async () => {
    await resetQueues();
    const wallet = await createWallet('100.00');
    const messageId = next('msg-atomic');
    const external = next('bet-atomic-sqs');
    const body = pendingMessage(wallet, messageId, external);
    const { consumer } = await helper();

    try {
      await installOutboxFailureTrigger(wallet.walletId);
      await sendMessage(body, wallet.walletId, sha256Hex(messageId));
      expect(await consumer.runOnce()).toBe(1);
    } finally {
      await removeOutboxFailureTrigger();
    }

    const state = await rows<{
      inbox_count: number;
      ledger_count: number;
      failed: number;
    }>(
      `select
           (select count(*)::int from inbox_messages where message_id = ?) as inbox_count,
           (select count(*)::int from wallet_ledger_entries where wallet_id = ?) as ledger_count,
           (select count(*)::int from wager_transactions
             where wallet_id = ? and status = ?) as failed`,
      [messageId, wallet.walletId, wallet.walletId, WagerTransactionStatus.Failed]
    );
    expect(state[0]).toEqual({ inbox_count: 1, ledger_count: 1, failed: 1 });

    const view = await getWallet(wallet.walletId);
    expect(view.balance.amount).toBe('100.00');
    expect(await queueDepth(localstack.queues.wager)).toBe(0);

    const dlq = await drain(localstack.queues.wagerDlq);
    expect(dlq).toHaveLength(1);
    expect(JSON.parse(dlq[0] ?? '{}')).toMatchObject({ messageId });
  }, 60000);

  test('5.6 crash após commit e antes do ack: redelivery é deduplicada pelo inbox', async () => {
    await resetQueues();
    const wallet = await createWallet('100.00');
    const messageId = next('msg-crash');
    const external = next('bet-crash');
    const body = pendingMessage(wallet, messageId, external);

    const crash = await spawnApp({
      database,
      localstack,
      instanceId: 'concurrency-crash',
      messaging: true,
      visibilityTimeoutSeconds: 1,
      environment: { FAULT_AFTER_COMMIT_BEFORE_ACK: '1' }
    });

    try {
      await sendMessage(body, wallet.walletId, sha256Hex(messageId));
      expect(await crash.waitForExit(45000)).toBe(1);
    } finally {
      await crash.stop();
    }

    const committed = await rows<{ status: string }>(
      'select status from wager_transactions where external_transaction_id = ?',
      [external]
    );
    expect(committed[0]?.status).toBe(WagerTransactionStatus.Processed);
    expect((await getWallet(wallet.walletId)).balance.amount).toBe('75.00');

    const { consumer } = await helper();
    let received = 0;
    const deadline = Date.now() + 20000;
    while (received === 0 && Date.now() < deadline) {
      received = await consumer.runOnce();
      if (received === 0) {
        await Bun.sleep(250);
      }
    }
    expect(received).toBe(1);

    const state = await rows<{
      inbox_count: number;
      ledger_count: number;
      bet_count: number;
    }>(
      `select
           (select count(*)::int from inbox_messages where message_id = ?) as inbox_count,
           (select count(*)::int from wallet_ledger_entries where wallet_id = ?) as ledger_count,
           (select count(*)::int from wager_transactions
             where wallet_id = ? and kind = ?) as bet_count`,
      [messageId, wallet.walletId, wallet.walletId, WagerTransactionKind.Bet]
    );
    expect(state[0]).toEqual({ inbox_count: 1, ledger_count: 2, bet_count: 1 });
    expect((await getWallet(wallet.walletId)).balance.amount).toBe('75.00');
    expect(await queueDepth(localstack.queues.wager)).toBe(0);
  }, 120000);

  test('5.6b SIGTERM com mensagem em voo: drena, faz commit/ack e não duplica na redelivery', async () => {
    await resetQueues();
    const wallet = await createWallet('100.00');
    const messageId = next('msg-sigterm-drain');
    const external = next('bet-sigterm-drain');
    const body = pendingMessage(wallet, messageId, external);

    const app = await spawnApp({
      database,
      localstack,
      instanceId: 'concurrency-sigterm-drain',
      messaging: true,
      visibilityTimeoutSeconds: 5,
      environment: { MESSAGING_DRAIN_TIMEOUT_MS: '15000' }
    });
    const locker = new Client({ connectionString: database.url });
    await locker.connect();
    let locked = false;

    try {
      await locker.query('begin');
      await locker.query('select id from wallets where id = $1 for update', [wallet.walletId]);
      locked = true;

      await sendMessage(body, wallet.walletId, sha256Hex(messageId));
      const received = await waitFor(
        async () => await inFlight(localstack.queues.wager),
        (value) => value >= 1
      );
      expect(received).toBeGreaterThanOrEqual(1);

      const startedAt = Date.now();
      const terminated = app.terminate(20000);
      await Bun.sleep(250);

      expect(await inFlight(localstack.queues.wager)).toBeGreaterThanOrEqual(1);
      expect((await getWallet(wallet.walletId)).balance.amount).toBe('100.00');

      await locker.query('rollback');
      locked = false;

      const exitCode = await terminated;
      const elapsed = Date.now() - startedAt;

      expect([0, 143]).toContain(exitCode);
      expect(elapsed).toBeLessThan(15000);
      expect((await getWallet(wallet.walletId)).balance.amount).toBe('75.00');
      expect(await queueDepth(localstack.queues.wager)).toBe(0);

      await sendMessage(body, wallet.walletId, sha256Hex(`${messageId}-redelivery`));
      const { consumer } = await helper();
      expect(await consumer.runOnce()).toBe(1);

      const state = await rows<{ inbox_count: number; transaction_count: number }>(
        `select
             (select count(*)::int from inbox_messages where message_id = ?) as inbox_count,
             (select count(*)::int from wager_transactions
               where wallet_id = ? and kind <> ?) as transaction_count`,
        [messageId, wallet.walletId, WagerTransactionKind.Opening]
      );
      expect(state[0]).toEqual({ inbox_count: 1, transaction_count: 1 });
      expect((await getWallet(wallet.walletId)).balance.amount).toBe('75.00');
    } finally {
      if (locked) {
        await locker.query('rollback').catch((error: unknown) => {
          logCleanupFailure(`locker rollback (${wallet.walletId})`, error);
        });
      }
      await locker.end().catch((error: unknown) => {
        logCleanupFailure('locker.end', error);
      });
      await app.stop();
    }
  }, 120000);

  test('5.6c SIGTERM sem concluir devolve a visibilidade e não aplica efeito', async () => {
    await resetQueues();
    const wallet = await createWallet('100.00');
    const messageId = next('msg-sigterm-abort');
    const external = next('bet-sigterm-abort');
    const body = pendingMessage(wallet, messageId, external);

    const app = await spawnApp({
      database,
      localstack,
      instanceId: 'concurrency-sigterm-abort',
      messaging: true,
      visibilityTimeoutSeconds: 1,
      environment: { MESSAGING_DRAIN_TIMEOUT_MS: '15000' }
    });
    const locker = new Client({ connectionString: database.url });
    await locker.connect();
    let locked = false;

    try {
      await locker.query('begin');
      await locker.query('select id from wallets where id = $1 for update', [wallet.walletId]);
      locked = true;

      await sendMessage(body, wallet.walletId, sha256Hex(messageId));
      expect(
        await waitFor(
          async () => await inFlight(localstack.queues.wager),
          (value) => value >= 1
        )
      ).toBeGreaterThanOrEqual(1);

      const startedAt = Date.now();
      const exitCode = await app.terminate(15000);
      const elapsed = Date.now() - startedAt;

      expect([0, 143]).toContain(exitCode);
      expect(elapsed).toBeLessThan(15000);
      expect((await getWallet(wallet.walletId)).balance.amount).toBe('100.00');

      await locker.query('rollback');
      locked = false;

      const visibleAgain = await waitFor(
        async () => await queueDepth(localstack.queues.wager),
        (value) => value >= 1
      );
      expect(visibleAgain).toBeGreaterThanOrEqual(1);
      expect((await getWallet(wallet.walletId)).balance.amount).toBe('100.00');

      await drain(localstack.queues.wager);
    } finally {
      if (locked) {
        await locker.query('rollback').catch((error: unknown) => {
          logCleanupFailure(`locker rollback (${wallet.walletId})`, error);
        });
      }
      await locker.end().catch((error: unknown) => {
        logCleanupFailure('locker.end', error);
      });
      await app.stop();
    }
  }, 120000);

  test('5.7 múltiplos publicadores da outbox: claim exclusivo, lease e duplicata segura', async () => {
    await resetQueues();
    await rows(
      `update outbox_messages
            set published_at = now()
          where published_at is null and dead_lettered_at is null`
    );

    const probe = `concurrency-outbox-${newUuidV7()}`;
    const ids: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const id = newUuidV7();
      ids.push(id);
      await insertOutboxMessage(database.orm.em.fork(), {
        id,
        payload: { eventId: id, probe },
        occurredAt: new Date(Date.now() - 5000),
        nextAttemptAt: new Date(Date.now() - 1000)
      });
    }

    const publishers: AppProcess[] = [];
    try {
      for (let index = 1; index <= 2; index += 1) {
        publishers.push(
          await spawnApp({
            database,
            localstack,
            instanceId: `concurrency-outbox-${index}`,
            messaging: true
          })
        );
      }

      const deadline = Date.now() + 30000;
      let published = 0;
      while (Date.now() < deadline) {
        const [stats] = await rows<{
          published: number;
          claims: number;
          max_claims: number;
        }>(
          `select
               count(*) filter (where published_at is not null)::int as published,
               coalesce(sum(claim_count), 0)::int as claims,
               coalesce(max(claim_count), 0)::int as max_claims
             from outbox_messages
             where payload->>'probe' = ?`,
          [probe]
        );
        published = stats?.published ?? 0;
        if (published === 20) {
          expect(stats?.claims).toBe(20);
          expect(stats?.max_claims).toBe(1);
          break;
        }
        await Bun.sleep(200);
      }
      expect(published).toBe(20);

      const firstDrain = (await drain(localstack.queues.events))
        .map((raw) => JSON.parse(raw) as { eventId?: string; probe?: string })
        .filter((event) => event.probe === probe);
      const firstByEvent = new Map<string, number>();
      for (const event of firstDrain) {
        const id = String(event.eventId);
        firstByEvent.set(id, (firstByEvent.get(id) ?? 0) + 1);
      }
      expect(firstByEvent.size).toBe(20);
      expect([...firstByEvent.values()].every((count) => count === 1)).toBe(true);

      const crashed = ids[0] as string;
      await rows(
        `update outbox_messages
              set published_at = null,
                  next_attempt_at = now() - interval '1 second',
                  last_error = 'concurrency simulated crash before publish mark'
            where id = ?`,
        [crashed]
      );

      const reclaimDeadline = Date.now() + 20000;
      let claimCount = 1;
      while (Date.now() < reclaimDeadline) {
        const [row] = await rows<{ claim_count: number; published_at: Date | null }>(
          'select claim_count, published_at from outbox_messages where id = ?',
          [crashed]
        );
        claimCount = row?.claim_count ?? 1;
        if (claimCount >= 2 && row?.published_at !== null) {
          break;
        }
        await Bun.sleep(200);
      }
      expect(claimCount).toBe(2);

      const secondDrain = (await drain(localstack.queues.events))
        .map((raw) => JSON.parse(raw) as { eventId?: string; probe?: string })
        .filter((event) => event.probe === probe);
      expect(secondDrain.length).toBeLessThanOrEqual(1);
      for (const event of secondDrain) {
        expect(event.eventId).toBe(crashed);
      }
    } finally {
      await Promise.all(publishers.map(async (publisher) => await publisher.stop()));
    }
  }, 120000);

  test('5.8 referência fora de ordem: WIN e LOSS aguardam a BET e resolvem depois', async () => {
    await resetQueues();
    const wallet = await createWallet('100.00');
    const winRef = next('bet-for-win');
    const lossRef = next('bet-for-loss');

    const pendingWin = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Win,
        amount: '10.00',
        externalTransactionId: next('win-early'),
        referenceExternalTransactionId: winRef
      },
      newUuidV7()
    );
    expect(pendingWin.status).toBe(202);
    expect(pendingWin.body.status).toBe(WagerTransactionStatus.PendingReference);

    const pendingLoss = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Loss,
        amount: '10.00',
        externalTransactionId: next('loss-early'),
        referenceExternalTransactionId: lossRef
      },
      newUuidV7()
    );
    expect(pendingLoss.status).toBe(202);

    const betForWin = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '10.00',
        externalTransactionId: winRef
      },
      newUuidV7()
    );
    expect(betForWin.status).toBe(201);
    const betForLoss = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '10.00',
        externalTransactionId: lossRef
      },
      newUuidV7()
    );
    expect(betForLoss.status).toBe(201);

    await forcePendingDue([
      String(pendingWin.body.transactionId),
      String(pendingLoss.body.transactionId)
    ]);
    const { pending } = await helper();
    expect(await pending.runOnce()).toBe(2);

    const resolved = await rows<{
      id: string;
      status: string;
      reference_transaction_id: string | null;
    }>(
      `select id, status, reference_transaction_id
           from wager_transactions
          where id in (?, ?)`,
      [String(pendingWin.body.transactionId), String(pendingLoss.body.transactionId)]
    );
    expect(resolved.map((row) => row.status)).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Processed
    ]);
    const winRow = resolved.find((row) => row.id === String(pendingWin.body.transactionId));
    expect(winRow?.reference_transaction_id).toBe(String(betForWin.body.transactionId));

    const view = await getWallet(wallet.walletId);
    expect(view.balance.amount).toBe('90.00');
    const ledger = await rows<{ count: number }>(
      'select count(*)::int as count from wallet_ledger_entries where wallet_id = ?',
      [wallet.walletId]
    );
    expect(ledger[0]?.count).toBe(4);

    const secondSettlement = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Win,
        amount: '10.00',
        externalTransactionId: next('win-after-loss'),
        referenceExternalTransactionId: lossRef
      },
      newUuidV7()
    );
    expect(secondSettlement.status).toBe(422);
    expect(secondSettlement.body.failureCode).toBe(FailureCode.ReferenceAlreadySettled);

    const voidAfterLoss = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Refund,
        amount: '10.00',
        externalTransactionId: next('refund-after-loss'),
        referenceExternalTransactionId: lossRef
      },
      newUuidV7()
    );
    expect(voidAfterLoss.status).toBe(201);
    expect((await getWallet(wallet.walletId)).balance.amount).toBe('100.00');

    const afterVoid = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Win,
        amount: '10.00',
        externalTransactionId: next('win-after-void'),
        referenceExternalTransactionId: lossRef
      },
      newUuidV7()
    );
    expect(afterVoid.status).toBe(422);
    expect(afterVoid.body.failureCode).toBe(FailureCode.ReferenceAlreadySettled);
  }, 60000);

  test('5.8 regras de alvo: REJECTED, revertida, WIN ativo e WIN sem referência', async () => {
    await resetQueues();
    const poor = await createWallet('10.00');
    const rejectedRef = next('bet-rejected-target');
    const earlyRefund = await postTransaction(
      {
        walletId: poor.walletId,
        playerId: poor.playerId,
        kind: WagerTransactionKind.Refund,
        amount: '50.00',
        externalTransactionId: next('refund-early'),
        referenceExternalTransactionId: rejectedRef
      },
      newUuidV7()
    );
    expect(earlyRefund.status).toBe(202);

    const rejectedBet = await postTransaction(
      {
        walletId: poor.walletId,
        playerId: poor.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '50.00',
        externalTransactionId: rejectedRef
      },
      newUuidV7()
    );
    expect(rejectedBet.status).toBe(422);
    expect(rejectedBet.body.failureCode).toBe(FailureCode.InsufficientFunds);

    await forcePendingDue([String(earlyRefund.body.transactionId)]);
    const { pending } = await helper();
    expect(await pending.runOnce()).toBe(1);

    const unresolved = await rows<{ status: string; failure_code: string | null }>(
      'select status, failure_code from wager_transactions where id = ?',
      [String(earlyRefund.body.transactionId)]
    );
    expect(unresolved[0]).toEqual({
      status: WagerTransactionStatus.Rejected,
      failure_code: FailureCode.ReferenceNotProcessed
    });
    expect((await getWallet(poor.walletId)).balance.amount).toBe('10.00');

    const wallet = await createWallet('200.00');
    const voidedBet = next('bet-voided');
    await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '50.00',
        externalTransactionId: voidedBet
      },
      newUuidV7()
    );
    const refund = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Refund,
        amount: '50.00',
        externalTransactionId: next('refund-void'),
        referenceExternalTransactionId: voidedBet
      },
      newUuidV7()
    );
    expect(refund.status).toBe(201);

    const winOnReverted = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Win,
        amount: '50.00',
        externalTransactionId: next('win-reverted'),
        referenceExternalTransactionId: voidedBet
      },
      newUuidV7()
    );
    expect(winOnReverted.status).toBe(422);
    expect(winOnReverted.body.failureCode).toBe(FailureCode.ReferenceAlreadyReverted);

    const settledBet = next('bet-with-win');
    await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '50.00',
        externalTransactionId: settledBet
      },
      newUuidV7()
    );
    const winExternal = next('win-active');
    const win = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Win,
        amount: '100.00',
        externalTransactionId: winExternal,
        referenceExternalTransactionId: settledBet
      },
      newUuidV7()
    );
    expect(win.status).toBe(201);

    const blockedRefund = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Refund,
        amount: '50.00',
        externalTransactionId: next('refund-blocked'),
        referenceExternalTransactionId: settledBet
      },
      newUuidV7()
    );
    expect(blockedRefund.status).toBe(422);
    expect(blockedRefund.body.failureCode).toBe(FailureCode.ReferenceHasProcessedWin);

    const rollback = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Rollback,
        amount: '100.00',
        externalTransactionId: next('rollback-win'),
        referenceExternalTransactionId: winExternal
      },
      newUuidV7()
    );
    expect(rollback.status).toBe(201);

    const refundAfterRollback = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Refund,
        amount: '50.00',
        externalTransactionId: next('refund-after-rollback'),
        referenceExternalTransactionId: settledBet
      },
      newUuidV7()
    );
    expect(refundAfterRollback.status).toBe(201);

    const resettled = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Win,
        amount: '10.00',
        externalTransactionId: next('win-resettled'),
        referenceExternalTransactionId: settledBet
      },
      newUuidV7()
    );
    expect(resettled.status).toBe(422);
    expect(resettled.body.failureCode).toBe(FailureCode.ReferenceAlreadySettled);

    const uncorrelated = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Win,
        amount: '10.00',
        externalTransactionId: next('win-uncorrelated')
      },
      newUuidV7()
    );
    expect(uncorrelated.status).toBe(422);
    expect(uncorrelated.body).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceRequired
    });
  }, 60000);

  test('5.8 settlement concorrente: dois WIN e WIN×LOSS produzem um único settlement', async () => {
    await resetQueues();
    const wallet = await createWallet('100.00');
    const bet = next('bet-settlement-race');
    await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '20.00',
        externalTransactionId: bet
      },
      newUuidV7()
    );

    const winA = {
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Win,
      amount: '10.00',
      externalTransactionId: next('win-race-a'),
      referenceExternalTransactionId: bet
    } satisfies TransactionFixture;
    const winB = {
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Win,
      amount: '15.00',
      externalTransactionId: next('win-race-b'),
      referenceExternalTransactionId: bet
    } satisfies TransactionFixture;

    const wins = await Promise.all([
      withRetry(async () => await postTransaction(winA, newUuidV7())),
      withRetry(async () => await postTransaction(winB, newUuidV7()))
    ]);
    expect(wins.map((response) => response.status).sort()).toEqual([201, 422]);
    expect(wins.find((response) => response.status === 422)?.body.failureCode).toBe(
      FailureCode.ReferenceAlreadySettled
    );

    const settlements = await rows<{ count: number }>(
      `select count(*)::int as count from wager_transactions
          where wallet_id = ? and kind in (?, ?) and status = ?`,
      [
        wallet.walletId,
        WagerTransactionKind.Win,
        WagerTransactionKind.Loss,
        WagerTransactionStatus.Processed
      ]
    );
    expect(settlements[0]?.count).toBe(1);
    const ledger = await rows<{ count: number }>(
      'select count(*)::int as count from wallet_ledger_entries where wallet_id = ?',
      [wallet.walletId]
    );
    expect(ledger[0]?.count).toBe(3);

    const mixedWallet = await createWallet('100.00');
    const mixedBet = next('bet-mixed-race');
    await postTransaction(
      {
        walletId: mixedWallet.walletId,
        playerId: mixedWallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '20.00',
        externalTransactionId: mixedBet
      },
      newUuidV7()
    );

    const win = {
      walletId: mixedWallet.walletId,
      playerId: mixedWallet.playerId,
      kind: WagerTransactionKind.Win,
      amount: '40.00',
      externalTransactionId: next('win-mixed'),
      referenceExternalTransactionId: mixedBet
    } satisfies TransactionFixture;
    const loss = {
      walletId: mixedWallet.walletId,
      playerId: mixedWallet.playerId,
      kind: WagerTransactionKind.Loss,
      amount: '20.00',
      externalTransactionId: next('loss-mixed'),
      referenceExternalTransactionId: mixedBet
    } satisfies TransactionFixture;

    const mixed = await Promise.all([
      withRetry(async () => await postTransaction(win, newUuidV7())),
      withRetry(async () => await postTransaction(loss, newUuidV7()))
    ]);
    expect(mixed.map((response) => response.status).sort()).toEqual([201, 422]);
    expect(mixed.find((response) => response.status === 422)?.body.failureCode).toBe(
      FailureCode.ReferenceAlreadySettled
    );

    const winner = await rows<{ kind: string }>(
      `select kind from wager_transactions
          where wallet_id = ? and kind in (?, ?) and status = ?`,
      [
        mixedWallet.walletId,
        WagerTransactionKind.Win,
        WagerTransactionKind.Loss,
        WagerTransactionStatus.Processed
      ]
    );
    expect(winner).toHaveLength(1);
    const winnerKind = winner[0]?.kind;
    const mixedView = await getWallet(mixedWallet.walletId);
    expect(mixedView.balance.amount).toBe(
      winnerKind === WagerTransactionKind.Win ? '120.00' : '80.00'
    );
    const mixedLedger = await rows<{ count: number }>(
      'select count(*)::int as count from wallet_ledger_entries where wallet_id = ?',
      [mixedWallet.walletId]
    );
    expect(mixedLedger[0]?.count).toBe(winnerKind === WagerTransactionKind.Win ? 3 : 2);
  }, 120000);

  test('5.17 worker de referência retoma estado pendente após reinício', async () => {
    await resetQueues();
    const wallet = await createWallet('100.00');
    const betExternal = next('bet-worker-restart');
    const refund = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        externalTransactionId: next('refund-worker-restart'),
        referenceExternalTransactionId: betExternal
      },
      newUuidV7()
    );
    expect(refund.status).toBe(202);
    await forcePendingDue([String(refund.body.transactionId)]);

    const bet = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
        externalTransactionId: betExternal
      },
      newUuidV7()
    );
    expect(bet.status).toBe(201);

    const worker = await spawnApp({
      database,
      localstack,
      instanceId: 'worker-restart',
      messaging: true
    });
    try {
      await waitForTransactionStatus(
        String(refund.body.transactionId),
        WagerTransactionStatus.Processed,
        20000
      );
      expect((await getWallet(wallet.walletId)).balance.amount).toBe('100.00');
    } finally {
      await worker.stop();
    }
  }, 90000);

  test('5.18 outbox retoma linha com lease expirado após publisher morrer', async () => {
    await resetQueues();
    const aggregateId = newUuidV7();
    const outboxId = await insertOutboxMessage(database.orm.em.fork(), {
      aggregateId,
      eventType: 'WagerTransactionProcessed',
      payload: {
        eventId: newUuidV7(),
        eventType: 'WagerTransactionProcessed',
        aggregateId,
        correlationId: next('corr-outbox-restart'),
        occurredAt: new Date(Date.now() - 5000).toISOString(),
        version: 1,
        data: { transactionId: aggregateId }
      },
      occurredAt: new Date(Date.now() - 5000),
      claimCount: 1,
      attempts: 1,
      nextAttemptAt: new Date(Date.now() - 1000)
    });

    const worker = await spawnApp({
      database,
      localstack,
      instanceId: 'outbox-restart',
      messaging: true
    });
    try {
      await waitForOutboxPublished(outboxId, 20000);
    } finally {
      await worker.stop();
    }
  }, 90000);

  test('5.19 publisher morto entre publish e markPublished republica sem duplicar', async () => {
    await resetQueues();
    await rows(
      `update outbox_messages
            set published_at = now()
          where published_at is null and dead_lettered_at is null`
    );

    const aggregateId = newUuidV7();
    const eventId = newUuidV7();
    const outboxId = await insertOutboxMessage(database.orm.em.fork(), {
      aggregateId,
      eventType: 'WagerTransactionProcessed',
      payload: {
        eventId,
        eventType: 'WagerTransactionProcessed',
        aggregateId,
        correlationId: next('corr-outbox-crash'),
        occurredAt: new Date(Date.now() - 5000).toISOString(),
        version: 1,
        data: { transactionId: aggregateId }
      },
      occurredAt: new Date(Date.now() - 5000),
      nextAttemptAt: new Date(Date.now() + 3000)
    });

    const crashing = await spawnApp({
      database,
      localstack,
      instanceId: 'outbox-crash',
      messaging: true,
      environment: {
        FAULT_AFTER_PUBLISH_BEFORE_MARK: '1',
        OUTBOX_LEASE_MS: '500',
        MESSAGING_POLL_INTERVAL_MS: '200'
      }
    });
    expect(await crashing.waitForExit(30000)).toBe(1);

    const afterCrash = await rows<{ published_at: Date | null }>(
      'select published_at from outbox_messages where id = ?',
      [outboxId]
    );
    expect(afterCrash[0]?.published_at ?? null).toBeNull();

    const firstDelivery = await drain(localstack.queues.events);
    const publishedEventIds = firstDelivery
      .map((body) => JSON.parse(body) as { eventId?: string })
      .filter((event) => event.eventId === eventId);
    expect(publishedEventIds).toHaveLength(1);

    const recovery = await spawnApp({
      database,
      localstack,
      instanceId: 'outbox-crash-recovery',
      messaging: true,
      environment: {
        OUTBOX_LEASE_MS: '500',
        MESSAGING_POLL_INTERVAL_MS: '200'
      }
    });
    try {
      await waitForOutboxPublished(outboxId, 30000);
    } finally {
      await recovery.stop();
    }

    const redelivery = await drain(localstack.queues.events);
    expect(
      redelivery
        .map((body) => JSON.parse(body) as { eventId?: string })
        .filter((event) => event.eventId === eventId)
    ).toHaveLength(0);
  }, 90000);

  test('5.9 reinício: saldo continua igual à soma do ledger e à cadeia de wallet_version', async () => {
    await resetQueues();
    const wallet = await createWallet('100.00');
    const bet = next('bet-restart');
    await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
        externalTransactionId: bet
      },
      newUuidV7()
    );
    const winExternal = next('win-restart');
    const win = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Win,
        amount: '40.00',
        externalTransactionId: winExternal,
        referenceExternalTransactionId: bet
      },
      newUuidV7()
    );
    expect(win.status).toBe(201);
    await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Rollback,
        amount: '40.00',
        externalTransactionId: next('rollback-restart'),
        referenceExternalTransactionId: winExternal
      },
      newUuidV7()
    );
    const secondBet = next('bet-restart-2');
    await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '10.00',
        externalTransactionId: secondBet
      },
      newUuidV7()
    );
    await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Loss,
        amount: '10.00',
        externalTransactionId: next('loss-restart'),
        referenceExternalTransactionId: secondBet
      },
      newUuidV7()
    );
    const uncorrelated = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Win,
        amount: '5.00',
        externalTransactionId: next('win-restart-uncorrelated')
      },
      newUuidV7()
    );
    expect(uncorrelated.status).toBe(422);
    expect(uncorrelated.body).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceRequired
    });
    expect((await getWallet(wallet.walletId)).balance.amount).toBe('65.00');

    await stopCluster();
    await startCluster();

    const view = await getWallet(wallet.walletId);
    expect(view.balance.amount).toBe('65.00');
    expect(view.version).toBe(5);

    const reconciliation = await http(
      nextBaseUrl(),
      'POST',
      `/wallets/${wallet.walletId}/reconciliation`
    );
    expect(reconciliation.status).toBe(200);
    expect(reconciliation.body).toMatchObject({
      walletId: wallet.walletId,
      storedBalance: { amount: '65.00', currency: CURRENCY },
      calculatedBalance: { amount: '65.00', currency: CURRENCY },
      difference: { amount: '0.00', currency: CURRENCY },
      consistent: true,
      checkedEntries: 5
    });

    const ledger = await rows<{
      wallet_version: number;
      direction: string;
      amount: string;
    }>(
      `select wallet_version, direction, amount::text as amount
           from wallet_ledger_entries
          where wallet_id = ?
          order by wallet_version asc`,
      [wallet.walletId]
    );
    expect(ledger.map((entry) => entry.wallet_version)).toEqual([1, 2, 3, 4, 5]);
    expect(ledger[ledger.length - 1]?.wallet_version).toBe(view.version);
    const sum = ledger.reduce((total, entry) => {
      const value = Number(entry.amount);
      return entry.direction === LedgerDirection.Credit ? total + value : total - value;
    }, 0);
    expect(sum).toBe(65);

    for (const instance of cluster) {
      const health = await http(instance.baseUrl, 'GET', '/health/live');
      expect(health.status).toBe(200);
    }
  }, 180000);

  test('5.15 REFUND antecipado resolve com sucesso quando a BET chega', async () => {
    await resetQueues();
    const wallet = await createWallet('100.00');
    const betExternal = next('bet-late-refund');
    const refund = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        externalTransactionId: next('refund-late'),
        referenceExternalTransactionId: betExternal
      },
      newUuidV7()
    );
    expect(refund.status).toBe(202);

    const bet = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
        externalTransactionId: betExternal
      },
      newUuidV7()
    );
    expect(bet.status).toBe(201);

    await forcePendingDue([String(refund.body.transactionId)]);
    const { pending } = await helper();
    expect(await pending.runOnce()).toBe(1);

    const resolved = await rows<{ status: string; reference_transaction_id: string | null }>(
      'select status, reference_transaction_id from wager_transactions where id = ?',
      [String(refund.body.transactionId)]
    );
    expect(resolved[0]?.status).toBe(WagerTransactionStatus.Processed);
    expect(resolved[0]?.reference_transaction_id).toBe(String(bet.body.transactionId));
    expect((await getWallet(wallet.walletId)).balance.amount).toBe('100.00');

    const ledger = await rows<{ count: number }>(
      'select count(*)::int as count from wallet_ledger_entries where wallet_id = ?',
      [wallet.walletId]
    );
    expect(ledger[0]?.count).toBe(3);
  }, 60000);

  test('5.16 ROLLBACK antecipado resolve com sucesso quando o WIN chega', async () => {
    await resetQueues();
    const wallet = await createWallet('100.00');
    const betExternal = next('bet-late-rollback');
    const winExternal = next('win-late-rollback-success');
    const rollback = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Rollback,
        amount: '40.00',
        externalTransactionId: next('rollback-late-success'),
        referenceExternalTransactionId: winExternal
      },
      newUuidV7()
    );
    expect(rollback.status).toBe(202);

    const bet = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
        externalTransactionId: betExternal
      },
      newUuidV7()
    );
    expect(bet.status).toBe(201);

    const win = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Win,
        amount: '40.00',
        externalTransactionId: winExternal,
        referenceExternalTransactionId: betExternal
      },
      newUuidV7()
    );
    expect(win.status).toBe(201);

    await forcePendingDue([String(rollback.body.transactionId)]);
    const { pending } = await helper();
    expect(await pending.runOnce()).toBe(1);

    const resolved = await rows<{ status: string; reference_transaction_id: string | null }>(
      'select status, reference_transaction_id from wager_transactions where id = ?',
      [String(rollback.body.transactionId)]
    );
    expect(resolved[0]?.status).toBe(WagerTransactionStatus.Processed);
    expect(resolved[0]?.reference_transaction_id).toBe(String(win.body.transactionId));
    expect((await getWallet(wallet.walletId)).balance.amount).toBe('75.00');

    const ledger = await rows<{ count: number }>(
      'select count(*)::int as count from wallet_ledger_entries where wallet_id = ?',
      [wallet.walletId]
    );
    expect(ledger[0]?.count).toBe(4);
  }, 60000);

  test('5.12 ROLLBACK pendente sem saldo é rejeitado com INSUFFICIENT_FUNDS_FOR_REVERSAL', async () => {
    await resetQueues();
    const wallet = await createWallet('100.00');
    const winExternal = next('win-late-rollback');
    const pending = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Rollback,
        amount: '100.00',
        externalTransactionId: next('rollback-late'),
        referenceExternalTransactionId: winExternal
      },
      newUuidV7()
    );
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe(WagerTransactionStatus.PendingReference);

    const fundedBet = next('bet-fund-rollback');
    const fund = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '100.00',
        externalTransactionId: fundedBet
      },
      newUuidV7()
    );
    expect(fund.status).toBe(201);

    const win = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Win,
        amount: '100.00',
        externalTransactionId: winExternal,
        referenceExternalTransactionId: fundedBet
      },
      newUuidV7()
    );
    expect(win.status).toBe(201);

    const spent = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '100.00',
        externalTransactionId: next('bet-spend-reversal')
      },
      newUuidV7()
    );
    expect(spent.status).toBe(201);
    expect((await getWallet(wallet.walletId)).balance.amount).toBe('0.00');

    await forcePendingDue([String(pending.body.transactionId)]);
    const { pending: worker } = await helper();
    expect(await worker.runOnce()).toBe(1);

    const resolved = await rows<{ status: string; failure_code: string | null }>(
      'select status, failure_code from wager_transactions where id = ?',
      [String(pending.body.transactionId)]
    );
    expect(resolved[0]).toEqual({
      status: WagerTransactionStatus.Rejected,
      failure_code: FailureCode.InsufficientFundsForReversal
    });
    expect((await getWallet(wallet.walletId)).balance.amount).toBe('0.00');

    const ledger = await rows<{ count: number }>(
      'select count(*)::int as count from wallet_ledger_entries where wallet_id = ?',
      [wallet.walletId]
    );
    expect(ledger[0]?.count).toBe(4);
  }, 60000);

  test('5.13 dois REFUND concorrentes da mesma BET: 1 crédito e 1 REFERENCE_ALREADY_REVERTED', async () => {
    await resetQueues();
    const wallet = await createWallet('100.00');
    const bet = next('bet-refund-race');
    const betResponse = await postTransaction(
      {
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
        externalTransactionId: bet
      },
      newUuidV7()
    );
    expect(betResponse.status).toBe(201);

    const refund = (external: string) => ({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Refund,
      amount: '25.00',
      externalTransactionId: external,
      referenceExternalTransactionId: bet
    });

    const responses = await Promise.all([
      withRetry(async () => await postTransaction(refund(next('refund-race-a')), newUuidV7())),
      withRetry(async () => await postTransaction(refund(next('refund-race-b')), newUuidV7()))
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
    expect(responses.find((response) => response.status === 422)?.body.failureCode).toBe(
      FailureCode.ReferenceAlreadyReverted
    );

    const view = await getWallet(wallet.walletId);
    expect(view.balance.amount).toBe('100.00');
    const ledger = await rows<{ count: number }>(
      'select count(*)::int as count from wallet_ledger_entries where wallet_id = ?',
      [wallet.walletId]
    );
    expect(ledger[0]?.count).toBe(3);
    const processed = await rows<{ count: number }>(
      `select count(*)::int as count from wager_transactions
          where wallet_id = ? and kind = ? and status = ?`,
      [wallet.walletId, WagerTransactionKind.Refund, WagerTransactionStatus.Processed]
    );
    expect(processed[0]?.count).toBe(1);
  }, 60000);

  test('5.14 invariante global: toda wallet do cenário reconcilia com o ledger', async () => {
    const wallets = await rows<{ id: string }>('select id from wallets order by created_at asc');
    expect(wallets.length).toBeGreaterThan(0);

    for (const wallet of wallets) {
      const reconciliation = await http(
        nextBaseUrl(),
        'POST',
        `/wallets/${wallet.id}/reconciliation`
      );
      expect(reconciliation.status).toBe(200);
      expect(reconciliation.body).toMatchObject({
        walletId: wallet.id,
        difference: { amount: '0.00', currency: CURRENCY },
        consistent: true
      });
      expect(reconciliation.body.storedBalance).toEqual(reconciliation.body.calculatedBalance);
    }
  }, 120000);
});
