import { describe, expect, test } from 'bun:test';
import { Money } from '../../domain/money/money';
import { FailureCode } from '../../shared/errors/failure-code';
import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction-status';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { ReferenceOutcome } from '../../domain/wager-transaction/reference-policy';
import { ReferenceResolverService } from './reference-resolver.service';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

interface TransactionOptions {
  kind: WagerTransactionKind;
  externalTransactionId: string;
  amount?: string;
  referenceExternalTransactionId?: string;
  playerId?: string;
  walletId?: string;
  roundId?: string;
  currency?: string;
}

function providerTransaction(options: TransactionOptions): WagerTransaction {
  return WagerTransaction.create({
    id: Bun.randomUUIDv7(),
    providerId: 'provider-a',
    externalTransactionId: options.externalTransactionId,
    idempotencyKey: `key-${options.externalTransactionId}`,
    payloadHash: 'a'.repeat(64),
    walletId: options.walletId ?? '0192f291-27dd-7d3f-8071-5f8685deef37',
    playerId: options.playerId ?? '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    roundId: options.roundId ?? 'round-1',
    gameId: 'game-1',
    kind: options.kind,
    money: Money.from({ amount: options.amount ?? '25.00', currency: options.currency ?? 'BRL' }),
    referenceExternalTransactionId: options.referenceExternalTransactionId,
    createdAt: new Date('2026-10-26T12:00:00.000Z')
  });
}

function processed(transaction: WagerTransaction, balance = '90.00'): WagerTransaction {
  transaction.markProcessed(
    brl(balance),
    transaction.referenceExternalTransactionId === undefined ? undefined : 'target-id',
    new Date('2026-10-26T12:01:00.000Z')
  );
  return transaction;
}

class FakeTransactionRepository implements WagerTransactionRepository {
  byExternal = new Map<string, WagerTransaction>();
  reversals = new Map<string, WagerTransaction>();
  settlements = new Map<string, WagerTransaction>();

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return [...this.byExternal.values()].find((item) => item.id === id);
  }

  async findByProviderAndIdempotencyKey(): Promise<WagerTransaction | undefined> {
    return undefined;
  }

  async findOpeningByWalletId(): Promise<WagerTransaction | undefined> {
    return undefined;
  }

  async findByProviderAndExternalId(
    _providerId: string,
    externalTransactionId: string
  ): Promise<WagerTransaction | undefined> {
    return this.byExternal.get(externalTransactionId);
  }

  async findSettlementByProviderAndReference(
    _providerId: string,
    referenceExternalTransactionId: string
  ): Promise<WagerTransaction | undefined> {
    return this.settlements.get(referenceExternalTransactionId);
  }

  async findByReferenceTransactionId(
    referenceTransactionId: string
  ): Promise<WagerTransaction | undefined> {
    return this.reversals.get(referenceTransactionId);
  }

  async claimDuePendingReferences(): Promise<WagerTransaction[]> {
    return [];
  }

  async deferPendingReference(): Promise<void> {
    return undefined;
  }

  async save(): Promise<void> {
    return undefined;
  }
}

function setup() {
  const repository = new FakeTransactionRepository();
  const resolver = new ReferenceResolverService(repository);
  return { repository, resolver };
}

