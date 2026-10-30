import { describe, expect, test } from 'bun:test';
import { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction-status';
import { FailureCode } from '../../shared/errors/failure-code';
import {
  DlqQueueName,
  InboxDuplicateOutcome,
  QueueName,
  RetryWorker,
  WageringMetrics
} from './metrics';

describe('WageringMetrics', () => {
  test('expõe contadores de status, idempotência, retries, DLQ e outbox', async () => {
    const metrics = new WageringMetrics();

    metrics.transactionPersisted(WagerTransactionStatus.Processed);
    metrics.transactionPersisted(WagerTransactionStatus.Rejected);
    metrics.transactionPersisted(WagerTransactionStatus.PendingReference);
    metrics.transactionPersisted(WagerTransactionStatus.Failed);
    metrics.idempotencyHit();
    metrics.inboxDuplicate(InboxDuplicateOutcome.Duplicate);
    metrics.inboxDuplicate(InboxDuplicateOutcome.PayloadMismatch);
    metrics.retry(RetryWorker.Consumer);
    metrics.retry(RetryWorker.Outbox);
    metrics.retry(RetryWorker.PendingReference);
    metrics.dlqMessageSent(QueueName.WagerTransactions);
    metrics.dlqMessageSent(QueueName.WageringEvents);
    metrics.setOutboxDepth(3, 1);
    metrics.observeOutboxLag(2.5);
    metrics.reconciliationDivergence();
    metrics.preLineFailure(FailureCode.InvalidPayload, 400);
    metrics.uncorrelatedWin();
    metrics.observeLockWait(0.02);
    metrics.lockTimeout();
    metrics.deadlock();
    metrics.setDlqSnapshot(DlqQueueName.WagerTransactions, {
      messages: 4,
      oldestMessageAgeSeconds: 30
    });

    const output = await metrics.render();

    expect(output).toMatch(/wager_transactions_total\{[^}]*status="PROCESSED"[^}]*\} 1/);
    expect(output).toMatch(/wager_transactions_total\{[^}]*status="REJECTED"[^}]*\} 1/);
    expect(output).toMatch(/wager_transactions_total\{[^}]*status="PENDING_REFERENCE"[^}]*\} 1/);
    expect(output).toMatch(/wager_transactions_total\{[^}]*status="FAILED"[^}]*\} 1/);
    expect(output).toMatch(/wager_idempotency_hits_total(\{[^}]*\})? 1/);
    expect(output).toMatch(/wager_inbox_duplicates_total\{[^}]*outcome="DUPLICATE"[^}]*\} 1/);
    expect(output).toMatch(
      /wager_inbox_duplicates_total\{[^}]*outcome="PAYLOAD_MISMATCH"[^}]*\} 1/
    );
    expect(output).toMatch(/wager_retries_total\{[^}]*worker="CONSUMER"[^}]*\} 1/);
    expect(output).toMatch(/wager_retries_total\{[^}]*worker="OUTBOX"[^}]*\} 1/);
    expect(output).toMatch(/wager_retries_total\{[^}]*worker="PENDING_REFERENCE"[^}]*\} 1/);
    expect(output).toMatch(
      /wager_dlq_messages_sent_total\{[^}]*queue="WAGER_TRANSACTIONS"[^}]*\} 1/
    );
    expect(output).toMatch(/wager_dlq_messages_sent_total\{[^}]*queue="WAGERING_EVENTS"[^}]*\} 1/);
    expect(output).toMatch(/outbox_pending(\{[^}]*\})? 3/);
    expect(output).toMatch(/outbox_dead_lettered(\{[^}]*\})? 1/);
    expect(output).toMatch(/outbox_publish_lag_seconds_count(\{[^}]*\})? 1/);
    expect(output).toMatch(/reconciliation_divergences_total(\{[^}]*\})? 1/);
    expect(output).toMatch(
      /wager_preline_failures_total\{[^}]*failureCode="INVALID_PAYLOAD"[^}]*httpStatus="400"[^}]*\} 1/
    );
    expect(output).toMatch(/wager_uncorrelated_wins_total(\{[^}]*\})? 1/);
    expect(output).toMatch(/db_lock_wait_seconds_count(\{[^}]*\})? 1/);
    expect(output).toMatch(/db_lock_timeouts_total(\{[^}]*\})? 1/);
    expect(output).toMatch(/db_deadlocks_total(\{[^}]*\})? 1/);
    expect(output).toMatch(/sqs_dlq_messages\{[^}]*queue="WAGER_TRANSACTIONS_DLQ"[^}]*\}/);
    expect(output).toMatch(
      /sqs_dlq_oldest_message_age_seconds\{[^}]*queue="WAGER_TRANSACTIONS_DLQ"[^}]*\}/
    );
    expect(metrics.contentType).toContain('text/plain');
  });
});
