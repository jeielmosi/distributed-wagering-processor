import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { FailureCode } from '../../shared/errors/failure-code';
import {
  PersistenceConflict,
  UniqueConstraintConflictError
} from '../../application/errors/persistence.errors';
import {
  classifyMessageError,
  MessageFailureKind
} from '../../application/messaging/consumer-errors';
import { ResolvePendingReferenceUseCase } from '../../application/use-cases/resolve-pending-reference.use-case';
import type { Clock } from '../../application/ports/clock.port';
import type { UnitOfWork } from '../../application/ports/transaction-context';
import type { WagerTransactionRepository } from '../../application/ports/wager-transaction.repository';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { metrics, RetryWorker } from '../observability/metrics';
import { logger } from '../observability/structured-logger';
import {
  CLOCK,
  MESSAGING_SETTINGS,
  UNIT_OF_WORK,
  WAGER_TRANSACTION_REPOSITORY
} from './messaging.tokens';
import type { MessagingSettings } from './messaging.config';

const TRANSIENT_DEFER_MS = 5000;

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
export class PendingReferenceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private stopping = false;

  constructor(
    @Inject(MESSAGING_SETTINGS) private readonly settings: MessagingSettings,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    private readonly useCase: ResolvePendingReferenceUseCase
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
      this.transactions.claimDuePendingReferences(
        now,
        this.settings.pendingBatchSize,
        this.settings.pendingLeaseMs,
        ctx
      )
    );

    for (const transaction of claimed) {
      const startedAt = performance.now();
      try {
        const outcome = await this.unitOfWork.run((ctx) =>
          this.useCase.execute(transaction.id, ctx)
        );
        metrics.observeProcessing(outcome, (performance.now() - startedAt) / 1000);
        logger.info('pending_reference_processed', {
          worker: RetryWorker.PendingReference,
          transactionId: transaction.id,
          walletId: transaction.walletId,
          providerId: transaction.providerId ?? undefined,
          correlationId: transaction.correlationId,
          outcome
        });
      } catch (error) {
        await this.handleFailure(transaction, error);
      }
    }
    return claimed.length;
  }

  private async handleFailure(transaction: WagerTransaction, error: unknown): Promise<void> {
    const kind = classifyMessageError(error);

    if (kind === MessageFailureKind.Transient) {
      await this.defer(transaction);
      return;
    }

    if (kind === MessageFailureKind.Conflict && error instanceof UniqueConstraintConflictError) {
      const failureCode =
        error.conflict === PersistenceConflict.Reversal
          ? FailureCode.ReferenceAlreadyReverted
          : error.conflict === PersistenceConflict.Settlement
            ? FailureCode.ReferenceAlreadySettled
            : undefined;
      if (failureCode !== undefined) {
        try {
          await this.useCase.rejectAfterConflict(transaction.id, failureCode);
          return;
        } catch (rejectError) {
          if (classifyMessageError(rejectError) === MessageFailureKind.Transient) {
            await this.defer(transaction);
            return;
          }
        }
      }
    }

    try {
      await this.useCase.fail(transaction.id);
    } catch (failError) {
      logger.error('pending_reference_failure_not_recorded', {
        worker: RetryWorker.PendingReference,
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId ?? undefined,
        correlationId: transaction.correlationId,
        error: failError
      });
      await this.defer(transaction);
    }
  }

  private async defer(transaction: WagerTransaction): Promise<void> {
    metrics.retry(RetryWorker.PendingReference);
    logger.warn('pending_reference_deferred', {
      worker: RetryWorker.PendingReference,
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId ?? undefined,
      correlationId: transaction.correlationId
    });
    try {
      await this.unitOfWork.run(async (ctx) => {
        const now = await this.clock.now(ctx);
        await this.transactions.deferPendingReference(
          transaction.id,
          new Date(now.getTime() + TRANSIENT_DEFER_MS),
          now,
          ctx
        );
      });
    } catch (error) {
      logger.error('pending_reference_defer_failed', {
        worker: RetryWorker.PendingReference,
        transactionId: transaction.id,
        error
      });
    }
  }

  private async poll(): Promise<void> {
    while (!this.stopping) {
      try {
        const claimed = await this.runOnce();
        if (claimed === 0) {
          await sleep(this.settings.pollIntervalMs, this.abort.signal);
        }
      } catch (error) {
        logger.error('pending_reference_poll_failed', {
          worker: RetryWorker.PendingReference,
          error
        });
        await sleep(this.settings.pollIntervalMs, this.abort.signal);
      }
    }
  }
}
