import { describe, expect, test } from 'bun:test';
import type { MessageQueuePort, QueueAttributes } from '../../application/ports/message-queue.port';
import type { MessagingSettings } from '../messaging/messaging.config';
import { DlqMetricsCollector } from './dlq-metrics.collector';
import { metrics } from './metrics';

const SETTINGS: MessagingSettings = {
  enabled: true,
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

function queue(attributesFor: (url: string) => QueueAttributes): MessageQueuePort {
  return {
    receive: async () => [],
    delete: async () => undefined,
    changeVisibility: async () => undefined,
    publish: async () => undefined,
    getQueueAttributes: async (url: string) => attributesFor(url)
  };
}

describe('DlqMetricsCollector', () => {
  test('publica profundidade e idade das duas DLQs com collector_instance', async () => {
    const collector = new DlqMetricsCollector(
      queue((url) =>
        url === SETTINGS.wagerDlqUrl
          ? { approximateNumberOfMessages: 5, oldestMessageAgeSeconds: 120 }
          : { approximateNumberOfMessages: 2, oldestMessageAgeSeconds: 60 }
      ),
      SETTINGS
    );

    await collector.collect();
    const output = await metrics.render();

    expect(output).toMatch(
      /sqs_dlq_messages\{[^}]*queue="WAGER_TRANSACTIONS_DLQ"[^}]*collector_instance="[^"]+"[^}]*\} 5/
    );
    expect(output).toMatch(
      /sqs_dlq_oldest_message_age_seconds\{[^}]*queue="WAGER_TRANSACTIONS_DLQ"[^}]*\} 120/
    );
    expect(output).toMatch(/sqs_dlq_messages\{[^}]*queue="WAGERING_EVENTS_DLQ"[^}]*\} 2/);
  });

  test('falha de coleta não propaga erro', async () => {
    const collector = new DlqMetricsCollector(
      queue(() => {
        throw new Error('sqs down');
      }),
      SETTINGS
    );

    await expect(collector.collect()).resolves.toBeUndefined();
  });
});
