export enum ConsumerName {
  WAGER_TRANSACTIONS = 'WAGER_TRANSACTIONS'
}

const CONSUMER_NAME_VALUE: Record<ConsumerName, string> = {
  [ConsumerName.WAGER_TRANSACTIONS]: 'wager-transactions'
};

export interface MessagingSettings {
  enabled: boolean;
  consumerName: string;
  wagerQueueUrl: string;
  wagerDlqUrl: string;
  eventsQueueUrl: string;
  eventsDlqUrl: string;
  visibilityTimeoutSeconds: number;
  maxNumberOfMessages: number;
  pollIntervalMs: number;
  drainTimeoutMs: number;
  outboxLeaseMs: number;
  outboxBatchSize: number;
  outboxPublishConcurrency: number;
  pendingLeaseMs: number;
  pendingBatchSize: number;
  consumerMaxReceiveCount: number;
  faultAfterCommitBeforeAck: boolean;
  faultAfterPublishBeforeMark: boolean;
}

export const DEFAULT_SQS_ENDPOINT = 'http://localhost:4566';
export const SQS_MAX_NUMBER_OF_MESSAGES = 10;
export const SQS_MAX_VISIBILITY_TIMEOUT_SECONDS = 43200;
const LOCALSTACK_ACCOUNT = '000000000000';

export function resolveSqsEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SQS_ENDPOINT?.trim();
  return configured === undefined || configured.length === 0 ? DEFAULT_SQS_ENDPOINT : configured;
}

function numberFromEnv(
  value: string | undefined,
  fallback: number,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function booleanFromEnv(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

export function loadMessagingSettings(env: NodeJS.ProcessEnv = process.env): MessagingSettings {
  const endpoint = resolveSqsEndpoint(env);
  return {
    enabled: booleanFromEnv(env.MESSAGING_ENABLED),
    consumerName: env.SQS_CONSUMER_NAME ?? CONSUMER_NAME_VALUE[ConsumerName.WAGER_TRANSACTIONS],
    wagerQueueUrl:
      env.SQS_WAGER_QUEUE_URL ?? `${endpoint}/${LOCALSTACK_ACCOUNT}/wager-transactions.fifo`,
    wagerDlqUrl:
      env.SQS_WAGER_DLQ_QUEUE_URL ??
      `${endpoint}/${LOCALSTACK_ACCOUNT}/wager-transactions-dlq.fifo`,
    eventsQueueUrl:
      env.SQS_EVENTS_QUEUE_URL ?? `${endpoint}/${LOCALSTACK_ACCOUNT}/wagering-events.fifo`,
    eventsDlqUrl:
      env.SQS_EVENTS_DLQ_QUEUE_URL ?? `${endpoint}/${LOCALSTACK_ACCOUNT}/wagering-events-dlq.fifo`,
    visibilityTimeoutSeconds: numberFromEnv(
      env.SQS_VISIBILITY_TIMEOUT,
      60,
      1,
      SQS_MAX_VISIBILITY_TIMEOUT_SECONDS
    ),
    maxNumberOfMessages: numberFromEnv(
      env.SQS_MAX_NUMBER_OF_MESSAGES,
      1,
      1,
      SQS_MAX_NUMBER_OF_MESSAGES
    ),
    pollIntervalMs: numberFromEnv(env.MESSAGING_POLL_INTERVAL_MS, 1000),
    drainTimeoutMs: numberFromEnv(env.MESSAGING_DRAIN_TIMEOUT_MS, 30000),
    outboxLeaseMs: numberFromEnv(env.OUTBOX_LEASE_MS, 30000),
    outboxBatchSize: numberFromEnv(env.OUTBOX_BATCH_SIZE, 10),
    outboxPublishConcurrency: numberFromEnv(env.OUTBOX_PUBLISH_CONCURRENCY, 4, 1, 10),
    pendingLeaseMs: numberFromEnv(env.PENDING_LEASE_MS, 30000),
    pendingBatchSize: numberFromEnv(env.PENDING_BATCH_SIZE, 10),
    consumerMaxReceiveCount: numberFromEnv(env.SQS_CONSUMER_MAX_RECEIVE_COUNT, 5),
    faultAfterCommitBeforeAck: booleanFromEnv(env.FAULT_AFTER_COMMIT_BEFORE_ACK),
    faultAfterPublishBeforeMark: booleanFromEnv(env.FAULT_AFTER_PUBLISH_BEFORE_MARK)
  };
}
