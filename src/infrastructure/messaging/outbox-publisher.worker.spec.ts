import { describe, expect, test } from 'bun:test';
import type { Clock } from '../../application/ports/clock.port';
import type { MessageQueuePort, PublishOptions } from '../../application/ports/message-queue.port';
import type { OutboxRepository } from '../../application/ports/outbox.repository';
import type { TransactionContext, UnitOfWork } from '../../application/ports/transaction-context';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { MessagingSettings } from './messaging.config';
import { OutboxPublisherWorker } from './outbox-publisher.worker';

const NOW = new Date('2026-10-30T12:00:00.000Z');

function settings(concurrency: number): MessagingSettings {
  return {
    enabled: false,
    consumerName: 'wager-transactions',
    wagerQueueUrl: 'http://sqs/wager',
    wagerDlqUrl: 'http://sqs/wager-dlq',
    eventsQueueUrl: 'http://sqs/events',
    eventsDlqUrl: 'http://sqs/events-dlq',
    visibilityTimeoutSeconds: 60,
    maxNumberOfMessages: 1,
    pollIntervalMs: 1000,
    drainTimeoutMs: 1000,
    outboxLeaseMs: 30000,
    outboxBatchSize: 10,
    outboxPublishConcurrency: concurrency,
    pendingLeaseMs: 30000,
    pendingBatchSize: 10,
    consumerMaxReceiveCount: 5,
    faultAfterCommitBeforeAck: false,
    faultAfterPublishBeforeMark: false
  };
}

class FakeQueue implements MessageQueuePort {
  inFlight = 0;
  maxInFlight = 0;
  readonly published: string[] = [];
  readonly failFor = new Set<string>();

  async receive(): Promise<[]> {
    return [];
  }

  async delete(): Promise<void> {
    return undefined;
  }

  async changeVisibility(): Promise<void> {
    return undefined;
  }

  async publish(_url: string, body: string, _options: PublishOptions): Promise<void> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await Bun.sleep(10);
      const eventId = (JSON.parse(body) as { eventId?: string }).eventId ?? '';
      if (this.failFor.has(eventId)) {
        throw new Error(`publish failed for ${eventId}`);
      }
      this.published.push(eventId);
    } finally {
      this.inFlight -= 1;
    }
  }

  async getQueueAttributes(): Promise<{
    approximateNumberOfMessages: number;
    oldestMessageAgeSeconds: number;
  }> {
    return { approximateNumberOfMessages: 0, oldestMessageAgeSeconds: 0 };
  }
}

class FakeUnitOfWork implements UnitOfWork {
  async run<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    return await work({ id: 'ctx-1' });
  }

  current(): TransactionContext | undefined {
    return undefined;
  }
}

class FakeClock implements Clock {
  async now(): Promise<Date> {
    return NOW;
  }
}

class FakeOutbox implements OutboxRepository {
  readonly retried: string[] = [];
  readonly published: string[] = [];

  constructor(private readonly messages: OutboxMessage[]) {}

  async save(): Promise<void> {
    return undefined;
  }

  async claimDue(): Promise<OutboxMessage[]> {
    return this.messages;
  }

  async markPublished(id: string): Promise<void> {
    this.published.push(id);
  }

  async scheduleRetry(id: string): Promise<void> {
    this.retried.push(id);
  }

  async markDeadLettered(): Promise<void> {
    return undefined;
  }

  async countPending(): Promise<number> {
    return 0;
  }

  async countDeadLettered(): Promise<number> {
    return 0;
  }
}

function message(index: number): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    aggregateId: '00000000-0000-7000-8000-000000000001',
    eventType: 'WagerTransactionProcessed',
    payload: { eventId: `evt-${index}` },
    occurredAt: NOW,
    attempts: 0,
    claimCount: 1,
    nextAttemptAt: NOW
  });
}

function worker(queue: FakeQueue, outbox: FakeOutbox, concurrency: number): OutboxPublisherWorker {
  return new OutboxPublisherWorker(
    settings(concurrency),
    queue,
    new FakeUnitOfWork(),
    new FakeClock(),
    outbox
  );
}

describe('OutboxPublisherWorker concurrency', () => {
  test('respeita o limite e publica todas as mensagens', async () => {
    const queue = new FakeQueue();
    const outbox = new FakeOutbox([message(1), message(2), message(3), message(4), message(5)]);
    const publisher = worker(queue, outbox, 2);

    const claimed = await publisher.runOnce();

    expect(claimed).toBe(5);
    expect(queue.maxInFlight).toBeLessThanOrEqual(2);
    expect(queue.maxInFlight).toBeGreaterThan(1);
    expect(queue.published).toHaveLength(5);
    expect(outbox.published).toHaveLength(5);
  });

  test('falha de uma mensagem agenda retry sem impedir as demais', async () => {
    const queue = new FakeQueue();
    queue.failFor.add('evt-2');
    const outbox = new FakeOutbox([message(1), message(2), message(3)]);
    const publisher = worker(queue, outbox, 3);

    await publisher.runOnce();

    expect(outbox.retried).toEqual([message(2).id]);
    expect(outbox.published).toHaveLength(2);
  });
});
