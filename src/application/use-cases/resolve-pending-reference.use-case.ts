import { Inject, Injectable } from '@nestjs/common';
import {
  MAX_REFERENCE_ATTEMPTS,
  PENDING_REFERENCE_TTL_MS,
  PENDING_TARGET_DELAY_MS,
  referenceBackoffDelayMs,
  referenceRetryAt
} from '../../domain/wager-transaction/reference-schedule';
import { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction-status';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { ReferenceOutcome } from '../../domain/wager-transaction/reference-policy';
import { FailureCode } from '../../shared/errors/failure-code';
import { WalletNotFoundError } from '../errors/application.errors';
import { ReferenceResolverService } from '../services/reference-resolver.service';
import { TransactionApplicationService } from '../services/transaction-application.service';
import type { Clock } from '../ports/clock.port';
import type { TransactionContext, UnitOfWork } from '../ports/transaction-context';
import {
  CLOCK,
  UNIT_OF_WORK,
  WAGER_TRANSACTION_REPOSITORY,
  WALLET_REPOSITORY
} from '../ports/tokens';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';
import type { WalletRepository } from '../ports/wallet.repository';

export enum ResolvePendingOutcome {
  Skipped = 'SKIPPED',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED'
}

@Injectable()
export class ResolvePendingReferenceUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    private readonly references: ReferenceResolverService,
    private readonly applier: TransactionApplicationService
  ) {}

  async execute(transactionId: string, ctx: TransactionContext): Promise<ResolvePendingOutcome> {
    const transaction = await this.transactions.findById(transactionId, ctx);
    if (
      transaction === undefined ||
      transaction.status !== WagerTransactionStatus.PendingReference
    ) {
      return ResolvePendingOutcome.Skipped;
    }

    const wallet = await this.wallets.findByIdWithLock(transaction.walletId, ctx);
    if (wallet === undefined) {
      throw new WalletNotFoundError();
    }

    const locked = await this.transactions.findById(transactionId, ctx);
    if (locked === undefined || locked.status !== WagerTransactionStatus.PendingReference) {
      return ResolvePendingOutcome.Skipped;
    }

    const now = await this.clock.now(ctx);
    const expiresAt =
      locked.referenceExpiresAt ?? new Date(locked.createdAt.getTime() + PENDING_REFERENCE_TTL_MS);
    const expired = now.getTime() >= expiresAt.getTime();
    const exhausted = locked.referenceAttempts >= MAX_REFERENCE_ATTEMPTS;

    const target =
      locked.providerId !== null && locked.referenceExternalTransactionId !== undefined
        ? await this.transactions.findByProviderAndExternalId(
            locked.providerId,
            locked.referenceExternalTransactionId,
            ctx
          )
        : undefined;

    if (target === undefined) {
      if (expired || exhausted) {
        await this.applier.persistRejected(locked, FailureCode.ReferenceNotFound, now, ctx);
        return ResolvePendingOutcome.Rejected;
      }
      const attempts = locked.referenceAttempts + 1;
      await this.reschedule(locked, now, referenceBackoffDelayMs(attempts), true, ctx, expiresAt);
      return ResolvePendingOutcome.PendingReference;
    }

    const resolution = await this.references.resolve(locked, ctx);
    switch (resolution.decision.outcome) {
      case ReferenceOutcome.Pending:
        if (expired || exhausted) {
          await this.applier.persistRejected(locked, FailureCode.ReferenceNotProcessed, now, ctx);
          return ResolvePendingOutcome.Rejected;
        }
        await this.reschedule(locked, now, PENDING_TARGET_DELAY_MS, false, ctx, expiresAt);
        return ResolvePendingOutcome.PendingReference;
      case ReferenceOutcome.Reject:
        await this.applier.persistRejected(locked, resolution.decision.failureCode, now, ctx);
        return ResolvePendingOutcome.Rejected;
      case ReferenceOutcome.Apply: {
        const outcome = await this.applier.applyProcessed(
          locked,
          wallet,
          resolution.target,
          now,
          ctx
        );
        return outcome.status === WagerTransactionStatus.Processed
          ? ResolvePendingOutcome.Processed
          : ResolvePendingOutcome.Rejected;
      }
    }
  }

  async rejectAfterConflict(transactionId: string, code: FailureCode): Promise<void> {
    await this.unitOfWork.run(async (ctx) => {
      const transaction = await this.transactions.findById(transactionId, ctx);
      if (
        transaction === undefined ||
        transaction.status !== WagerTransactionStatus.PendingReference
      ) {
        return;
      }
      const now = await this.clock.now(ctx);
      await this.applier.persistRejected(transaction, code, now, ctx);
    });
  }

  async fail(transactionId: string): Promise<void> {
    await this.unitOfWork.run(async (ctx) => {
      const transaction = await this.transactions.findById(transactionId, ctx);
      if (
        transaction === undefined ||
        transaction.status !== WagerTransactionStatus.PendingReference
      ) {
        return;
      }
      const now = await this.clock.now(ctx);
      await this.applier.persistFailed(transaction, FailureCode.PermanentInfraFailure, now, ctx);
    });
  }

  private async reschedule(
    transaction: WagerTransaction,
    now: Date,
    delayMs: number,
    incrementAttempts: boolean,
    ctx: TransactionContext,
    expiresAt: Date
  ): Promise<void> {
    const next = referenceRetryAt(now, delayMs, expiresAt);
    transaction.rescheduleReferenceAttempt(next, now, incrementAttempts);
    await this.transactions.save(transaction, ctx);
  }
}
