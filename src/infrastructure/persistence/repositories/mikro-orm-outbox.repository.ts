import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxRepository } from '../../../application/ports/outbox.repository';
import { TransactionContext } from '../../../application/ports/transaction-context';
import { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { OutboxMessageEntity } from '../entities/outbox-message.entity';
import { OutboxMessageMapper } from '../mappers/outbox-message.mapper';
import { MikroOrmEntityManagerResolver } from '../mikro-orm-entity-manager-resolver';

@Injectable()
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly resolver: MikroOrmEntityManagerResolver) {}

  async save(outbox: OutboxMessage, ctx?: TransactionContext): Promise<void> {
    const em = this.em(ctx);
    const existing = await em.findOne(OutboxMessageEntity, { id: outbox.id });
    const entity =
      existing === null
        ? OutboxMessageMapper.toEntity(outbox)
        : OutboxMessageMapper.toEntity(outbox, existing);
    em.persist(entity);
    await em.flush();
  }

  async claimDue(
    now: Date,
    limit: number,
    leaseMs: number,
    ctx?: TransactionContext
  ): Promise<OutboxMessage[]> {
    const em = this.em(ctx);
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows = await em.execute<{ id: string }[]>(
      `with due as (
         select id
           from outbox_messages
          where published_at is null
            and dead_lettered_at is null
            and next_attempt_at <= ?
          order by next_attempt_at asc
          limit ?
          for update skip locked
       )
       update outbox_messages o
          set claim_count = o.claim_count + 1,
              next_attempt_at = ?
         from due
        where o.id = due.id
        returning o.id`,
      [now, limit, leaseUntil]
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      return [];
    }
    const entities = await em.find(
      OutboxMessageEntity,
      { id: { $in: rows.map((row) => row.id) } },
      { refresh: true }
    );
    return entities.map((entity) => OutboxMessageMapper.toDomain(entity));
  }

  async markPublished(id: string, at: Date, ctx?: TransactionContext): Promise<void> {
    const em = this.em(ctx);
    await em.execute(
      `update outbox_messages
          set published_at = ?
        where id = ?
          and published_at is null
          and dead_lettered_at is null`,
      [at, id]
    );
  }

  async scheduleRetry(
    id: string,
    nextAttemptAt: Date,
    error?: string,
    ctx?: TransactionContext
  ): Promise<void> {
    const em = this.em(ctx);
    await em.execute(
      `update outbox_messages
          set attempts = attempts + 1,
              next_attempt_at = ?,
              last_error = coalesce(?, last_error)
        where id = ?
          and published_at is null
          and dead_lettered_at is null`,
      [nextAttemptAt, error ?? null, id]
    );
  }

  async markDeadLettered(
    id: string,
    at: Date,
    error?: string,
    ctx?: TransactionContext
  ): Promise<void> {
    const em = this.em(ctx);
    await em.execute(
      `update outbox_messages
          set dead_lettered_at = ?,
              last_error = coalesce(?, last_error)
        where id = ?
          and published_at is null
          and dead_lettered_at is null`,
      [at, error ?? null, id]
    );
  }

  async countPending(ctx?: TransactionContext): Promise<number> {
    return this.count(
      'select count(*)::int as count from outbox_messages where published_at is null and dead_lettered_at is null',
      ctx
    );
  }

  async countDeadLettered(ctx?: TransactionContext): Promise<number> {
    return this.count(
      'select count(*)::int as count from outbox_messages where dead_lettered_at is not null',
      ctx
    );
  }

  private async count(sql: string, ctx?: TransactionContext): Promise<number> {
    const rows = await this.em(ctx).execute<{ count: number }[]>(sql);
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return row === undefined ? 0 : Number(row.count);
  }

  private em(ctx?: TransactionContext): EntityManager {
    return this.resolver.resolve(ctx);
  }
}
