import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { MetricsPort, PersistedStatus } from '../../application/ports/observability.port';
import { instanceId } from './structured-logger';

export enum RetryWorker {
  Consumer = 'CONSUMER',
  Outbox = 'OUTBOX',
  PendingReference = 'PENDING_REFERENCE'
}

export enum QueueName {
  WagerTransactions = 'WAGER_TRANSACTIONS',
  WageringEvents = 'WAGERING_EVENTS'
}

export enum DlqQueueName {
  WagerTransactions = 'WAGER_TRANSACTIONS_DLQ',
  WageringEvents = 'WAGERING_EVENTS_DLQ'
}

export enum InboxDuplicateOutcome {
  Duplicate = 'DUPLICATE',
  PayloadMismatch = 'PAYLOAD_MISMATCH'
}

export interface DlqSnapshot {
  messages: number;
  oldestMessageAgeSeconds: number;
}

export class WageringMetrics implements MetricsPort {
  readonly registry = new Registry();

  readonly transactionsTotal = new Counter({
    name: 'wager_transactions_total',
    help: 'Persisted wager transactions by terminal or pending status',
    labelNames: ['status'] as const,
    registers: [this.registry]
  });

  readonly transactionProcessingSeconds = new Histogram({
    name: 'wager_transaction_processing_seconds',
    help: 'Wall-clock time to process a wager transaction command',
    labelNames: ['status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry]
  });

  readonly idempotencyHitsTotal = new Counter({
    name: 'wager_idempotency_hits_total',
    help: 'Idempotency lookups that returned an existing transaction',
    registers: [this.registry]
  });

  readonly inboxDuplicatesTotal = new Counter({
    name: 'wager_inbox_duplicates_total',
    help: 'Inbox duplicates detected by the consumer, split by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry]
  });

  readonly retriesTotal = new Counter({
    name: 'wager_retries_total',
    help: 'Retries scheduled by worker',
    labelNames: ['worker'] as const,
    registers: [this.registry]
  });

  readonly dlqMessagesSentTotal = new Counter({
    name: 'wager_dlq_messages_sent_total',
    help: 'Messages published directly to a dead-letter queue',
    labelNames: ['queue'] as const,
    registers: [this.registry]
  });

  readonly sqsDlqMessages = new Gauge({
    name: 'sqs_dlq_messages',
    help: 'Approximate number of messages visible in an SQS dead-letter queue',
    labelNames: ['queue', 'collector_instance'] as const,
    registers: [this.registry]
  });

  readonly sqsDlqOldestMessageAgeSeconds = new Gauge({
    name: 'sqs_dlq_oldest_message_age_seconds',
    help: 'Approximate age in seconds of the oldest message in an SQS dead-letter queue',
    labelNames: ['queue', 'collector_instance'] as const,
    registers: [this.registry]
  });

  readonly outboxPending = new Gauge({
    name: 'outbox_pending',
    help: 'Outbox messages that are neither published nor dead-lettered',
    registers: [this.registry]
  });

  readonly outboxDeadLettered = new Gauge({
    name: 'outbox_dead_lettered',
    help: 'Outbox messages marked as dead-lettered',
    registers: [this.registry]
  });

  readonly outboxPublishLagSeconds = new Histogram({
    name: 'outbox_publish_lag_seconds',
    help: 'Seconds between outbox occurred_at and published_at',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30, 60, 300],
    registers: [this.registry]
  });

  readonly reconciliationDivergencesTotal = new Counter({
    name: 'reconciliation_divergences_total',
    help: 'Reconciliation runs that returned consistent=false',
    registers: [this.registry]
  });

  readonly preLineFailuresTotal = new Counter({
    name: 'wager_preline_failures_total',
    help: 'Failures rejected before a transaction row exists (no transactionId)',
    labelNames: ['failureCode', 'httpStatus'] as const,
    registers: [this.registry]
  });

  readonly uncorrelatedWinsTotal = new Counter({
    name: 'wager_uncorrelated_wins_total',
    help: 'WIN transactions rejected because they carried no reference to a BET',
    registers: [this.registry]
  });

  readonly dbLockWaitSeconds = new Histogram({
    name: 'db_lock_wait_seconds',
    help: 'Time spent acquiring a pessimistic wallet lock',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry]
  });

  readonly dbLockTimeoutsTotal = new Counter({
    name: 'db_lock_timeouts_total',
    help: 'PostgreSQL lock_timeout errors (SQLSTATE 55P03)',
    registers: [this.registry]
  });

  readonly dbDeadlocksTotal = new Counter({
    name: 'db_deadlocks_total',
    help: 'PostgreSQL deadlock errors (SQLSTATE 40P01)',
    registers: [this.registry]
  });

  constructor() {
    this.registry.setDefaultLabels({
      service: 'wagering-processor',
      service_instance: instanceId()
    });
    collectDefaultMetrics({ register: this.registry });
  }

  transactionPersisted(status: PersistedStatus): void {
    this.transactionsTotal.inc({ status });
  }

  observeProcessing(status: string, seconds: number): void {
    this.transactionProcessingSeconds.observe({ status }, seconds);
  }

  idempotencyHit(): void {
    this.idempotencyHitsTotal.inc();
  }

  inboxDuplicate(outcome: InboxDuplicateOutcome): void {
    this.inboxDuplicatesTotal.inc({ outcome });
  }

  retry(worker: RetryWorker): void {
    this.retriesTotal.inc({ worker });
  }

  dlqMessageSent(queue: QueueName): void {
    this.dlqMessagesSentTotal.inc({ queue });
  }

  setDlqSnapshot(queue: DlqQueueName, snapshot: DlqSnapshot, collector = instanceId()): void {
    this.sqsDlqMessages.set({ queue, collector_instance: collector }, snapshot.messages);
    this.sqsDlqOldestMessageAgeSeconds.set(
      { queue, collector_instance: collector },
      snapshot.oldestMessageAgeSeconds
    );
  }

  setOutboxDepth(pending: number, deadLettered: number): void {
    this.outboxPending.set(pending);
    this.outboxDeadLettered.set(deadLettered);
  }

  observeOutboxLag(seconds: number): void {
    this.outboxPublishLagSeconds.observe(seconds);
  }

  reconciliationDivergence(): void {
    this.reconciliationDivergencesTotal.inc();
  }

  preLineFailure(failureCode: string, httpStatus: number): void {
    this.preLineFailuresTotal.inc({ failureCode, httpStatus: String(httpStatus) });
  }

  uncorrelatedWin(): void {
    this.uncorrelatedWinsTotal.inc();
  }

  observeLockWait(seconds: number): void {
    this.dbLockWaitSeconds.observe(seconds);
  }

  lockTimeout(): void {
    this.dbLockTimeoutsTotal.inc();
  }

  deadlock(): void {
    this.dbDeadlocksTotal.inc();
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  reset(): void {
    this.registry.resetMetrics();
  }
}

export const metrics = new WageringMetrics();
