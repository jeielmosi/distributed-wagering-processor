import { Inject, Injectable } from '@nestjs/common';
import { FailureCode } from '../../shared/errors/failure-code';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { InvalidRequestError, ResourceNotFoundError } from '../errors/application.errors';
import { WAGER_TRANSACTION_REPOSITORY } from '../ports/tokens';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';
import type { TransactionView } from './query.types';

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 255) {
    throw new InvalidRequestError(`${field} must contain between 1 and 255 characters`);
  }
}

@Injectable()
export class GetTransactionUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository
  ) {}

  async byId(transactionId: string): Promise<TransactionView> {
    const transaction = await this.transactions.findById(transactionId);
    if (transaction === undefined) {
      throw new ResourceNotFoundError('Transaction not found', FailureCode.TransactionNotFound);
    }
    return this.toView(transaction);
  }

  async byProviderExternalId(
    providerId: string,
    externalTransactionId: string
  ): Promise<TransactionView> {
    assertIdentifier(providerId, 'providerId');
    assertIdentifier(externalTransactionId, 'externalTransactionId');
    const transaction = await this.transactions.findByProviderAndExternalId(
      providerId,
      externalTransactionId
    );
    if (transaction === undefined) {
      throw new ResourceNotFoundError('Transaction not found', FailureCode.TransactionNotFound);
    }
    return this.toView(transaction);
  }

  private toView(transaction: WagerTransaction): TransactionView {
    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      playerId: transaction.playerId,
      walletId: transaction.walletId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      status: transaction.status,
      balanceAfter:
        transaction.balanceAfter === undefined ? null : transaction.balanceAfter.toJSON(),
      failureCode: transaction.failureCode ?? null,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      createdAt: transaction.createdAt.toISOString(),
      processedAt: transaction.processedAt?.toISOString() ?? null,
      resolvedAt: transaction.resolvedAt?.toISOString() ?? null
    };
  }
}
