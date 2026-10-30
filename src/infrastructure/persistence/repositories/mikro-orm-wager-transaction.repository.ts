import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { TransactionContext } from '../../../application/ports/transaction-context';
import { WagerTransactionRepository } from '../../../application/ports/wager-transaction.repository';
import { WagerTransactionKind } from '../../../domain/wager-transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../../../domain/wager-transaction/wager-transaction-status';
import { WagerTransaction } from '../../../domain/wager-transaction/wager-transaction';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper';
import { MikroOrmEntityManagerResolver } from '../mikro-orm-entity-manager-resolver';

@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly resolver: MikroOrmEntityManagerResolver) {}

  async findById(id: string, ctx?: TransactionContext): Promise<WagerTransaction | undefined> {
    const entity = await this.em(ctx).findOne(WagerTransactionEntity, { id });
    return entity === null ? undefined : WagerTransactionMapper.toDomain(entity);
  }

  async findByProviderAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
    ctx?: TransactionContext
  ): Promise<WagerTransaction | undefined> {
    const entity = await this.em(ctx).findOne(WagerTransactionEntity, {
      providerId,
      idempotencyKey
    });
    return entity === null ? undefined : WagerTransactionMapper.toDomain(entity);
  }

  async findOpeningByWalletId(
    walletId: string,
    ctx?: TransactionContext
  ): Promise<WagerTransaction | undefined> {
    const entity = await this.em(ctx).findOne(WagerTransactionEntity, {
      walletId,
      kind: WagerTransactionKind.Opening
    });
    return entity === null ? undefined : WagerTransactionMapper.toDomain(entity);
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
    ctx?: TransactionContext
  ): Promise<WagerTransaction | undefined> {
    const entity = await this.em(ctx).findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId
    });
    return entity === null ? undefined : WagerTransactionMapper.toDomain(entity);
  }

  async findSettlementByProviderAndReference(
    providerId: string,
    referenceExternalTransactionId: string,
    ctx?: TransactionContext
  ): Promise<WagerTransaction | undefined> {
    const entity = await this.em(ctx).findOne(WagerTransactionEntity, {
      providerId,
      referenceExternalTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Win, WagerTransactionKind.Loss] }
    });
    return entity === null ? undefined : WagerTransactionMapper.toDomain(entity);
  }

  async findByReferenceTransactionId(
    referenceTransactionId: string,
    ctx?: TransactionContext
  ): Promise<WagerTransaction | undefined> {
    const entity = await this.em(ctx).findOne(WagerTransactionEntity, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] }
    });
    return entity === null ? undefined : WagerTransactionMapper.toDomain(entity);
  }

  async claimDuePendingReferences(
    now: Date,
    limit: number,
    leaseMs: number,
    ctx?: TransactionContext
  ): Promise<WagerTransaction[]> {
    const em = this.em(ctx);
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows = await em.execute<{ id: string }[]>(
      `with due as (
         select id
           from wager_transactions
          where status = ?
            and next_reference_attempt_at <= ?
          order by next_reference_attempt_at asc
          limit ?
          for update skip locked
       )
       update wager_transactions t
          set next_reference_attempt_at = least(?, t.reference_expires_at)
         from due
        where t.id = due.id
        returning t.id`,
      [WagerTransactionStatus.PendingReference, now, limit, leaseUntil]
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.id);
    const entities = await em.find(WagerTransactionEntity, { id: { $in: ids } }, { refresh: true });
    const byId = new Map(entities.map((entity) => [entity.id, entity]));
    return ids
      .map((id) => byId.get(id))
      .filter((entity): entity is WagerTransactionEntity => entity !== undefined)
      .map((entity) => WagerTransactionMapper.toDomain(entity));
  }

  async deferPendingReference(
    id: string,
    nextReferenceAttemptAt: Date,
    lastAttemptAt: Date,
    ctx?: TransactionContext
  ): Promise<void> {
    await this.em(ctx).execute(
      `update wager_transactions
          set next_reference_attempt_at = least(?, reference_expires_at),
              reference_last_attempt_at = ?
        where id = ?
          and status = ?`,
      [nextReferenceAttemptAt, lastAttemptAt, id, WagerTransactionStatus.PendingReference]
    );
  }

  async save(transaction: WagerTransaction, ctx?: TransactionContext): Promise<void> {
    const em = this.em(ctx);
    const existing = await em.findOne(WagerTransactionEntity, { id: transaction.id });
    const entity =
      existing === null
        ? WagerTransactionMapper.toEntity(transaction)
        : WagerTransactionMapper.toEntity(transaction, existing);
    em.persist(entity);
    await em.flush();
  }

  private em(ctx?: TransactionContext): EntityManager {
    return this.resolver.resolve(ctx);
  }
}
