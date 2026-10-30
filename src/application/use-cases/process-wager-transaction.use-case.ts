import { Inject, Injectable } from '@nestjs/common';
import { Money } from '../../domain/money/money';
import { ReferenceOutcome } from '../../domain/wager-transaction/reference-policy';
import { CurrencyMismatchError } from '../../domain/money/money.errors';
import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction-status';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import { DomainError } from '../../shared/errors/domain-error';
import { FailureCode } from '../../shared/errors/failure-code';
import { newUuidV7 } from '../../shared/id/uuid';
import {
  PersistenceConflict,
  PersistenceFailureError,
  UniqueConstraintConflictError
} from '../errors/persistence.errors';
import {
  ApplicationError,
  DuplicateExternalTransactionError,
  IdempotencyPayloadMismatchError,
  InvalidRequestError,
  OpeningNotAllowedError,
  TransientFailureError,
  WalletNotFoundError,
  WalletPlayerMismatchError
} from '../errors/application.errors';
import { IdempotencyService } from '../services/idempotency.service';
import { ReferenceResolverService } from '../services/reference-resolver.service';
import { TransactionApplicationService } from '../services/transaction-application.service';
import type { Clock } from '../ports/clock.port';
import type { MetricsPort } from '../ports/observability.port';
import type { TransactionContext, UnitOfWork } from '../ports/transaction-context';
import { CLOCK, METRICS, UNIT_OF_WORK, WALLET_REPOSITORY } from '../ports/tokens';
import type { WalletRepository } from '../ports/wallet.repository';
import type {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult
} from './process-wager-transaction.types';

interface PreparedCommand {
  normalized: ProcessWagerTransactionCommand;
  money: Money;
  payloadHash: string;
}

