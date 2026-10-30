import { Inject, Injectable } from '@nestjs/common';
import type { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { hashWagerPayload } from '../../shared/hash/canonical-hash';
import type { TransactionContext } from '../ports/transaction-context';
import { WAGER_TRANSACTION_REPOSITORY } from '../ports/tokens';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';
import { InvalidRequestError } from '../errors/application.errors';
import type { ProcessWagerTransactionCommand } from '../use-cases/process-wager-transaction.types';

export interface WagerPayloadForHash {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string;
}

@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository
  ) {}

  requireKey(rawKey: unknown): string {
    if (typeof rawKey !== 'string') {
      throw new InvalidRequestError('Idempotency-Key must contain between 1 and 255 characters');
    }
    const key = rawKey.trim();
    if (key.length === 0 || key.length > 255) {
      throw new InvalidRequestError('Idempotency-Key must contain between 1 and 255 characters');
    }
    return key;
  }

  buildHash(command: ProcessWagerTransactionCommand, money: Money): string {
    return hashWagerPayload({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: command.referenceExternalTransactionId
    });
  }

  findExisting(
    providerId: string,
    idempotencyKey: string,
    ctx?: TransactionContext
  ): Promise<WagerTransaction | undefined> {
    return this.transactions.findByProviderAndIdempotencyKey(providerId, idempotencyKey, ctx);
  }
}
