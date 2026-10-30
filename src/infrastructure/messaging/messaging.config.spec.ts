import { afterEach, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { loadMessagingSettings } from './messaging.config';
import { SqsMessageQueueAdapter } from './sqs-message-queue.adapter';

const ORIGINAL_ENDPOINT = process.env.SQS_ENDPOINT;

afterEach(() => {
  if (ORIGINAL_ENDPOINT === undefined) {
    delete process.env.SQS_ENDPOINT;
  } else {
    process.env.SQS_ENDPOINT = ORIGINAL_ENDPOINT;
  }
});

describe('loadMessagingSettings', () => {
  test('deriva as URLs default das filas a partir de SQS_ENDPOINT', () => {
    const settings = loadMessagingSettings({
      SQS_ENDPOINT: 'http://localhost:9999'
    } as NodeJS.ProcessEnv);

    expect(settings.wagerQueueUrl).toBe(
      'http://localhost:9999/000000000000/wager-transactions.fifo'
    );
    expect(settings.wagerDlqUrl).toBe(
      'http://localhost:9999/000000000000/wager-transactions-dlq.fifo'
    );
    expect(settings.eventsQueueUrl).toBe('http://localhost:9999/000000000000/wagering-events.fifo');
    expect(settings.eventsDlqUrl).toBe(
      'http://localhost:9999/000000000000/wagering-events-dlq.fifo'
    );
  });

  test('mantém overrides explícitos de URLs de fila', () => {
    const settings = loadMessagingSettings({
      SQS_ENDPOINT: 'http://localhost:9999',
      SQS_WAGER_QUEUE_URL: 'http://custom/wager.fifo'
    } as NodeJS.ProcessEnv);

    expect(settings.wagerQueueUrl).toBe('http://custom/wager.fifo');
    expect(settings.eventsQueueUrl).toBe('http://localhost:9999/000000000000/wagering-events.fifo');
  });

  test('rejeita lote acima do limite do SQS', () => {
    const settings = loadMessagingSettings({
      SQS_MAX_NUMBER_OF_MESSAGES: '50'
    } as NodeJS.ProcessEnv);

    expect(settings.maxNumberOfMessages).toBe(1);
  });

  test('rejeita visibility timeout acima do limite do SQS', () => {
    const settings = loadMessagingSettings({
      SQS_VISIBILITY_TIMEOUT: '999999'
    } as NodeJS.ProcessEnv);

    expect(settings.visibilityTimeoutSeconds).toBe(60);
  });

  test('aplica default e limite para concorrência da outbox', () => {
    const defaults = loadMessagingSettings({} as NodeJS.ProcessEnv);
    expect(defaults.outboxPublishConcurrency).toBe(4);

    const custom = loadMessagingSettings({
      OUTBOX_PUBLISH_CONCURRENCY: '2'
    } as NodeJS.ProcessEnv);
    expect(custom.outboxPublishConcurrency).toBe(2);

    const tooHigh = loadMessagingSettings({
      OUTBOX_PUBLISH_CONCURRENCY: '50'
    } as NodeJS.ProcessEnv);
    expect(tooHigh.outboxPublishConcurrency).toBe(4);
  });
});

describe('SqsMessageQueueAdapter', () => {
  test('usa o endpoint local quando SQS_ENDPOINT não está definido', async () => {
    delete process.env.SQS_ENDPOINT;
    const adapter = new SqsMessageQueueAdapter();
    const client = (
      adapter as unknown as {
        client: SQSClient;
      }
    ).client;

    expect(await client.config.endpoint?.()).toMatchObject({
      protocol: 'http:',
      hostname: 'localhost',
      port: 4566,
      path: '/'
    });
  });
});
