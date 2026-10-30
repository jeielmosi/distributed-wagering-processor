import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import request from 'supertest';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand
} from '@aws-sdk/client-sqs';
import { WagerTransactionConsumer } from '../../src/infrastructure/messaging/wager-transaction.consumer';
import { OutboxPublisherWorker } from '../../src/infrastructure/messaging/outbox-publisher.worker';
import { PendingReferenceWorker } from '../../src/infrastructure/messaging/pending-reference.worker';
import { metrics } from '../../src/infrastructure/observability/metrics';
import { MESSAGING_SETTINGS } from '../../src/infrastructure/messaging/messaging.tokens';
import type { MessagingSettings } from '../../src/infrastructure/messaging/messaging.config';
import { newUuidV7 } from '../../src/shared/id/uuid';
import { sha256Hex } from '../../src/shared/hash/canonical-hash';
import { ensurePostgres, PostgresHarness } from './support/postgres-harness';
import { ensureLocalStack, LocalStackHarness } from './support/localstack-harness';
import { createTestApplication, TestApplication } from './support/app-harness';
import { insertOutboxMessage, insertTransaction } from './support/sql-fixtures';
import { WagerTransactionKind } from '../../src/domain/wager-transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction-status';
import { FailureCode } from '../../src/shared/errors/failure-code';

const PROVIDER = 'provider-sqs';
const CURRENCY = 'BRL';

interface WalletFixture {
  walletId: string;
  playerId: string;
}

interface MessageOverrides {
  messageId?: string;
  kind?: string;
  amount?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  referenceExternalTransactionId?: string;
  roundId?: string;
  correlationId?: string;
}

