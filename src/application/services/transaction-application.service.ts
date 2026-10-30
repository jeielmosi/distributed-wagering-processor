import { Inject, Injectable } from '@nestjs/common';
import { mapTransactionEvents } from '../../domain/events/event-mapper';
import { LedgerDirection } from '../../domain/ledger/ledger-direction';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import {
  PENDING_REFERENCE_TTL_MS,
  REFERENCE_BASE_DELAY_MS
} from '../../domain/wager-transaction/reference-schedule';
import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction-status';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { InsufficientBalanceError } from '../../domain/wallet/wallet.errors';
import type { Wallet } from '../../domain/wallet/wallet';
import { FailureCode } from '../../shared/errors/failure-code';
import {
  LEDGER_ENTRY_REPOSITORY,
  LOGGER,
  METRICS,
  OUTBOX_REPOSITORY,
  WAGER_TRANSACTION_REPOSITORY,
  WALLET_REPOSITORY
} from '../ports/tokens';
import type { LedgerEntryRepository } from '../ports/ledger-entry.repository';
import type { LoggerPort, MetricsPort } from '../ports/observability.port';
import type { OutboxRepository } from '../ports/outbox.repository';
import type { TransactionContext } from '../ports/transaction-context';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';
import type { WalletRepository } from '../ports/wallet.repository';

const UNKNOWN_CORRELATION_ID = 'unknown';

export type ApplyOutcome =
  | { status: WagerTransactionStatus.Processed }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode };

@Injectable()
export class TransactionApplicationService {
  constructor(
    @Inject(LOGGER) private readonly logger: LoggerPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly ledger: LedgerEntryRepository,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository
  ) {}

  async applyProcessed(
    transaction: WagerTransaction,
    wallet: Wallet,
    target: WagerTransaction | undefined,
    now: Date,
    ctx: TransactionContext
  ): Promise<ApplyOutcome> {
    if (
      transaction.kind === WagerTransactionKind.Win &&
      transaction.referenceExternalTransactionId === undefined
    ) {
      this.metrics.uncorrelatedWin();
      this.logger.warn('win_without_reference_rejected', {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        providerId: transaction.providerId ?? undefined,
        correlationId: transaction.correlationId
      });
      await this.persistRejected(transaction, FailureCode.ReferenceRequired, now, ctx);
      return {
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.ReferenceRequired
      };
    }

    let entry: WalletLedgerEntry | undefined;

    if (transaction.kind !== WagerTransactionKind.Loss) {
      const direction = transaction.ledgerDirectionFor(target);
      if (direction === LedgerDirection.Debit) {
        try {
          entry = wallet.debit({
            transactionId: transaction.id,
            money: transaction.money,
            at: now
          }).entry;
        } catch (error) {
          if (error instanceof InsufficientBalanceError) {
            const failureCode =
              transaction.kind === WagerTransactionKind.Rollback
                ? FailureCode.InsufficientFundsForReversal
                : FailureCode.InsufficientFunds;
            await this.persistRejected(transaction, failureCode, now, ctx);
            return { status: WagerTransactionStatus.Rejected, failureCode };
          }
          throw error;
        }
      } else if (direction === LedgerDirection.Credit) {
        entry = wallet.credit({
          transactionId: transaction.id,
          money: transaction.money,
          at: now
        }).entry;
      }
    }

    transaction.markProcessed(wallet.balance, target?.id, now);
    await this.transactions.save(transaction, ctx);
    if (entry !== undefined) {
      await this.ledger.save(entry, ctx);
    }
    await this.wallets.save(wallet, ctx);
    await this.enqueueEvents(transaction, entry, now, ctx);

    this.recordTransition(transaction, WagerTransactionStatus.Processed);
    return { status: WagerTransactionStatus.Processed };
  }

  async persistPending(
    transaction: WagerTransaction,
    now: Date,
    ctx: TransactionContext
  ): Promise<void> {
    const nextReferenceAttemptAt = new Date(now.getTime() + REFERENCE_BASE_DELAY_MS);
    const referenceExpiresAt = new Date(transaction.createdAt.getTime() + PENDING_REFERENCE_TTL_MS);
    transaction.markPendingReference(now, { nextReferenceAttemptAt, referenceExpiresAt });
    await this.transactions.save(transaction, ctx);
    await this.enqueueEvents(transaction, undefined, now, ctx);
    this.recordTransition(transaction, WagerTransactionStatus.PendingReference);
  }

  async persistRejected(
    transaction: WagerTransaction,
    failureCode: FailureCode,
    now: Date,
    ctx: TransactionContext
  ): Promise<void> {
    transaction.reject(failureCode, now);
    await this.persistTerminal(transaction, now, ctx);
    this.recordTransition(transaction, WagerTransactionStatus.Rejected, failureCode);
  }

  async persistFailed(
    transaction: WagerTransaction,
    failureCode: FailureCode,
    now: Date,
    ctx: TransactionContext
  ): Promise<void> {
    transaction.fail(failureCode, now);
    await this.persistTerminal(transaction, now, ctx);
    this.recordTransition(transaction, WagerTransactionStatus.Failed, failureCode);
  }

  private async persistTerminal(
    transaction: WagerTransaction,
    now: Date,
    ctx: TransactionContext
  ): Promise<void> {
    await this.transactions.save(transaction, ctx);
    await this.enqueueEvents(transaction, undefined, now, ctx);
  }

  private async enqueueEvents(
    transaction: WagerTransaction,
    entry: WalletLedgerEntry | undefined,
    occurredAt: Date,
    ctx: TransactionContext
  ): Promise<void> {
    const events = mapTransactionEvents(transaction, entry, {
      correlationId: transaction.correlationId ?? UNKNOWN_CORRELATION_ID,
      causationId: transaction.causationId,
      occurredAt
    });
    for (const event of events) {
      await this.outbox.save(OutboxMessage.enqueue(event), ctx);
    }
  }

  private recordTransition(
    transaction: WagerTransaction,
    status:
      | WagerTransactionStatus.Processed
      | WagerTransactionStatus.PendingReference
      | WagerTransactionStatus.Rejected
      | WagerTransactionStatus.Failed,
    failureCode?: FailureCode
  ): void {
    this.metrics.transactionPersisted(status);
    this.logger.info('wager_transaction_persisted', {
      transactionId: transaction.id,
      correlationId: transaction.correlationId ?? UNKNOWN_CORRELATION_ID,
      causationId: transaction.causationId,
      messageId: transaction.causationId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      providerId: transaction.providerId ?? undefined,
      status,
      kind: transaction.kind,
      failureCode
    });
  }
}
