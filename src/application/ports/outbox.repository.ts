import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { TransactionContext } from './transaction-context';

export interface OutboxRepository {
  save(outbox: OutboxMessage, ctx?: TransactionContext): Promise<void>;
  claimDue(
    now: Date,
    limit: number,
    leaseMs: number,
    ctx?: TransactionContext
  ): Promise<OutboxMessage[]>;
  markPublished(id: string, at: Date, ctx?: TransactionContext): Promise<void>;
  scheduleRetry(
    id: string,
    nextAttemptAt: Date,
    error?: string,
    ctx?: TransactionContext
  ): Promise<void>;
  markDeadLettered(id: string, at: Date, error?: string, ctx?: TransactionContext): Promise<void>;
  countPending(ctx?: TransactionContext): Promise<number>;
  countDeadLettered(ctx?: TransactionContext): Promise<number>;
}
