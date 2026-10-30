import { describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { MessageQueuePort, QueueAttributes } from '../../application/ports/message-queue.port';
import type { MessagingSettings } from '../messaging/messaging.config';
import { DependencyStatus, HealthStatus } from '../../application/ports/readiness.port';
import { ReadinessService } from './readiness.service';

const SETTINGS: MessagingSettings = {
  enabled: false,
  consumerName: 'wager-transactions',
  wagerQueueUrl: 'http://sqs/wager',
  wagerDlqUrl: 'http://sqs/wager-dlq',
  eventsQueueUrl: 'http://sqs/events',
  eventsDlqUrl: 'http://sqs/events-dlq',
  visibilityTimeoutSeconds: 60,
  maxNumberOfMessages: 1,
  pollIntervalMs: 1000,
  drainTimeoutMs: 30000,
  outboxLeaseMs: 30000,
  outboxBatchSize: 10,
  outboxPublishConcurrency: 4,
  pendingLeaseMs: 30000,
  pendingBatchSize: 10,
  consumerMaxReceiveCount: 5,
  faultAfterCommitBeforeAck: false,
  faultAfterPublishBeforeMark: false
};

function orm(healthy: boolean): MikroORM {
  return {
    em: {
      fork: () => ({
        execute: async () => {
          if (!healthy) {
            throw new Error('database unavailable');
          }
          return [];
        }
      })
    }
  } as unknown as MikroORM;
}

function queue(healthy: boolean, failingUrl?: string): MessageQueuePort {
  const attributes: QueueAttributes = {
    approximateNumberOfMessages: 0,
    oldestMessageAgeSeconds: 0
  };
  return {
    receive: async () => [],
    delete: async () => undefined,
    changeVisibility: async () => undefined,
    publish: async () => undefined,
    getQueueAttributes: async (url: string) => {
      if (!healthy || url === failingUrl) {
        throw new Error('sqs unavailable');
      }
      return attributes;
    }
  };
}

describe('ReadinessService', () => {
  test('ready quando PostgreSQL e SQS respondem', async () => {
    const service = new ReadinessService(orm(true), queue(true), SETTINGS);
    await expect(service.check()).resolves.toEqual({
      status: HealthStatus.Ok,
      checks: { postgres: DependencyStatus.Up, sqs: DependencyStatus.Up }
    });
  });

  test('not ready quando PostgreSQL falha', async () => {
    const service = new ReadinessService(orm(false), queue(true), SETTINGS);
    await expect(service.check()).resolves.toEqual({
      status: HealthStatus.Error,
      checks: { postgres: DependencyStatus.Down, sqs: DependencyStatus.Up }
    });
  });

  test('not ready quando SQS falha', async () => {
    const service = new ReadinessService(orm(true), queue(false), SETTINGS);
    await expect(service.check()).resolves.toEqual({
      status: HealthStatus.Error,
      checks: { postgres: DependencyStatus.Up, sqs: DependencyStatus.Down }
    });
  });

  test('not ready quando qualquer fila relevante (eventos/DLQ) falha', async () => {
    const service = new ReadinessService(orm(true), queue(true, SETTINGS.eventsDlqUrl), SETTINGS);
    await expect(service.check()).resolves.toEqual({
      status: HealthStatus.Error,
      checks: { postgres: DependencyStatus.Up, sqs: DependencyStatus.Down }
    });
  });
});
