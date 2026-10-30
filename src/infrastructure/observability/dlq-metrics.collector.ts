import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { MessageQueuePort } from '../../application/ports/message-queue.port';
import { MESSAGE_QUEUE, MESSAGING_SETTINGS } from '../messaging/messaging.tokens';
import type { MessagingSettings } from '../messaging/messaging.config';
import { DlqQueueName, metrics } from './metrics';
import { logger } from './structured-logger';

function intervalFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : fallback;
}

function enabledFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === '1' || value === 'true';
}

@Injectable()
export class DlqMetricsCollector implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = logger.child({ component: 'dlq_metrics' });
  private timer: ReturnType<typeof setInterval> | undefined;
  private collecting = false;

  constructor(
    @Inject(MESSAGE_QUEUE) private readonly queue: MessageQueuePort,
    @Inject(MESSAGING_SETTINGS) private readonly settings: MessagingSettings
  ) {}

  private get enabled(): boolean {
    return enabledFromEnv(process.env.METRICS_DLQ_ENABLED, this.settings.enabled);
  }

  private get intervalMs(): number {
    return intervalFromEnv(process.env.METRICS_DLQ_INTERVAL_MS, 15000);
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      return;
    }
    void this.collect();
    this.timer = setInterval(() => void this.collect(), this.intervalMs);
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async collect(): Promise<void> {
    if (this.collecting) {
      return;
    }
    this.collecting = true;
    try {
      await Promise.all([
        this.collectQueue(DlqQueueName.WagerTransactions, this.settings.wagerDlqUrl),
        this.collectQueue(DlqQueueName.WageringEvents, this.settings.eventsDlqUrl)
      ]);
    } finally {
      this.collecting = false;
    }
  }

  private async collectQueue(queue: DlqQueueName, url: string): Promise<void> {
    try {
      const attributes = await this.queue.getQueueAttributes(url);
      metrics.setDlqSnapshot(queue, {
        messages: attributes.approximateNumberOfMessages,
        oldestMessageAgeSeconds: attributes.oldestMessageAgeSeconds
      });
    } catch (error) {
      this.log.warn('dlq_metrics_collection_failed', { queue, error });
    }
  }
}
