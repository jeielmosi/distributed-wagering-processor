import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { TransactionContext } from './transaction-context';

export interface WagerTransactionRepository {
  findById(id: string, ctx?: TransactionContext): Promise<WagerTransaction | undefined>;
  findByProviderAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
    ctx?: TransactionContext
  ): Promise<WagerTransaction | undefined>;
  findOpeningByWalletId(
    walletId: string,
    ctx?: TransactionContext
  ): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
    ctx?: TransactionContext
  ): Promise<WagerTransaction | undefined>;
  findSettlementByProviderAndReference(
    providerId: string,
    referenceExternalTransactionId: string,
    ctx?: TransactionContext
  ): Promise<WagerTransaction | undefined>;
  findByReferenceTransactionId(
    referenceTransactionId: string,
    ctx?: TransactionContext
  ): Promise<WagerTransaction | undefined>;
  claimDuePendingReferences(
    now: Date,
    limit: number,
    leaseMs: number,
    ctx?: TransactionContext
  ): Promise<WagerTransaction[]>;
  deferPendingReference(
    id: string,
    nextReferenceAttemptAt: Date,
    lastAttemptAt: Date,
    ctx?: TransactionContext
  ): Promise<void>;
  save(transaction: WagerTransaction, ctx?: TransactionContext): Promise<void>;
}
