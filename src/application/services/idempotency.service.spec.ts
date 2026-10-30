import { describe, expect, test } from 'bun:test';
import { IdempotencyService } from './idempotency.service';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction-kind';
import { Money } from '../../domain/money/money';
import { InvalidRequestError, IdempotencyPayloadMismatchError } from '../errors/application.errors';
import { FailureCode } from '../../shared/errors/failure-code';
import { ProcessWagerTransactionCommand } from '../use-cases/process-wager-transaction.types';
import type { TransactionContext } from '../ports/transaction-context';

function command(
  overrides: Partial<ProcessWagerTransactionCommand> = {}
): ProcessWagerTransactionCommand {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'external-1',
    idempotencyKey: 'key-1',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.0', currency: 'BRL' },
    correlationId: 'corr-1',
    ...overrides
  };
}

class FakeTransactionRepository implements WagerTransactionRepository {
  readonly items: WagerTransaction[] = [];

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.items.find((item) => item.id === id);
  }

  async findByProviderAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string
  ): Promise<WagerTransaction | undefined> {
    return this.items.find(
      (item) => item.providerId === providerId && item.idempotencyKey === idempotencyKey
    );
  }

  async findOpeningByWalletId(): Promise<WagerTransaction | undefined> {
    return undefined;
  }

  async findByProviderAndExternalId(): Promise<WagerTransaction | undefined> {
    return undefined;
  }

  async findSettlementByProviderAndReference(): Promise<WagerTransaction | undefined> {
    return undefined;
  }

  async findByReferenceTransactionId(): Promise<WagerTransaction | undefined> {
    return undefined;
  }

  async claimDuePendingReferences(): Promise<WagerTransaction[]> {
    return [];
  }

  async deferPendingReference(): Promise<void> {
    return undefined;
  }

  async save(transaction: WagerTransaction, _ctx?: TransactionContext): Promise<void> {
    const index = this.items.findIndex((item) => item.id === transaction.id);
    if (index === -1) {
      this.items.push(transaction);
    } else {
      this.items[index] = transaction;
    }
  }
}

describe('IdempotencyService', () => {
  const repository = new FakeTransactionRepository();
  const service = new IdempotencyService(repository);

  test('normaliza a Idempotency-Key e rejeita valores fora do contrato', () => {
    expect(service.requireKey('  key  ')).toBe('key');
    expect(() => service.requireKey(undefined)).toThrow(InvalidRequestError);
    expect(() => service.requireKey('   ')).toThrow(InvalidRequestError);
    expect(() => service.requireKey('k'.repeat(256))).toThrow(InvalidRequestError);
    expect(service.requireKey('k'.repeat(255))).toBe('k'.repeat(255));
  });

  test('hash é estável, ignora a idempotency key e varia com o payload', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });
    const base = service.buildHash(command(), money);
    const otherKey = service.buildHash(command({ idempotencyKey: 'key-2' }), money);
    const otherAmount = service.buildHash(
      command({ money: { amount: '30.00', currency: 'BRL' } }),
      Money.from({ amount: '30.00', currency: 'BRL' })
    );

    expect(base).toHaveLength(64);
    expect(otherKey).toBe(base);
    expect(otherAmount).not.toBe(base);
  });

  test('lookup é escopado por provider', async () => {
    const transaction = WagerTransaction.create({
      id: '0192f298-345e-7e38-af88-e43f851a819d',
      providerId: 'provider-a',
      externalTransactionId: 'external-1',
      idempotencyKey: 'key-1',
      payloadHash: 'a'.repeat(64),
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: 'BRL' })
    });
    await repository.save(transaction);

    expect(await service.findExisting('provider-a', 'key-1')).toBe(transaction);
    expect(await service.findExisting('provider-b', 'key-1')).toBeUndefined();
  });

  test('erro de conflito expõe o failureCode contractual', () => {
    const error = new IdempotencyPayloadMismatchError();
    expect(error.failureCode).toBe(FailureCode.IdempotencyPayloadMismatch);
    expect(error.httpStatus).toBe(409);
  });
});
