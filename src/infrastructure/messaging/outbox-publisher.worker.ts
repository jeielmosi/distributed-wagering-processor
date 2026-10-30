import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import {
  MAX_OUTBOX_CLAIMS,
  OUTBOX_MAX_DELAY_MS,
  OutboxMessage
} from '../../domain/messaging/outbox-message';
import type { Clock } from '../../application/ports/clock.port';
import type { OutboxRepository } from '../../application/ports/outbox.repository';
import type { MessageQueuePort } from '../../application/ports/message-queue.port';
import type { UnitOfWork } from '../../application/ports/transaction-context';
import { DlqQueueName, metrics, QueueName, RetryWorker } from '../observability/metrics';
import { logger } from '../observability/structured-logger';
import {
  CLOCK,
  MESSAGE_QUEUE,
  MESSAGING_SETTINGS,
  OUTBOX_REPOSITORY,
  UNIT_OF_WORK
} from './messaging.tokens';
import type { MessagingSettings } from './messaging.config';

function payloadCorrelationId(message: OutboxMessage): string | undefined {
  const value = message.payload.correlationId;
  return typeof value === 'string' ? value : undefined;
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) {
        return;
      }
      await work(item);
    }
  });
  await Promise.all(runners);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private stopping = false;

  constructor(
    @Inject(MESSAGING_SETTINGS) private readonly settings: MessagingSettings,
    @Inject(MESSAGE_QUEUE) private readonly queue: MessageQueuePort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository
  ) {}

  onApplicationBootstrap(): void {
    if (this.settings.enabled) {
      this.start();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.loop !== undefined) {
      return;
    }
    this.stopping = false;
    this.loop = this.poll();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    if (this.loop === undefined) {
      return;
    }
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, this.settings.drainTimeoutMs);
    });
    await Promise.race([this.loop, timeout]);
    this.loop = undefined;
  }

  async runOnce(): Promise<number> {
    const now = await this.clock.now();
    const claimed = await this.unitOfWork.run((ctx) =>
      this.outbox.claimDue(now, this.settings.outboxBatchSize, this.settings.outboxLeaseMs, ctx)
    );
    await this.refreshDepth();

    const handle = async (message: OutboxMessage): Promise<void> => {
      if (message.claimCount >= MAX_OUTBOX_CLAIMS) {
        const sent = await this.sendToDeadLetter(message);
        if (sent) {
          await this.markDeadLettered(message, 'Maximum claims exceeded without publish');
        }
        return;
      }
      await this.publish(message, now);
    };

    await mapWithConcurrency(claimed, this.settings.outboxPublishConcurrency, handle);
    return claimed.length;
  }

  private async refreshDepth(): Promise<void> {
    try {
      const [pending, deadLettered] = await Promise.all([
        this.outbox.countPending(),
        this.outbox.countDeadLettered()
      ]);
      metrics.setOutboxDepth(pending, deadLettered);
    } catch (error) {
      logger.warn('outbox_depth_refresh_failed', { worker: RetryWorker.Outbox, error });
    }
  }

  private async publish(message: OutboxMessage, now: Date): Promise<void> {
    try {
      await this.queue.publish(this.settings.eventsQueueUrl, JSON.stringify(message.payload), {
        groupId: message.aggregateId,
        deduplicationId: message.id
      });
      if (this.settings.faultAfterPublishBeforeMark) {
        process.exit(1);
      }
      await this.unitOfWork.run(async (ctx) => {
        const publishedAt = await this.clock.now(ctx);
        await this.outbox.markPublished(message.id, publishedAt, ctx);
        metrics.observeOutboxLag(
          Math.max(0, (publishedAt.getTime() - message.occurredAt.getTime()) / 1000)
        );
      });
    } catch (error) {
      metrics.retry(RetryWorker.Outbox);
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('outbox_publish_failed', {
        worker: RetryWorker.Outbox,
        correlationId: payloadCorrelationId(message),
        aggregateId: message.aggregateId,
        eventId: message.id,
        attempts: message.attempts + 1,
        error
      });
      const preview = this.preview(message, now, reason);
      if (!preview.isPending()) {
        const retryAt = new Date(now.getTime() + OUTBOX_MAX_DELAY_MS);
        const sent = await this.sendToDeadLetter(message);
        if (sent) {
          await this.unitOfWork.run((ctx) =>
            this.outbox.scheduleRetry(message.id, retryAt, reason, ctx)
          );
          await this.markDeadLettered(message, reason);
          return;
        }
        await this.unitOfWork.run((ctx) =>
          this.outbox.scheduleRetry(message.id, retryAt, reason, ctx)
        );
        return;
      }
      const nextAttemptAt = preview.nextAttemptAt;
      await this.unitOfWork.run((ctx) =>
        this.outbox.scheduleRetry(message.id, nextAttemptAt, reason, ctx)
      );
    }
  }

  private preview(message: OutboxMessage, now: Date, reason: string): OutboxMessage {
    const preview = OutboxMessage.rehydrate({
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload,
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      claimCount: message.claimCount,
      nextAttemptAt: message.nextAttemptAt,
      publishedAt: message.publishedAt,
      deadLetteredAt: message.deadLetteredAt,
      lastError: message.lastError,
      createdAt: message.createdAt
    });
    preview.scheduleRetry(now, reason);
    return preview;
  }

  private async sendToDeadLetter(message: OutboxMessage): Promise<boolean> {
    try {
      await this.queue.publish(this.settings.eventsDlqUrl, JSON.stringify(message.payload), {
        groupId: message.aggregateId,
        deduplicationId: message.id
      });
      metrics.dlqMessageSent(QueueName.WageringEvents);
      return true;
    } catch (error) {
      logger.error('outbox_dead_letter_publish_failed', {
        worker: RetryWorker.Outbox,
        queue: DlqQueueName.WageringEvents,
        correlationId: payloadCorrelationId(message),
        eventId: message.id,
        aggregateId: message.aggregateId,
        error
      });
      return false;
    }
  }

  private async markDeadLettered(message: OutboxMessage, reason: string): Promise<void> {
    logger.error('outbox_dead_lettered', {
      worker: RetryWorker.Outbox,
      queue: DlqQueueName.WageringEvents,
      correlationId: payloadCorrelationId(message),
      eventId: message.id,
      aggregateId: message.aggregateId,
      attempts: message.attempts,
      claimCount: message.claimCount,
      reason
    });
    await this.unitOfWork.run(async (ctx) => {
      const deadLetteredAt = await this.clock.now(ctx);
      await this.outbox.markDeadLettered(message.id, deadLetteredAt, reason, ctx);
    });
  }

  private async poll(): Promise<void> {
    while (!this.stopping) {
      try {
        const claimed = await this.runOnce();
        if (claimed === 0) {
          await sleep(this.settings.pollIntervalMs, this.abort.signal);
        }
      } catch (error) {
        logger.error('outbox_poll_failed', { worker: RetryWorker.Outbox, error });
        await sleep(this.settings.pollIntervalMs, this.abort.signal);
      }
    }
  }
}
