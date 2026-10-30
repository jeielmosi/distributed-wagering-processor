import { describe, expect, test } from 'bun:test';
import { Money } from '../money/money';
import { FailureCode } from '../../shared/errors/failure-code';
import { WagerTransactionKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';
import { CreateWagerTransactionProps, WagerTransaction } from './wager-transaction';
import { evaluateReference, ReferenceOutcome, ReferenceSnapshot } from './reference-policy';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const base: CreateWagerTransactionProps = {
  id: '0192f298-345e-7e38-af88-e43f851a819d',
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  payloadHash: 'a'.repeat(64),
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: brl('25.00')
};

const create = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction =>
  WagerTransaction.create({ ...base, ...overrides });

const processed = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction => {
  const transaction = create(overrides);
  transaction.markProcessed(brl('100.00'), '0192f298-345e-7e38-af88-e43f851a8200');
  return transaction;
};

const snapshot = (
  target: WagerTransaction,
  extra: Omit<ReferenceSnapshot, 'target'> = {}
): ReferenceSnapshot => ({ target, ...extra });

const request = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction =>
  create({
    kind: WagerTransactionKind.Win,
    referenceExternalTransactionId: 'transaction-100',
    ...overrides
  });

describe('evaluateReference', () => {
  test('aplica WIN com referência a BET PROCESSED', () => {
    const bet = processed();
    expect(evaluateReference(request(), snapshot(bet))).toEqual({
      outcome: ReferenceOutcome.Apply
    });
  });

  test('aplica WIN e LOSS sem referência', () => {
    expect(evaluateReference(create({ kind: WagerTransactionKind.Win }), null)).toEqual({
      outcome: ReferenceOutcome.Apply
    });
    expect(evaluateReference(create({ kind: WagerTransactionKind.Loss }), null)).toEqual({
      outcome: ReferenceOutcome.Apply
    });
  });

  test('mantém pendente quando o alvo não existe', () => {
    expect(evaluateReference(request(), null)).toEqual({ outcome: ReferenceOutcome.Pending });
    expect(
      evaluateReference(
        request({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'transaction-100'
        }),
        null
      )
    ).toEqual({ outcome: ReferenceOutcome.Pending });
  });

  test('mantém pendente quando o alvo está PENDING ou PENDING_REFERENCE', () => {
    const pending = create();
    const pendingReference = create({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'transaction-100'
    });
    pendingReference.markPendingReference();

    expect(evaluateReference(request(), snapshot(pending))).toEqual({
      outcome: ReferenceOutcome.Pending
    });
    expect(evaluateReference(request(), snapshot(pendingReference))).toEqual({
      outcome: ReferenceOutcome.Pending
    });
  });

  test('rejeita quando o alvo está REJECTED ou FAILED', () => {
    const rejected = create();
    rejected.reject(FailureCode.InsufficientFunds);
    const failed = create();
    failed.fail(FailureCode.PermanentInfraFailure);

    expect(evaluateReference(request(), snapshot(rejected))).toEqual({
      outcome: ReferenceOutcome.Reject,
      failureCode: FailureCode.ReferenceNotProcessed
    });
    expect(evaluateReference(request(), snapshot(failed))).toEqual({
      outcome: ReferenceOutcome.Reject,
      failureCode: FailureCode.ReferenceNotProcessed
    });
  });

  test('rejeita contexto divergente', () => {
    const bet = processed();
    const scenarios = [
      request({ providerId: 'provider-b' }),
      request({ playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2' }),
      request({ walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }),
      request({ roundId: 'round-988' }),
      request({ money: Money.from({ amount: '25.00', currency: 'USD' }) })
    ];

    for (const transaction of scenarios) {
      expect(evaluateReference(transaction, snapshot(bet))).toEqual({
        outcome: ReferenceOutcome.Reject,
        failureCode: FailureCode.ReferenceContextMismatch
      });
    }
  });

  test('rejeita kind de referência incompatível', () => {
    const win = processed({ kind: WagerTransactionKind.Win });
    const refund = processed({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'transaction-100'
    });
    const loss = processed({ kind: WagerTransactionKind.Loss });

    expect(evaluateReference(request(), snapshot(win))).toEqual({
      outcome: ReferenceOutcome.Reject,
      failureCode: FailureCode.InvalidReferenceKind
    });
    expect(
      evaluateReference(
        request({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'transaction-100'
        }),
        snapshot(win)
      )
    ).toEqual({ outcome: ReferenceOutcome.Reject, failureCode: FailureCode.InvalidReferenceKind });
    expect(
      evaluateReference(
        request({
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: 'transaction-100'
        }),
        snapshot(loss)
      )
    ).toEqual({ outcome: ReferenceOutcome.Reject, failureCode: FailureCode.InvalidReferenceKind });
    expect(evaluateReference(request(), snapshot(refund))).toEqual({
      outcome: ReferenceOutcome.Reject,
      failureCode: FailureCode.InvalidReferenceKind
    });
  });

  test('rejeita valor divergente em REFUND e ROLLBACK', () => {
    const bet = processed();
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      expect(
        evaluateReference(
          request({
            kind,
            referenceExternalTransactionId: 'transaction-100',
            money: brl('24.99')
          }),
          snapshot(bet)
        )
      ).toEqual({
        outcome: ReferenceOutcome.Reject,
        failureCode: FailureCode.ReferenceAmountMismatch
      });
    }
  });

  test('rejeita alvo já revertido para WIN, REFUND e ROLLBACK', () => {
    const bet = processed();
    for (const kind of [
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback
    ]) {
      expect(
        evaluateReference(
          request({ kind, referenceExternalTransactionId: 'transaction-100' }),
          snapshot(bet, { reversedBy: WagerTransactionKind.Refund })
        )
      ).toEqual({
        outcome: ReferenceOutcome.Reject,
        failureCode: FailureCode.ReferenceAlreadyReverted
      });
    }
  });

  test('rejeita REFUND/ROLLBACK de BET com WIN PROCESSED ativo', () => {
    const bet = processed();
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      expect(
        evaluateReference(
          request({ kind, referenceExternalTransactionId: 'transaction-100' }),
          snapshot(bet, { hasProcessedWin: true })
        )
      ).toEqual({
        outcome: ReferenceOutcome.Reject,
        failureCode: FailureCode.ReferenceHasProcessedWin
      });
    }
  });

  test('settlement tem precedência sobre alvo revertido para novo WIN/LOSS', () => {
    const bet = processed();
    for (const kind of [WagerTransactionKind.Win, WagerTransactionKind.Loss]) {
      expect(
        evaluateReference(
          request({ kind, referenceExternalTransactionId: 'transaction-100' }),
          snapshot(bet, {
            reversedBy: WagerTransactionKind.Refund,
            settlementKind: WagerTransactionKind.Loss
          })
        )
      ).toEqual({
        outcome: ReferenceOutcome.Reject,
        failureCode: FailureCode.ReferenceAlreadySettled
      });
    }
  });

  test('rejeita segundo settlement para a mesma BET', () => {
    const bet = processed();
    for (const kind of [WagerTransactionKind.Win, WagerTransactionKind.Loss]) {
      expect(
        evaluateReference(
          request({ kind, referenceExternalTransactionId: 'transaction-100' }),
          snapshot(bet, { settlementKind: WagerTransactionKind.Win })
        )
      ).toEqual({
        outcome: ReferenceOutcome.Reject,
        failureCode: FailureCode.ReferenceAlreadySettled
      });
    }
  });

  test('permite REFUND/ROLLBACK de BET com LOSS PROCESSED como void', () => {
    const bet = processed();
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      expect(
        evaluateReference(
          request({ kind, referenceExternalTransactionId: 'transaction-100' }),
          snapshot(bet, { settlementKind: WagerTransactionKind.Loss })
        )
      ).toEqual({ outcome: ReferenceOutcome.Apply });
    }
  });

  test('permite ROLLBACK de REFUND PROCESSED', () => {
    const refund = processed({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'transaction-100'
    });
    expect(
      evaluateReference(
        request({
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: 'transaction-100'
        }),
        snapshot(refund)
      )
    ).toEqual({ outcome: ReferenceOutcome.Apply });
  });

  test('LOSS com referência a BET PROCESSED é aplicado', () => {
    const bet = processed();
    expect(
      evaluateReference(
        request({
          kind: WagerTransactionKind.Loss,
          referenceExternalTransactionId: 'transaction-100'
        }),
        snapshot(bet)
      )
    ).toEqual({ outcome: ReferenceOutcome.Apply });
  });

  test('não avalia contexto quando o alvo está pendente', () => {
    const pending = create({ providerId: 'provider-b' });
    expect(evaluateReference(request(), snapshot(pending))).toEqual({
      outcome: ReferenceOutcome.Pending
    });
  });

  test('status do alvo não altera o próprio request', () => {
    const transaction = request();
    evaluateReference(transaction, snapshot(processed()));
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
  });
});