describe('SQS messaging (integration)', () => {
  let harness: PostgresHarness;
  let localstack: LocalStackHarness;
  let application: TestApplication;
  let consumer: WagerTransactionConsumer;
  let outboxWorker: OutboxPublisherWorker;
  let pendingWorker: PendingReferenceWorker;
  let sequence = 0;

  const server = () => application.app.getHttpServer();
  const em = () => application.database.orm.em.fork();

  function next(prefix: string): string {
    sequence += 1;
    return `${prefix}-${Date.now()}-${sequence}`;
  }

  async function createWallet(initialBalance = '100.00'): Promise<WalletFixture> {
    const playerId = newUuidV7();
    const response = await request(server())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: initialBalance, currency: CURRENCY } });
    expect(response.status).toBe(201);
    return { walletId: response.body.id, playerId };
  }

  function body(wallet: WalletFixture, overrides: MessageOverrides = {}): string {
    const externalTransactionId = overrides.externalTransactionId ?? next('ext');
    return JSON.stringify({
      messageId: overrides.messageId ?? next('msg'),
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      ...(overrides.correlationId === undefined ? {} : { correlationId: overrides.correlationId }),
      data: {
        providerId: PROVIDER,
        externalTransactionId,
        idempotencyKey: overrides.idempotencyKey ?? `key-${externalTransactionId}`,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: overrides.roundId ?? 'round-sqs',
        gameId: 'fortune-chimp',
        kind: overrides.kind ?? WagerTransactionKind.Bet,
        money: { amount: overrides.amount ?? '25.00', currency: CURRENCY },
        ...(overrides.referenceExternalTransactionId === undefined
          ? {}
          : {
              referenceExternalTransactionId: overrides.referenceExternalTransactionId
            })
      }
    });
  }

  async function send(
    raw: string,
    groupId: string,
    dedup?: string,
    attributes?: Record<string, string>
  ): Promise<void> {
    await localstack.client.send(
      new SendMessageCommand({
        QueueUrl: localstack.queues.wager,
        MessageBody: raw,
        MessageGroupId: groupId,
        MessageDeduplicationId: dedup ?? sha256Hex(`${raw}-${newUuidV7()}`),
        ...(attributes === undefined
          ? {}
          : {
              MessageAttributes: Object.fromEntries(
                Object.entries(attributes).map(([key, value]) => [
                  key,
                  { DataType: 'String', StringValue: value }
                ])
              )
            })
      })
    );
  }

  async function drain(queueUrl: string, limit = 50): Promise<string[]> {
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

  async function inboxDuplicateMetric(outcome: 'DUPLICATE' | 'PAYLOAD_MISMATCH'): Promise<number> {
    const output = await metrics.render();
    const match = output.match(
      new RegExp(`wager_inbox_duplicates_total\\{[^}]*outcome="${outcome}"[^}]*\\} (\\d+)`)
    );
    return match === null ? 0 : Number(match[1]);
  }

  async function getWallet(walletId: string) {
    const response = await request(server()).get(`/wallets/${walletId}`);
    expect(response.status).toBe(200);
    return response.body as { balance: { amount: string }; version: number };
  }

  async function installTransientFailureTrigger(): Promise<void> {
    await em().execute(`
      create or replace function test_transient_failure() returns trigger as $$
      begin
        raise exception 'transient test failure' using errcode = '40001';
      end;
      $$ language plpgsql
    `);
    await em().execute(`
      create trigger trg_test_transient_failure
        before insert on wager_transactions
        for each row execute function test_transient_failure()
    `);
  }

  async function removeTransientFailureTrigger(): Promise<void> {
    await em().execute('drop trigger if exists trg_test_transient_failure on wager_transactions');
    await em().execute('drop function if exists test_transient_failure()');
  }

  async function transactionByKey(key: string) {
    const rows = await em().execute<{ id: string; status: string; failure_code: string | null }[]>(
      'select id, status, failure_code from wager_transactions where idempotency_key = ?',
      [key]
    );
    return rows[0];
  }

  beforeAll(async () => {
    harness = await ensurePostgres();
    localstack = await ensureLocalStack();
    application = await createTestApplication(harness, 'messaging_e2e', {
      SQS_ENDPOINT: localstack.endpoint,
      AWS_DEFAULT_REGION: localstack.region,
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      SQS_WAGER_QUEUE_URL: localstack.queues.wager,
      SQS_WAGER_DLQ_QUEUE_URL: localstack.queues.wagerDlq,
      SQS_EVENTS_QUEUE_URL: localstack.queues.events,
      SQS_EVENTS_DLQ_QUEUE_URL: localstack.queues.eventsDlq,
      MESSAGING_ENABLED: '0',
      SQS_VISIBILITY_TIMEOUT: '60',
      SQS_MAX_NUMBER_OF_MESSAGES: '1'
    });
    consumer = application.app.get(WagerTransactionConsumer);
    outboxWorker = application.app.get(OutboxPublisherWorker);
    pendingWorker = application.app.get(PendingReferenceWorker);
  }, 240000);

  beforeEach(async () => {
    await localstack.purgeAll();
    await drain(localstack.queues.wager);
    await drain(localstack.queues.wagerDlq);
    await drain(localstack.queues.events);
    await drain(localstack.queues.eventsDlq);
  }, 30000);

  afterAll(async () => {
    if (application !== undefined) {
      await application.close();
    }
    if (localstack !== undefined) {
      await localstack.stop();
    }
    if (harness !== undefined) {
      await harness.stop();
    }
  }, 120000);

  test('BET via SQS é processada, ackada e redelivery não duplica o efeito', async () => {
    const wallet = await createWallet('100.00');
    const messageId = next('msg-bet');
    const raw = body(wallet, { messageId, amount: '25.00' });

    await send(raw, wallet.walletId);
    expect(await consumer.runOnce()).toBe(1);

    expect((await getWallet(wallet.walletId)).balance.amount).toBe('75.00');
    const inboxCount = await em().execute<{ count: string }[]>(
      'select count(*)::text as count from inbox_messages where message_id = ?',
      [messageId]
    );
    expect(inboxCount[0]?.count).toBe('1');

    await send(raw, wallet.walletId, sha256Hex(`${messageId}-redelivery`));
    expect(await consumer.runOnce()).toBe(1);

    expect((await getWallet(wallet.walletId)).balance.amount).toBe('75.00');
    const transactions = await em().execute<{ count: string }[]>(
      'select count(*)::text as count from wager_transactions where wallet_id = ? and kind <> ?',
      [wallet.walletId, WagerTransactionKind.Opening]
    );
    expect(transactions[0]?.count).toBe('1');
    expect(await queueDepth(localstack.queues.wagerDlq)).toBe(0);
  }, 30000);

  test('50 mensagens idênticas em paralelo: inbox ON CONFLICT e efeito único', async () => {
    const wallet = await createWallet('100.00');
    const messageId = next('msg-inbox-race');
    const raw = body(wallet, { messageId, amount: '25.00' });
    const duplicatesBefore = await inboxDuplicateMetric('DUPLICATE');

    await Promise.all(
      Array.from(
        { length: 50 },
        async (_, index) =>
          await send(raw, `inbox-race-${index}`, sha256Hex(`${messageId}-${index}`))
      )
    );

    let received = 0;
    const parallel = await Promise.all(
      Array.from({ length: 50 }, async () => await consumer.runOnce())
    );
    received += parallel.reduce((total, count) => total + count, 0);
    const deadline = Date.now() + 20000;
    while (received < 50 && Date.now() < deadline) {
      received += await consumer.runOnce();
      if (received < 50) {
        await Bun.sleep(50);
      }
    }

    expect(received).toBe(50);
    expect((await getWallet(wallet.walletId)).balance.amount).toBe('75.00');

    const stats = await em().execute<{ inbox_count: string; transaction_count: string }[]>(
      `select
           (select count(*)::text from inbox_messages where message_id = ?) as inbox_count,
           (select count(*)::text from wager_transactions
             where wallet_id = ? and kind <> ?) as transaction_count`,
      [messageId, wallet.walletId, WagerTransactionKind.Opening]
    );
    expect(stats[0]).toEqual({ inbox_count: '1', transaction_count: '1' });
    expect((await inboxDuplicateMetric('DUPLICATE')) - duplicatesBefore).toBe(49);
    expect(await queueDepth(localstack.queues.wagerDlq)).toBe(0);
  }, 60000);

  test('BET sem saldo é persistida como REJECTED e ackada', async () => {
    const wallet = await createWallet('10.00');
    const key = next('key-insufficient');
    await send(body(wallet, { amount: '25.00', idempotencyKey: key }), wallet.walletId);

    expect(await consumer.runOnce()).toBe(1);

    const stored = await transactionByKey(key);
    expect(stored?.status).toBe(WagerTransactionStatus.Rejected);
    expect(stored?.failure_code).toBe(FailureCode.InsufficientFunds);
    expect((await getWallet(wallet.walletId)).balance.amount).toBe('10.00');
    expect(await queueDepth(localstack.queues.wagerDlq)).toBe(0);
  }, 30000);

  test('WALLET_NOT_FOUND é permanente e vai para a DLQ sem persistir transação', async () => {
    const wallet = await createWallet('100.00');
    const missing = { walletId: newUuidV7(), playerId: wallet.playerId };
    const key = next('key-missing-wallet');
    await send(body(missing, { amount: '10.00', idempotencyKey: key }), missing.walletId);

    expect(await consumer.runOnce()).toBe(1);

    expect(await queueDepth(localstack.queues.wagerDlq)).toBe(1);
    expect(await queueDepth(localstack.queues.wager)).toBe(0);
    expect(await transactionByKey(key)).toBeUndefined();
  }, 30000);

  test('envelope estruturalmente inválido vai direto para a DLQ', async () => {
    await send(JSON.stringify({ messageId: 'bad-envelope', type: 'SomethingElse' }), 'poison');

    expect(await consumer.runOnce()).toBe(1);

    const dlq = await drain(localstack.queues.wagerDlq);
    expect(dlq).toHaveLength(1);
    expect(JSON.parse(dlq[0] ?? '{}')).toMatchObject({ messageId: 'bad-envelope' });
    expect(await queueDepth(localstack.queues.wager)).toBe(0);
  }, 30000);

  test('redrive por maxReceiveCount=5 move poison para a DLQ após 5 receives', async () => {
    const wallet = await createWallet('100.00');
    const messageId = next('msg-redrive');
    const raw = body(wallet, { messageId, amount: '10.00' });
    await send(raw, wallet.walletId, sha256Hex(messageId));

    let receives = 0;
    const deadline = Date.now() + 20000;
    while ((await queueDepth(localstack.queues.wagerDlq)) === 0 && Date.now() < deadline) {
      const response = await localstack.client.send(
        new ReceiveMessageCommand({
          QueueUrl: localstack.queues.wager,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 0,
          VisibilityTimeout: 0
        })
      );
      const batch = response.Messages?.length ?? 0;
      receives += batch;
      if (batch === 0) {
        await Bun.sleep(50);
      }
    }

    expect(receives).toBeGreaterThanOrEqual(5);
    expect(await queueDepth(localstack.queues.wagerDlq)).toBe(1);
    const dlq = await drain(localstack.queues.wagerDlq);
    expect(dlq).toHaveLength(1);
    expect(JSON.parse(dlq[0] ?? '{}')).toMatchObject({ messageId });
    expect(await queueDepth(localstack.queues.wager)).toBe(0);
  }, 30000);

  test('mesmo messageId com payload divergente vai para a DLQ', async () => {
    const wallet = await createWallet('100.00');
    const messageId = next('msg-hash');
    const mismatchesBefore = await inboxDuplicateMetric('PAYLOAD_MISMATCH');

    await send(
      body(wallet, {
        messageId,
        amount: '5.00',
        externalTransactionId: 'hash-a'
      }),
      wallet.walletId
    );
    expect(await consumer.runOnce()).toBe(1);

    await send(
      body(wallet, {
        messageId,
        amount: '7.00',
        externalTransactionId: 'hash-b'
      }),
      wallet.walletId
    );
    expect(await consumer.runOnce()).toBe(1);

    expect(await queueDepth(localstack.queues.wagerDlq)).toBe(1);
    expect((await getWallet(wallet.walletId)).balance.amount).toBe('95.00');
    expect((await inboxDuplicateMetric('PAYLOAD_MISMATCH')) - mismatchesBefore).toBe(1);
  }, 30000);

  test('outbox publica os eventos da transação processada', async () => {
    const wallet = await createWallet('100.00');
    const messageId = next('msg-outbox');
    const correlationId = next('corr');
    await send(body(wallet, { messageId, amount: '12.00', correlationId }), wallet.walletId);
    expect(await consumer.runOnce()).toBe(1);

    const pendingBefore = await em().execute<{ count: string }[]>(
      `select count(*)::text as count from outbox_messages
        where aggregate_id = ? and published_at is null`,
      [wallet.walletId]
    );
    expect(Number(pendingBefore[0]?.count)).toBeGreaterThanOrEqual(2);

    while ((await outboxWorker.runOnce()) > 0) {
      // Drain every pending batch so the assertion is independent of batch size.
    }

    const pendingAfter = await em().execute<{ count: string }[]>(
      `select count(*)::text as count from outbox_messages
        where aggregate_id = ? and published_at is null`,
      [wallet.walletId]
    );
    expect(pendingAfter[0]?.count).toBe('0');

    const events = (await drain(localstack.queues.events)).map(
      (raw) => JSON.parse(raw) as Record<string, unknown>
    );
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(
      events.some(
        (event) =>
          event.eventType === 'WagerTransactionProcessed' && event.correlationId === correlationId
      )
    ).toBe(true);
    const processed = events.find((event) => {
      const data = event.data as { walletId?: string } | undefined;
      return event.eventType === 'WagerTransactionProcessed' && data?.walletId === wallet.walletId;
    });
    expect(processed?.aggregateId).toBeDefined();
  }, 30000);

  test('correlationId pode vir do atributo SQS e causationId é o messageId do inbox', async () => {
    const wallet = await createWallet('100.00');
    const messageId = next('msg-attribute');
    const raw = body(wallet, { messageId, amount: '9.00' });

    await send(raw, wallet.walletId, undefined, { correlationId: 'corr-attribute' });
    expect(await consumer.runOnce()).toBe(1);

    while ((await outboxWorker.runOnce()) > 0) {
      // Drain all pending events.
    }

    const events = (await drain(localstack.queues.events)).map(
      (payload) => JSON.parse(payload) as Record<string, unknown>
    );
    const processed = events.find((event) => {
      const data = event.data as { walletId?: string; kind?: string } | undefined;
      return (
        event.eventType === 'WagerTransactionProcessed' &&
        data?.walletId === wallet.walletId &&
        data?.kind === WagerTransactionKind.Bet
      );
    });
    expect(processed?.correlationId).toBe('corr-attribute');
    expect(processed?.causationId).toBe(messageId);
  }, 30000);

  test('outbox envia para a DLQ após 10 falhas de publicação', async () => {
    while ((await outboxWorker.runOnce()) > 0) {
      // Publish everything pending from previous scenarios first.
    }
    const settings = application.app.get<MessagingSettings>(MESSAGING_SETTINGS);
    const id = await insertOutboxMessage(em(), {
      attempts: 9,
      occurredAt: new Date(Date.now() - 60_000),
      nextAttemptAt: new Date(Date.now() - 30_000),
      payload: { eventId: 'evt-dlq', correlationId: 'corr-dlq' }
    });
    const original = settings.eventsQueueUrl;
    settings.eventsQueueUrl = `${localstack.endpoint}/000000000000/does-not-exist.fifo`;

    try {
      await outboxWorker.runOnce();
    } finally {
      settings.eventsQueueUrl = original;
    }

    const rows = await em().execute<{ dead_lettered_at: Date | null; attempts: number }[]>(
      'select dead_lettered_at, attempts from outbox_messages where id = ?',
      [id]
    );
    expect(rows[0]?.dead_lettered_at).not.toBeNull();
    expect(rows[0]?.attempts).toBe(10);
    expect(await queueDepth(localstack.queues.eventsDlq)).toBe(1);
  }, 30000);

  test('LOSS antes da BET fica PENDING_REFERENCE e o worker resolve quando a BET chega', async () => {
    const wallet = await createWallet('100.00');
    const roundId = 'round-late-loss';
    const lossResponse = await request(server())
      .post('/wagering/transactions')
      .set('Idempotency-Key', next('key-loss'))
      .send({
        providerId: PROVIDER,
        externalTransactionId: 'loss-late',
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId,
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Loss,
        money: { amount: '10.00', currency: CURRENCY },
        referenceExternalTransactionId: 'bet-late'
      });
    expect(lossResponse.status).toBe(202);
    expect(lossResponse.body.status).toBe(WagerTransactionStatus.PendingReference);

    const betResponse = await request(server())
      .post('/wagering/transactions')
      .set('Idempotency-Key', next('key-bet-late'))
      .send({
        providerId: PROVIDER,
        externalTransactionId: 'bet-late',
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId,
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: CURRENCY }
      });
    expect(betResponse.status).toBe(201);

    await em().execute(
      `update wager_transactions
          set next_reference_attempt_at = now() - interval '1 second'
        where external_transaction_id = 'loss-late'`
    );

    expect(await pendingWorker.runOnce()).toBe(1);

    const rows = await em().execute<{ status: string; reference_transaction_id: string | null }[]>(
      `select status, reference_transaction_id from wager_transactions
        where external_transaction_id = 'loss-late'`
    );
    expect(rows[0]?.status).toBe(WagerTransactionStatus.Processed);
    expect(rows[0]?.reference_transaction_id).toBe(betResponse.body.transactionId);
  }, 30000);

  test('PENDING_REFERENCE expirada é rejeitada com REFERENCE_NOT_FOUND', async () => {
    const wallet = await createWallet('100.00');
    const winResponse = await request(server())
      .post('/wagering/transactions')
      .set('Idempotency-Key', next('key-expired'))
      .send({
        providerId: PROVIDER,
        externalTransactionId: next('win-expired'),
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-expired',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Win,
        money: { amount: '10.00', currency: CURRENCY },
        referenceExternalTransactionId: next('missing-bet')
      });
    expect(winResponse.status).toBe(202);

    await em().execute(
      `update wager_transactions
          set created_at = now() - interval '2 hours',
              reference_expires_at = now() - interval '1 hour',
              next_reference_attempt_at = now() - interval '61 minutes'
        where id = ?`,
      [winResponse.body.transactionId]
    );

    expect(await pendingWorker.runOnce()).toBe(1);

    const rows = await em().execute<
      { status: string; failure_code: string | null; resolved_at: Date | null }[]
    >('select status, failure_code, resolved_at from wager_transactions where id = ?', [
      winResponse.body.transactionId
    ]);
    expect(rows[0]?.status).toBe(WagerTransactionStatus.Rejected);
    expect(rows[0]?.failure_code).toBe(FailureCode.ReferenceNotFound);
    expect(rows[0]?.resolved_at).not.toBeNull();
  }, 30000);

  test('dois settlements pendentes da mesma BET: um processa e o outro é rejeitado', async () => {
    const wallet = await createWallet('100.00');
    const roundId = 'round-settlement';

    const winIds: string[] = [];
    for (const external of ['win-settle-1', 'win-settle-2']) {
      const response = await request(server())
        .post('/wagering/transactions')
        .set('Idempotency-Key', next(`key-${external}`))
        .send({
          providerId: PROVIDER,
          externalTransactionId: external,
          playerId: wallet.playerId,
          walletId: wallet.walletId,
          roundId,
          gameId: 'fortune-chimp',
          kind: WagerTransactionKind.Win,
          money: { amount: '10.00', currency: CURRENCY },
          referenceExternalTransactionId: 'bet-settle'
        });
      expect(response.status).toBe(202);
      winIds.push(response.body.transactionId);
    }

    const bet = await request(server())
      .post('/wagering/transactions')
      .set('Idempotency-Key', next('key-bet-settle'))
      .send({
        providerId: PROVIDER,
        externalTransactionId: 'bet-settle',
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId,
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: CURRENCY }
      });
    expect(bet.status).toBe(201);

    for (const winId of winIds) {
      await em().execute(
        `update wager_transactions
            set next_reference_attempt_at = now() - interval '1 second'
          where id = ?`,
        [winId]
      );
    }

    expect(await pendingWorker.runOnce()).toBe(2);

    const rows: { status: string; failure_code: string | null }[] = [];
    for (const winId of winIds) {
      const result = await em().execute<{ status: string; failure_code: string | null }[]>(
        'select status, failure_code from wager_transactions where id = ?',
        [winId]
      );
      if (result[0] !== undefined) {
        rows.push(result[0]);
      }
    }
    expect(rows.filter((row) => row.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(rows.filter((row) => row.status === WagerTransactionStatus.Rejected)).toHaveLength(1);
    expect(rows.find((row) => row.status === WagerTransactionStatus.Rejected)?.failure_code).toBe(
      FailureCode.ReferenceAlreadySettled
    );
  }, 30000);

  test('PENDING_REFERENCE aguardando outro alvo pendente não consome reference_attempts', async () => {
    const wallet = await createWallet('100.00');
    const roundId = 'round-chain';
    const refund = await request(server())
      .post('/wagering/transactions')
      .set('Idempotency-Key', next('key-refund-chain'))
      .send({
        providerId: PROVIDER,
        externalTransactionId: 'refund-chain',
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId,
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Refund,
        money: { amount: '10.00', currency: CURRENCY },
        referenceExternalTransactionId: 'missing-for-chain'
      });
    expect(refund.status).toBe(202);

    const loss = await request(server())
      .post('/wagering/transactions')
      .set('Idempotency-Key', next('key-loss-chain'))
      .send({
        providerId: PROVIDER,
        externalTransactionId: 'loss-chain',
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId,
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Loss,
        money: { amount: '10.00', currency: CURRENCY },
        referenceExternalTransactionId: 'refund-chain'
      });
    expect(loss.status).toBe(202);

    await em().execute(
      `update wager_transactions
          set next_reference_attempt_at = now() - interval '1 second'
        where external_transaction_id = 'loss-chain'`
    );

    expect(await pendingWorker.runOnce()).toBe(1);

    const rows = await em().execute<
      { status: string; reference_attempts: number; next_reference_attempt_at: Date }[]
    >(
      `select status, reference_attempts, next_reference_attempt_at
         from wager_transactions where external_transaction_id = 'loss-chain'`
    );
    expect(rows[0]?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(rows[0]?.reference_attempts).toBe(0);
    expect(new Date(rows[0]?.next_reference_attempt_at ?? 0).getTime()).toBeGreaterThan(Date.now());
  }, 30000);

  test('recuperação de conflito de reversão grava inbox na mesma transação', async () => {
    const wallet = await createWallet('100.00');
    const betExternal = next('bet-conflict');
    const bet = await request(server())
      .post('/wagering/transactions')
      .set('Idempotency-Key', next('key-bet-conflict'))
      .send({
        providerId: PROVIDER,
        externalTransactionId: betExternal,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-sqs',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: CURRENCY }
      });
    expect(bet.status).toBe(201);

    const refunds = [1, 2].map((index) => ({
      messageId: next(`msg-refund-conflict-${index}`),
      externalTransactionId: next(`refund-conflict-${index}`)
    }));
    for (const [index, refund] of refunds.entries()) {
      const raw = body(wallet, {
        messageId: refund.messageId,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        externalTransactionId: refund.externalTransactionId,
        idempotencyKey: next(`key-${refund.externalTransactionId}`),
        referenceExternalTransactionId: betExternal
      });
      await send(raw, `group-refund-conflict-${index}`);
    }

    const processed = await Promise.all([consumer.runOnce(), consumer.runOnce()]);
    expect(processed.reduce((total, count) => total + count, 0)).toBe(2);
    expect(await queueDepth(localstack.queues.wager)).toBe(0);

    const rows = await em().execute<
      { external_transaction_id: string; status: string; failure_code: string | null }[]
    >(
      `select external_transaction_id, status, failure_code
         from wager_transactions
        where external_transaction_id in (?, ?)`,
      [refunds[0]?.externalTransactionId, refunds[1]?.externalTransactionId]
    );
    expect(rows.filter((row) => row.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(rows.filter((row) => row.status === WagerTransactionStatus.Rejected)).toHaveLength(1);
    expect(rows.find((row) => row.status === WagerTransactionStatus.Rejected)?.failure_code).toBe(
      FailureCode.ReferenceAlreadyReverted
    );

    const inbox = await em().execute<{ count: string }[]>(
      `select count(*)::text as count
         from inbox_messages
        where message_id in (?, ?)`,
      [refunds[0]?.messageId, refunds[1]?.messageId]
    );
    expect(inbox[0]?.count).toBe('2');
    expect((await getWallet(wallet.walletId)).balance.amount).toBe('100.00');
  }, 60000);

  test('erro transitório deixa a mensagem invisível e o redelivery processa depois', async () => {
    const wallet = await createWallet('100.00');
    const messageId = next('msg-transient');
    const externalTransactionId = next('bet-transient');
    const raw = body(wallet, {
      messageId,
      externalTransactionId,
      amount: '25.00'
    });

    try {
      await installTransientFailureTrigger();
      await send(raw, wallet.walletId);
      expect(await consumer.runOnce()).toBe(1);

      const before = await em().execute<{ count: string }[]>(
        `select count(*)::text as count
           from wager_transactions
          where wallet_id = ? and kind <> ?`,
        [wallet.walletId, WagerTransactionKind.Opening]
      );
      expect(before[0]?.count).toBe('0');
      expect(await queueDepth(localstack.queues.wager)).toBe(0);
    } finally {
      await removeTransientFailureTrigger();
    }

    await Bun.sleep(6000);
    expect(await consumer.runOnce()).toBe(1);

    expect((await getWallet(wallet.walletId)).balance.amount).toBe('75.00');
    const inbox = await em().execute<{ count: string }[]>(
      'select count(*)::text as count from inbox_messages where message_id = ?',
      [messageId]
    );
    expect(inbox[0]?.count).toBe('1');
  }, 30000);

  test('WIN sem alvo via SQS fica PENDING_REFERENCE e ackado com inbox atômico', async () => {
    const wallet = await createWallet('100.00');
    await insertTransaction(em(), {
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Bet,
      status: WagerTransactionStatus.Processed,
      externalTransactionId: 'unrelated'
    });

    const raw = body(wallet, {
      messageId: 'msg-invalid-kind',
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'bet-ref-invalid'
    });
    await send(raw, wallet.walletId);
    expect(await consumer.runOnce()).toBe(1);

    expect(await queueDepth(localstack.queues.wagerDlq)).toBe(0);
    const inbox = await em().execute<{ count: string }[]>(
      "select count(*)::text as count from inbox_messages where message_id = 'msg-invalid-kind'"
    );
    expect(inbox[0]?.count).toBe('1');
  }, 30000);
});