function assertLength(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 255) {
    throw new InvalidRequestError(`${field} must contain between 1 and 255 characters`);
  }
}

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    private readonly applier: TransactionApplicationService,
    private readonly idempotency: IdempotencyService,
    private readonly references: ReferenceResolverService
  ) {}

  async execute(
    command: ProcessWagerTransactionCommand,
    ctx?: TransactionContext
  ): Promise<ProcessWagerTransactionResult> {
    const startedAt = performance.now();
    try {
      const result = await this.executeCommand(command, ctx);
      this.metrics.observeProcessing(result.status, (performance.now() - startedAt) / 1000);
      return result;
    } catch (error) {
      this.metrics.observeProcessing(
        WagerTransactionStatus.Failed,
        (performance.now() - startedAt) / 1000
      );
      throw error;
    }
  }

  private async executeCommand(
    command: ProcessWagerTransactionCommand,
    ctx?: TransactionContext
  ): Promise<ProcessWagerTransactionResult> {
    const { normalized, money, payloadHash } = this.prepare(command);

    const fastPath = await this.idempotency.findExisting(
      normalized.providerId,
      normalized.idempotencyKey,
      ctx
    );
    if (fastPath !== undefined) {
      return this.replay(fastPath, payloadHash);
    }

    const transactionId = newUuidV7();

    if (ctx !== undefined) {
      return this.apply(normalized, money, payloadHash, transactionId, ctx);
    }

    try {
      return await this.unitOfWork.run((transactionCtx) =>
        this.apply(normalized, money, payloadHash, transactionId, transactionCtx)
      );
    } catch (error) {
      if (error instanceof UniqueConstraintConflictError) {
        return this.handleUniqueViolation(error, normalized, money, payloadHash, transactionId);
      }
      if (error instanceof PersistenceFailureError) {
        return this.persistFailed(normalized, money, payloadHash, transactionId);
      }
      if (error instanceof ApplicationError || error instanceof DomainError) {
        throw error;
      }
      return this.persistFailed(normalized, money, payloadHash, transactionId);
    }
  }

  async recordFailed(
    command: ProcessWagerTransactionCommand,
    ctx?: TransactionContext
  ): Promise<ProcessWagerTransactionResult> {
    const { normalized, money, payloadHash } = this.prepare(command);
    const transactionId = newUuidV7();
    const work = async (txCtx: TransactionContext): Promise<ProcessWagerTransactionResult> => {
      const existing = await this.idempotency.findExisting(
        normalized.providerId,
        normalized.idempotencyKey,
        txCtx
      );
      if (existing !== undefined) {
        return this.replay(existing, payloadHash);
      }
      const now = await this.clock.now(txCtx);
      const transaction = this.buildTransaction(normalized, money, payloadHash, transactionId, now);
      await this.applier.persistFailed(transaction, FailureCode.PermanentInfraFailure, now, txCtx);
      return this.result(transaction, false);
    };
    if (ctx !== undefined) {
      return work(ctx);
    }
    try {
      return await this.unitOfWork.run(work);
    } catch (error) {
      if (error instanceof UniqueConstraintConflictError) {
        return this.handleUniqueViolation(error, normalized, money, payloadHash, transactionId);
      }
      throw error;
    }
  }

  async recordRejected(
    command: ProcessWagerTransactionCommand,
    failureCode: FailureCode,
    ctx?: TransactionContext
  ): Promise<ProcessWagerTransactionResult> {
    const { normalized, money, payloadHash } = this.prepare(command);
    const work = async (txCtx: TransactionContext): Promise<ProcessWagerTransactionResult> => {
      const existing = await this.idempotency.findExisting(
        normalized.providerId,
        normalized.idempotencyKey,
        txCtx
      );
      if (existing !== undefined) {
        return this.replay(existing, payloadHash);
      }
      const now = await this.clock.now(txCtx);
      const transaction = this.buildTransaction(normalized, money, payloadHash, newUuidV7(), now);
      await this.applier.persistRejected(transaction, failureCode, now, txCtx);
      return this.result(transaction, false);
    };
    if (ctx !== undefined) {
      return work(ctx);
    }
    try {
      return await this.unitOfWork.run(work);
    } catch (error) {
      if (error instanceof UniqueConstraintConflictError) {
        const existing = await this.idempotency.findExisting(
          normalized.providerId,
          normalized.idempotencyKey
        );
        if (existing !== undefined) {
          return this.replay(existing, payloadHash);
        }
      }
      throw error;
    }
  }

  private prepare(command: ProcessWagerTransactionCommand): PreparedCommand {
    const normalized: ProcessWagerTransactionCommand = {
      ...command,
      idempotencyKey: this.idempotency.requireKey(command.idempotencyKey)
    };
    const money = Money.from(normalized.money);
    this.assertStructure(normalized);
    const payloadHash = this.idempotency.buildHash(normalized, money);
    return { normalized, money, payloadHash };
  }

  private assertStructure(command: ProcessWagerTransactionCommand): void {
    const reference = command.referenceExternalTransactionId;
    if (command.kind === WagerTransactionKind.Opening) {
      if (reference !== undefined) {
        throw new InvalidRequestError('OPENING must not carry a reference');
      }
      throw new OpeningNotAllowedError();
    }
    if (
      command.kind !== WagerTransactionKind.Bet &&
      command.kind !== WagerTransactionKind.Win &&
      command.kind !== WagerTransactionKind.Loss &&
      command.kind !== WagerTransactionKind.Refund &&
      command.kind !== WagerTransactionKind.Rollback
    ) {
      throw new InvalidRequestError(`Unsupported transaction kind: ${String(command.kind)}`);
    }
    assertLength(command.providerId, 'providerId');
    assertLength(command.externalTransactionId, 'externalTransactionId');
    assertLength(command.playerId, 'playerId');
    assertLength(command.walletId, 'walletId');
    assertLength(command.roundId, 'roundId');
    assertLength(command.gameId, 'gameId');

    if (reference !== undefined) {
      assertLength(reference, 'referenceExternalTransactionId');
      if (reference === command.externalTransactionId) {
        throw new InvalidRequestError('Self-reference is not allowed');
      }
    }
    if (
      (command.kind === WagerTransactionKind.Refund ||
        command.kind === WagerTransactionKind.Rollback) &&
      reference === undefined
    ) {
      throw new InvalidRequestError(`${command.kind} requires referenceExternalTransactionId`);
    }
    if (command.kind === WagerTransactionKind.Bet && reference !== undefined) {
      throw new InvalidRequestError('BET must not carry referenceExternalTransactionId');
    }
  }

  private async apply(
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
    transactionId: string,
    ctx: TransactionContext
  ): Promise<ProcessWagerTransactionResult> {
    const wallet = await this.wallets.findByIdWithLock(command.walletId, ctx);

    const existing = await this.idempotency.findExisting(
      command.providerId,
      command.idempotencyKey,
      ctx
    );
    if (existing !== undefined) {
      return this.replay(existing, payloadHash);
    }

    if (wallet === undefined) {
      throw new WalletNotFoundError();
    }
    this.assertOwnership(wallet, command, money);

    const now = await this.clock.now(ctx);
    const transaction = this.buildTransaction(command, money, payloadHash, transactionId, now);
    const resolution = await this.references.resolve(transaction, ctx);

    switch (resolution.decision.outcome) {
      case ReferenceOutcome.Pending:
        await this.applier.persistPending(transaction, now, ctx);
        return this.result(transaction, false);
      case ReferenceOutcome.Reject:
        await this.applier.persistRejected(transaction, resolution.decision.failureCode, now, ctx);
        return this.result(transaction, false);
      case ReferenceOutcome.Apply:
        await this.applier.applyProcessed(transaction, wallet, resolution.target, now, ctx);
        return this.result(transaction, false);
    }
  }

  private assertOwnership(
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    money: Money
  ): void {
    if (wallet.currency !== money.currency) {
      throw new CurrencyMismatchError(wallet.currency, money.currency);
    }
    if (wallet.playerId !== command.playerId) {
      throw new WalletPlayerMismatchError();
    }
  }

  private async persistFailed(
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
    transactionId: string
  ): Promise<ProcessWagerTransactionResult> {
    try {
      return await this.unitOfWork.run(async (ctx) => {
        const existing = await this.idempotency.findExisting(
          command.providerId,
          command.idempotencyKey,
          ctx
        );
        if (existing !== undefined) {
          return this.replay(existing, payloadHash);
        }
        const now = await this.clock.now(ctx);
        const transaction = this.buildTransaction(command, money, payloadHash, transactionId, now);
        await this.applier.persistFailed(transaction, FailureCode.PermanentInfraFailure, now, ctx);
        return this.result(transaction, false);
      });
    } catch (error) {
      if (error instanceof UniqueConstraintConflictError) {
        return this.handleUniqueViolation(error, command, money, payloadHash, transactionId);
      }
      throw error;
    }
  }

  private async handleUniqueViolation(
    error: UniqueConstraintConflictError,
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
    transactionId: string
  ): Promise<ProcessWagerTransactionResult> {
    switch (error.conflict) {
      case PersistenceConflict.Idempotency: {
        const existing = await this.idempotency.findExisting(
          command.providerId,
          command.idempotencyKey
        );
        if (existing !== undefined) {
          return this.replay(existing, payloadHash);
        }
        throw new TransientFailureError();
      }
      case PersistenceConflict.ProviderExternal: {
        const existing = await this.idempotency.findExisting(
          command.providerId,
          command.idempotencyKey
        );
        if (existing !== undefined) {
          return this.replay(existing, payloadHash);
        }
        throw new DuplicateExternalTransactionError();
      }
      case PersistenceConflict.Reversal:
        return this.persistRejectedAfterConflict(
          command,
          money,
          payloadHash,
          transactionId,
          FailureCode.ReferenceAlreadyReverted
        );
      case PersistenceConflict.Settlement:
        return this.persistRejectedAfterConflict(
          command,
          money,
          payloadHash,
          transactionId,
          FailureCode.ReferenceAlreadySettled
        );
      default:
        throw error;
    }
  }

  private async persistRejectedAfterConflict(
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
    transactionId: string,
    failureCode: FailureCode
  ): Promise<ProcessWagerTransactionResult> {
    try {
      return await this.unitOfWork.run(async (ctx) => {
        const existing = await this.idempotency.findExisting(
          command.providerId,
          command.idempotencyKey,
          ctx
        );
        if (existing !== undefined) {
          return this.replay(existing, payloadHash);
        }
        const now = await this.clock.now(ctx);
        const transaction = this.buildTransaction(command, money, payloadHash, transactionId, now);
        await this.applier.persistRejected(transaction, failureCode, now, ctx);
        return this.result(transaction, false);
      });
    } catch (error) {
      if (error instanceof UniqueConstraintConflictError) {
        const existing = await this.idempotency.findExisting(
          command.providerId,
          command.idempotencyKey
        );
        if (existing !== undefined) {
          return this.replay(existing, payloadHash);
        }
      }
      throw error;
    }
  }

  private buildTransaction(
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
    transactionId: string,
    createdAt: Date
  ): WagerTransaction {
    return WagerTransaction.create({
      id: transactionId,
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      correlationId: command.correlationId,
      causationId: command.causationId,
      createdAt
    });
  }

  private replay(existing: WagerTransaction, payloadHash: string): ProcessWagerTransactionResult {
    this.metrics.idempotencyHit();
    if (existing.payloadHash !== payloadHash) {
      throw new IdempotencyPayloadMismatchError();
    }

    switch (existing.status) {
      case WagerTransactionStatus.Processed:
        return {
          transactionId: existing.id,
          status: existing.status,
          balance: existing.balanceAfter?.toJSON(),
          idempotentReplay: true
        };
      case WagerTransactionStatus.PendingReference:
      case WagerTransactionStatus.Pending:
        return {
          transactionId: existing.id,
          status: existing.status,
          idempotentReplay: true
        };
      case WagerTransactionStatus.Rejected:
      case WagerTransactionStatus.Failed:
        return {
          transactionId: existing.id,
          status: existing.status,
          failureCode: existing.failureCode,
          idempotentReplay: true
        };
    }
  }

  private result(
    transaction: WagerTransaction,
    idempotentReplay: boolean
  ): ProcessWagerTransactionResult {
    const result: ProcessWagerTransactionResult = {
      transactionId: transaction.id,
      status: transaction.status,
      idempotentReplay
    };
    if (transaction.balanceAfter !== undefined) {
      result.balance = transaction.balanceAfter.toJSON();
    }
    if (transaction.failureCode !== undefined) {
      result.failureCode = transaction.failureCode;
    }
    return result;
  }
}
