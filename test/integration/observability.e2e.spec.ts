import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import request from 'supertest';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { OUTBOX_REPOSITORY } from '../../src/application/ports/tokens';
import type { OutboxRepository } from '../../src/application/ports/outbox.repository';
import { WagerTransactionConsumer } from '../../src/infrastructure/messaging/wager-transaction.consumer';
import { DlqMetricsCollector } from '../../src/infrastructure/observability/dlq-metrics.collector';
import { OutboxPublisherWorker } from '../../src/infrastructure/messaging/outbox-publisher.worker';
import { sha256Hex } from '../../src/shared/hash/canonical-hash';
import { newUuidV7 } from '../../src/shared/id/uuid';
import { createTestApplication, TestApplication } from './support/app-harness';
import { ensureLocalStack, LocalStackHarness } from './support/localstack-harness';
import { ensurePostgres, PostgresHarness } from './support/postgres-harness';
import { WagerTransactionKind } from '../../src/domain/wager-transaction/wager-transaction-kind';

const PROVIDER = 'provider-observability';
const CURRENCY = 'BRL';

describe('Observability (e2e)', () => {
  let postgres: PostgresHarness;
  let localstack: LocalStackHarness;
  let application: TestApplication;

  const server = () => application.app.getHttpServer();

  beforeAll(async () => {
    postgres = await ensurePostgres();
    localstack = await ensureLocalStack();
    application = await createTestApplication(postgres, 'observability_e2e', {
      SQS_ENDPOINT: localstack.endpoint,
      AWS_DEFAULT_REGION: localstack.region,
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      SQS_WAGER_QUEUE_URL: localstack.queues.wager,
      SQS_WAGER_DLQ_QUEUE_URL: localstack.queues.wagerDlq,
      SQS_EVENTS_QUEUE_URL: localstack.queues.events,
      SQS_EVENTS_DLQ_QUEUE_URL: localstack.queues.eventsDlq,
      MESSAGING_ENABLED: '0',
      METRICS_DLQ_ENABLED: '0'
    });
  }, 240000);

  afterAll(async () => {
    await application?.close();
    await localstack?.stop();
    await postgres?.stop();
  }, 240000);

  test('health/ready verifica PostgreSQL e SQS', async () => {
    const response = await request(server()).get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'OK',
      checks: { postgres: 'UP', sqs: 'UP' }
    });
  });

  test('health/live responde sem dependências', async () => {
    const response = await request(server()).get('/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'OK' });
  });

  test('/metrics expõe métricas Prometheus e evolui com o processamento', async () => {
    const playerId = newUuidV7();
    const wallet = await request(server())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '100.00', currency: CURRENCY } });
    expect(wallet.status).toBe(201);

    const bet = await request(server())
      .post('/wagering/transactions')
      .set('Idempotency-Key', newUuidV7())
      .send({
        providerId: PROVIDER,
        externalTransactionId: `obs-${Date.now()}`,
        playerId,
        walletId: wallet.body.id,
        roundId: 'round-observability',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: CURRENCY }
      });
    expect(bet.status).toBe(201);

    const response = await request(server()).get('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');

    const body = response.text;
    expect(body).toMatch(/wager_transactions_total\{[^}]*status="PROCESSED"[^}]*\} [1-9]/);
    expect(body).toContain('wager_transaction_processing_seconds_count');
    expect(body).toContain('outbox_pending');
    expect(body).toContain('db_lock_wait_seconds_count');
  });

  test('duplicatas de inbox do consumer aparecem no /metrics', async () => {
    const consumer = application.app.get(WagerTransactionConsumer);
    const playerId = newUuidV7();
    const wallet = await request(server())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '100.00', currency: CURRENCY } });
    expect(wallet.status).toBe(201);

    const messageId = `obs-dup-${Date.now()}`;
    const externalTransactionId = `obs-dup-ext-${Date.now()}`;
    const body = JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: PROVIDER,
        externalTransactionId,
        idempotencyKey: `key-${externalTransactionId}`,
        playerId,
        walletId: wallet.body.id,
        roundId: 'round-observability-dup',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: CURRENCY }
      }
    });

    const send = async (deduplicationId: string): Promise<void> => {
      await localstack.client.send(
        new SendMessageCommand({
          QueueUrl: localstack.queues.wager,
          MessageBody: body,
          MessageGroupId: wallet.body.id,
          MessageDeduplicationId: deduplicationId
        })
      );
    };

    await send(sha256Hex(`${messageId}-a`));
    expect(await consumer.runOnce()).toBe(1);
    await send(sha256Hex(`${messageId}-b`));
    expect(await consumer.runOnce()).toBe(1);

    const bodyMetrics = (await request(server()).get('/metrics')).text;
    expect(bodyMetrics).toMatch(
      /wager_inbox_duplicates_total\{[^}]*outcome="DUPLICATE"[^}]*\} [1-9]/
    );
    const walletView = await request(server()).get(`/wallets/${wallet.body.id}`);
    expect(walletView.body.balance.amount).toBe('75.00');
  });

  test('outbox expõe profundidade/published lag e o coletor publica gauges das DLQs', async () => {
    const outbox = application.app.get<OutboxRepository>(OUTBOX_REPOSITORY);
    expect(await outbox.countPending()).toBeGreaterThan(0);
    expect(await outbox.countDeadLettered()).toBe(0);

    const worker = application.app.get(OutboxPublisherWorker);
    await worker.runOnce();
    await worker.runOnce();
    expect(await outbox.countPending()).toBe(0);

    const collector = application.app.get(DlqMetricsCollector);
    await collector.collect();

    const body = (await request(server()).get('/metrics')).text;
    expect(body).toMatch(/outbox_pending(\{[^}]*\})? 0/);
    expect(body).toMatch(/outbox_publish_lag_seconds_count(\{[^}]*\})? [1-9]/);
    expect(body).toMatch(
      /sqs_dlq_messages\{[^}]*queue="WAGER_TRANSACTIONS_DLQ"[^}]*collector_instance="[^"]+"/
    );
    expect(body).toMatch(
      /sqs_dlq_oldest_message_age_seconds\{[^}]*queue="WAGERING_EVENTS_DLQ"[^}]*\}/
    );
  });
});
