import { WagerTransaction } from '../../../domain/wager-transaction/wager-transaction';
import { Money } from '../../../domain/money/money';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity';

export class WagerTransactionMapper {
  static toDomain(entity: WagerTransactionEntity): WagerTransaction {
    const money = Money.from({ amount: String(entity.amount), currency: entity.currency });
    const balanceAfter =
      entity.balanceAfterAmount != null && entity.balanceAfterCurrency != null
        ? Money.from({
            amount: String(entity.balanceAfterAmount),
            currency: entity.balanceAfterCurrency
          })
        : undefined;
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId ?? null,
      externalTransactionId: entity.externalTransactionId ?? null,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId ?? null,
      gameId: entity.gameId ?? null,
      kind: entity.kind,
      money,
      referenceExternalTransactionId: entity.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: entity.referenceTransactionId ?? undefined,
      status: entity.status,
      failureCode: entity.failureCode ?? undefined,
      balanceAfter,
      correlationId: entity.correlationId ?? undefined,
      causationId: entity.causationId ?? undefined,
      referenceAttempts: entity.referenceAttempts,
      nextReferenceAttemptAt: entity.nextReferenceAttemptAt ?? undefined,
      referenceExpiresAt: entity.referenceExpiresAt ?? undefined,
      referenceLastAttemptAt: entity.referenceLastAttemptAt ?? undefined,
      createdAt: entity.createdAt,
      processedAt: entity.processedAt ?? undefined,
      resolvedAt: entity.resolvedAt ?? undefined,
      updatedAt: entity.updatedAt
    });
  }

  static toEntity(
    transaction: WagerTransaction,
    entity: WagerTransactionEntity = new WagerTransactionEntity()
  ): WagerTransactionEntity {
    entity.id = transaction.id;
    entity.providerId = transaction.providerId;
    entity.externalTransactionId = transaction.externalTransactionId;
    entity.idempotencyKey = transaction.idempotencyKey;
    entity.payloadHash = transaction.payloadHash;
    entity.walletId = transaction.walletId;
    entity.playerId = transaction.playerId;
    entity.roundId = transaction.roundId;
    entity.gameId = transaction.gameId;
    entity.kind = transaction.kind;
    entity.amount = transaction.money.toString();
    entity.currency = transaction.money.currency;
    entity.balanceAfterAmount =
      transaction.balanceAfter === undefined ? null : transaction.balanceAfter.toString();
    entity.balanceAfterCurrency =
      transaction.balanceAfter === undefined ? null : transaction.balanceAfter.currency;
    entity.referenceExternalTransactionId = transaction.referenceExternalTransactionId ?? null;
    entity.referenceTransactionId = transaction.referenceTransactionId ?? null;
    entity.status = transaction.status;
    entity.failureCode = transaction.failureCode ?? null;
    entity.correlationId = transaction.correlationId ?? null;
    entity.causationId = transaction.causationId ?? null;
    entity.referenceAttempts = transaction.referenceAttempts;
    entity.nextReferenceAttemptAt = transaction.nextReferenceAttemptAt ?? null;
    entity.referenceExpiresAt = transaction.referenceExpiresAt ?? null;
    entity.referenceLastAttemptAt = transaction.referenceLastAttemptAt ?? null;
    entity.createdAt = transaction.createdAt;
    entity.updatedAt = transaction.updatedAt;
    entity.processedAt = transaction.processedAt ?? null;
    entity.resolvedAt = transaction.resolvedAt ?? null;
    return entity;
  }
}