describe('ReferenceResolverService', () => {
  test('sem referência aplica diretamente', async () => {
    const { resolver } = setup();
    const request = providerTransaction({
      kind: WagerTransactionKind.Win,
      externalTransactionId: 'win-1'
    });

    const resolution = await resolver.resolve(request);
    expect(resolution.decision).toEqual({ outcome: ReferenceOutcome.Apply });
    expect(resolution.target).toBeUndefined();
  });

  test('referência ausente mantém PENDING_REFERENCE', async () => {
    const { resolver } = setup();
    const request = providerTransaction({
      kind: WagerTransactionKind.Refund,
      externalTransactionId: 'refund-1',
      referenceExternalTransactionId: 'bet-missing'
    });

    const resolution = await resolver.resolve(request);
    expect(resolution.decision).toEqual({ outcome: ReferenceOutcome.Pending });
  });

  test('BET PROCESSED aceita WIN, LOSS e REFUND', async () => {
    const { repository, resolver } = setup();
    const bet = processed(
      providerTransaction({ kind: WagerTransactionKind.Bet, externalTransactionId: 'bet-1' }),
      '75.00'
    );
    repository.byExternal.set('bet-1', bet);

    for (const kind of [
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund
    ]) {
      const request = providerTransaction({
        kind,
        externalTransactionId: `${kind}-1`,
        referenceExternalTransactionId: 'bet-1'
      });
      const resolution = await resolver.resolve(request);
      expect(resolution.decision).toEqual({ outcome: ReferenceOutcome.Apply });
      expect(resolution.target).toBe(bet);
    }
  });

  test('alvo REJECTED/FAILED retorna REFERENCE_NOT_PROCESSED', async () => {
    const { repository, resolver } = setup();
    const bet = providerTransaction({
      kind: WagerTransactionKind.Bet,
      externalTransactionId: 'bet-rejected'
    });
    bet.reject(FailureCode.InsufficientFunds);
    repository.byExternal.set('bet-rejected', bet);

    const resolution = await resolver.resolve(
      providerTransaction({
        kind: WagerTransactionKind.Refund,
        externalTransactionId: 'refund-2',
        referenceExternalTransactionId: 'bet-rejected'
      })
    );
    expect(resolution.decision).toEqual({
      outcome: ReferenceOutcome.Reject,
      failureCode: FailureCode.ReferenceNotProcessed
    });
  });

  test('alvo já revertido retorna REFERENCE_ALREADY_REVERTED', async () => {
    const { repository, resolver } = setup();
    const bet = processed(
      providerTransaction({ kind: WagerTransactionKind.Bet, externalTransactionId: 'bet-2' })
    );
    repository.byExternal.set('bet-2', bet);
    const refund = processed(
      providerTransaction({
        kind: WagerTransactionKind.Refund,
        externalTransactionId: 'refund-3',
        referenceExternalTransactionId: 'bet-2'
      }),
      '100.00'
    );
    repository.reversals.set(bet.id, refund);

    const resolution = await resolver.resolve(
      providerTransaction({
        kind: WagerTransactionKind.Win,
        externalTransactionId: 'win-3',
        referenceExternalTransactionId: 'bet-2'
      })
    );
    expect(resolution.decision).toEqual({
      outcome: ReferenceOutcome.Reject,
      failureCode: FailureCode.ReferenceAlreadyReverted
    });
  });

  test('BET já liquidada retorna REFERENCE_ALREADY_SETTLED', async () => {
    const { repository, resolver } = setup();
    const bet = processed(
      providerTransaction({ kind: WagerTransactionKind.Bet, externalTransactionId: 'bet-3' })
    );
    repository.byExternal.set('bet-3', bet);
    const settlement = processed(
      providerTransaction({
        kind: WagerTransactionKind.Loss,
        externalTransactionId: 'loss-1',
        referenceExternalTransactionId: 'bet-3'
      }),
      '100.00'
    );
    repository.settlements.set('bet-3', settlement);

    const resolution = await resolver.resolve(
      providerTransaction({
        kind: WagerTransactionKind.Win,
        externalTransactionId: 'win-4',
        referenceExternalTransactionId: 'bet-3'
      })
    );
    expect(resolution.decision).toEqual({
      outcome: ReferenceOutcome.Reject,
      failureCode: FailureCode.ReferenceAlreadySettled
    });
  });

  test('BET com WIN ativo bloqueia REFUND; após reverter o WIN o REFUND é aceito', async () => {
    const { repository, resolver } = setup();
    const bet = processed(
      providerTransaction({ kind: WagerTransactionKind.Bet, externalTransactionId: 'bet-4' })
    );
    repository.byExternal.set('bet-4', bet);
    const win = processed(
      providerTransaction({
        kind: WagerTransactionKind.Win,
        externalTransactionId: 'win-5',
        referenceExternalTransactionId: 'bet-4'
      }),
      '100.00'
    );
    repository.settlements.set('bet-4', win);

    const request = providerTransaction({
      kind: WagerTransactionKind.Refund,
      externalTransactionId: 'refund-4',
      referenceExternalTransactionId: 'bet-4'
    });
    expect((await resolver.resolve(request)).decision).toEqual({
      outcome: ReferenceOutcome.Reject,
      failureCode: FailureCode.ReferenceHasProcessedWin
    });

    const winRollback = processed(
      providerTransaction({
        kind: WagerTransactionKind.Rollback,
        externalTransactionId: 'rollback-1',
        referenceExternalTransactionId: 'win-5'
      })
    );
    repository.reversals.set(win.id, winRollback);

    expect((await resolver.resolve(request)).decision).toEqual({ outcome: ReferenceOutcome.Apply });
  });

  test('contexto divergente retorna REFERENCE_CONTEXT_MISMATCH', async () => {
    const { repository, resolver } = setup();
    const bet = processed(
      providerTransaction({ kind: WagerTransactionKind.Bet, externalTransactionId: 'bet-5' })
    );
    repository.byExternal.set('bet-5', bet);

    const resolution = await resolver.resolve(
      providerTransaction({
        kind: WagerTransactionKind.Win,
        externalTransactionId: 'win-6',
        referenceExternalTransactionId: 'bet-5',
        roundId: 'round-2'
      })
    );
    expect(resolution.decision).toEqual({
      outcome: ReferenceOutcome.Reject,
      failureCode: FailureCode.ReferenceContextMismatch
    });
  });

  test('kind incompatível retorna INVALID_REFERENCE_KIND', async () => {
    const { repository, resolver } = setup();
    const win = processed(
      providerTransaction({
        kind: WagerTransactionKind.Win,
        externalTransactionId: 'win-7'
      }),
      '100.00'
    );
    repository.byExternal.set('win-7', win);

    const resolution = await resolver.resolve(
      providerTransaction({
        kind: WagerTransactionKind.Refund,
        externalTransactionId: 'refund-5',
        referenceExternalTransactionId: 'win-7'
      })
    );
    expect(resolution.decision).toEqual({
      outcome: ReferenceOutcome.Reject,
      failureCode: FailureCode.InvalidReferenceKind
    });
  });

  test('valor divergente em REFUND retorna REFERENCE_AMOUNT_MISMATCH', async () => {
    const { repository, resolver } = setup();
    const bet = processed(
      providerTransaction({ kind: WagerTransactionKind.Bet, externalTransactionId: 'bet-6' })
    );
    repository.byExternal.set('bet-6', bet);

    const resolution = await resolver.resolve(
      providerTransaction({
        kind: WagerTransactionKind.Refund,
        externalTransactionId: 'refund-6',
        amount: '20.00',
        referenceExternalTransactionId: 'bet-6'
      })
    );
    expect(resolution.decision).toEqual({
      outcome: ReferenceOutcome.Reject,
      failureCode: FailureCode.ReferenceAmountMismatch
    });
  });

  test('alvo PENDING_REFERENCE mantém o solicitante pendente', async () => {
    const { repository, resolver } = setup();
    const pendingRefund = providerTransaction({
      kind: WagerTransactionKind.Refund,
      externalTransactionId: 'refund-pending',
      referenceExternalTransactionId: 'bet-missing'
    });
    pendingRefund.markPendingReference(new Date('2026-10-26T12:00:00.000Z'), {
      nextReferenceAttemptAt: new Date('2026-10-26T12:00:05.000Z'),
      referenceExpiresAt: new Date('2026-10-26T13:00:00.000Z')
    });
    expect(pendingRefund.status).toBe(WagerTransactionStatus.PendingReference);
    repository.byExternal.set('refund-pending', pendingRefund);

    const resolution = await resolver.resolve(
      providerTransaction({
        kind: WagerTransactionKind.Rollback,
        externalTransactionId: 'rollback-pending',
        referenceExternalTransactionId: 'refund-pending'
      })
    );
    expect(resolution.decision).toEqual({ outcome: ReferenceOutcome.Pending });
  });
});
