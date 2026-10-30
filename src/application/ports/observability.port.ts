import type { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction-status';

export type PersistedStatus =
  | WagerTransactionStatus.Processed
  | WagerTransactionStatus.Rejected
  | WagerTransactionStatus.PendingReference
  | WagerTransactionStatus.Failed;

export type LoggerFields = Record<string, unknown>;

export interface LoggerPort {
  info(event: string, fields?: LoggerFields): void;
  warn(event: string, fields?: LoggerFields): void;
  error(event: string, fields?: LoggerFields): void;
}

export interface MetricsPort {
  transactionPersisted(status: PersistedStatus): void;
  observeProcessing(status: string, seconds: number): void;
  idempotencyHit(): void;
  reconciliationDivergence(): void;
  uncorrelatedWin(): void;
  preLineFailure(failureCode: string, httpStatus: number): void;
}
