import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../ledger/ledger-direction';
import { Money } from '../money/money';
import { ZeroMovementError } from '../../shared/errors/zero-movement-error';
import { FailureCode } from '../../shared/errors/failure-code';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError
} from './wager-transaction.errors';
import { WagerTransactionKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';
import { CreateWagerTransactionProps, WagerTransaction } from './wager-transaction';

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
  money: brl('25.00'),
  createdAt: new Date('2026-07-29T15:00:00.000Z')
};

const create = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction =>
  WagerTransaction.create({ ...base, ...overrides });

const createProcessed = (
  overrides: Partial<CreateWagerTransactionProps> = {},
  balanceAfter = brl('100.00')
): WagerTransaction => {
  const transaction = create(overrides);
  transaction.markProcessed(balanceAfter, undefined, new Date('2026-07-29T15:01:00.000Z'));
  return transaction;
};

describe('WagerTransaction', () => {
  describe('criação', () => {
    test('cria transações para cada kind de provedor', () => {
      for (const kind of [
        WagerTransactionKind.Bet,
        WagerTransactionKind.Win,
        WagerTransactionKind.Loss,
        WagerTransactionKind.Refund,
        WagerTransactionKind.Rollback
      ]) {
        const transaction = create({
          kind,
          referenceExternalTransactionId:
            kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback
              ? 'transaction-100'
              : undefined
        });
        expect(transaction.kind).toBe(kind);
        expect(transaction.status).toBe(WagerTransactionStatus.Pending);
      }
    });

    test('OPENING não pode ser criado pela factory create', () => {
      expect(() => create({ kind: WagerTransactionKind.Opening })).toThrow(
        InvalidWagerTransactionError
      );
    });

    test('OPENING com referência falha com INVALID_PAYLOAD', () => {
      try {
        create({
          kind: WagerTransactionKind.Opening,
          referenceExternalTransactionId: 'transaction-100'
        });
        throw new Error('expected create to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidWagerTransactionError);
        expect((error as InvalidWagerTransactionError).failureCode).toBe(
          FailureCode.InvalidPayload
        );
      }
    });

    test('rejeita REFUND e ROLLBACK sem referência', () => {
      expect(() => create({ kind: WagerTransactionKind.Refund })).toThrow(
        InvalidWagerTransactionError
      );
      expect(() => create({ kind: WagerTransactionKind.Rollback })).toThrow(
        InvalidWagerTransactionError
      );
    });

    test('rejeita BET com referência', () => {
      expect(() => create({ referenceExternalTransactionId: 'transaction-100' })).toThrow(
        InvalidWagerTransactionError
      );
    });

    test('aceita WIN e LOSS com e sem referência', () => {
      expect(
        create({ kind: WagerTransactionKind.Win }).referenceExternalTransactionId
      ).toBeUndefined();
      expect(
        create({
          kind: WagerTransactionKind.Win,
          referenceExternalTransactionId: 'transaction-100'
        }).referenceExternalTransactionId
      ).toBe('transaction-100');
      expect(
        create({ kind: WagerTransactionKind.Loss }).referenceExternalTransactionId
      ).toBeUndefined();
      expect(
        create({
          kind: WagerTransactionKind.Loss,
          referenceExternalTransactionId: 'transaction-100'
        }).referenceExternalTransactionId
      ).toBe('transaction-100');
    });

    test('WIN sem referência é processado como crédito direto', () => {
      const win = create({ kind: WagerTransactionKind.Win });
      win.markProcessed(brl('125.00'), undefined, new Date('2026-07-29T15:01:00.000Z'));

      expect(win.status).toBe(WagerTransactionStatus.Processed);
      expect(win.balanceAfter?.toString()).toBe('125.00');
      expect(win.referenceTransactionId).toBeUndefined();
    });

    test('rejeita auto-referência', () => {
      expect(() =>
        create({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'transaction-123'
        })
      ).toThrow(InvalidWagerTransactionError);
    });

    test('rejeita zero e valores negativos', () => {
      expect(() => create({ money: brl('0.00') })).toThrow(ZeroMovementError);
      expect(() => create({ money: brl('25.00').negate() })).toThrow(InvalidWagerTransactionError);
    });

    test('rejeita campos obrigatórios vazios', () => {
      expect(() => create({ providerId: '' })).toThrow(InvalidWagerTransactionError);
      expect(() => create({ externalTransactionId: ' ' })).toThrow(InvalidWagerTransactionError);
      expect(() => create({ idempotencyKey: '' })).toThrow(InvalidWagerTransactionError);
      expect(() => create({ payloadHash: 'abc' })).toThrow(InvalidWagerTransactionError);
      expect(() => create({ walletId: '' })).toThrow(InvalidWagerTransactionError);
      expect(() => create({ playerId: '' })).toThrow(InvalidWagerTransactionError);
      expect(() => create({ roundId: '' })).toThrow(InvalidWagerTransactionError);
      expect(() => create({ gameId: '' })).toThrow(InvalidWagerTransactionError);
    });
  });

  describe('opening', () => {
    test('cria OPENING já PROCESSED com campos de provedor nulos', () => {
      const at = new Date('2026-07-29T15:00:00.000Z');
      const transaction = WagerTransaction.opening({
        id: base.id,
        walletId: base.walletId,
        playerId: base.playerId,
        money: brl('100.00'),
        balanceAfter: brl('100.00'),
        at
      });

      expect(transaction.kind).toBe(WagerTransactionKind.Opening);
      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.providerId).toBeNull();
      expect(transaction.externalTransactionId).toBeNull();
      expect(transaction.roundId).toBeNull();
      expect(transaction.gameId).toBeNull();
      expect(transaction.referenceExternalTransactionId).toBeUndefined();
      expect(transaction.referenceTransactionId).toBeUndefined();
      expect(transaction.idempotencyKey).toBe(`internal:opening:${base.walletId}`);
      expect(transaction.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect(transaction.balanceAfter?.toString()).toBe('100.00');
      expect(transaction.processedAt).toBe(at);
      expect(transaction.resolvedAt).toBe(at);
      expect(transaction.affectsBalance()).toBe(true);
    });

    test('rejeita saldo inicial zero', () => {
      expect(() =>
        WagerTransaction.opening({
          id: base.id,
          walletId: base.walletId,
          playerId: base.playerId,
          money: brl('0.00'),
          balanceAfter: brl('0.00')
        })
      ).toThrow(InvalidWagerTransactionError);
    });
  });

  describe('transições', () => {
    test('markProcessed grava snapshot e resolvedAt', () => {
      const transaction = create();
      const at = new Date('2026-07-29T15:01:00.000Z');

      transaction.markProcessed(brl('75.00'), undefined, at);

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.balanceAfter?.toString()).toBe('75.00');
      expect(transaction.processedAt).toBe(at);
      expect(transaction.resolvedAt).toBe(at);
      expect(transaction.isTerminal()).toBe(true);
    });

    test('markProcessed exige referenceTransactionId quando há referência externa', () => {
      const transaction = create({
        kind: WagerTransactionKind.Win,
        referenceExternalTransactionId: 'transaction-100'
      });

      expect(() => transaction.markProcessed(brl('125.00'))).toThrow(InvalidWagerTransactionError);
      transaction.markProcessed(brl('125.00'), '0192f298-345e-7e38-af88-e43f851a8200');
      expect(transaction.referenceTransactionId).toBe('0192f298-345e-7e38-af88-e43f851a8200');
    });

    test('markPendingReference mantém resolvedAt nulo', () => {
      const transaction = create({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-100'
      });

      transaction.markPendingReference();

      expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
      expect(transaction.resolvedAt).toBeUndefined();
      expect(transaction.processedAt).toBeUndefined();
      expect(transaction.isTerminal()).toBe(false);
    });

    test('markProcessed é permitido a partir de PENDING_REFERENCE', () => {
      const transaction = create({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-100'
      });
      transaction.markPendingReference();
      transaction.markProcessed(brl('125.00'), '0192f298-345e-7e38-af88-e43f851a8200');

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    });

    test('rescheduleReferenceAttempt incrementa tentativas e grava lastAttempt', () => {
      const now = new Date('2026-07-29T15:00:00.000Z');
      const expiresAt = new Date(now.getTime() + 3600_000);
      const transaction = create({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-100'
      });
      transaction.markPendingReference(now, {
        nextReferenceAttemptAt: new Date(now.getTime() + 5000),
        referenceExpiresAt: expiresAt
      });

      const next = new Date(now.getTime() + 10_000);
      transaction.rescheduleReferenceAttempt(next, now, true);

      expect(transaction.referenceAttempts).toBe(1);
      expect(transaction.nextReferenceAttemptAt).toEqual(next);
      expect(transaction.referenceLastAttemptAt).toEqual(now);
    });

    test('rescheduleReferenceAttempt sem incremento preserva o orçamento', () => {
      const now = new Date('2026-07-29T15:00:00.000Z');
      const transaction = create({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-100'
      });
      transaction.markPendingReference(now, {
        nextReferenceAttemptAt: new Date(now.getTime() + 5000),
        referenceExpiresAt: new Date(now.getTime() + 3600_000)
      });

      transaction.rescheduleReferenceAttempt(new Date(now.getTime() + 45_000), now, false);

      expect(transaction.referenceAttempts).toBe(0);
    });

    test('rescheduleReferenceAttempt rejeita fora de PENDING_REFERENCE ou após a expiração', () => {
      const now = new Date('2026-07-29T15:00:00.000Z');
      const expiresAt = new Date(now.getTime() + 10_000);
      const transaction = create({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-100'
      });
      transaction.markPendingReference(now, {
        nextReferenceAttemptAt: new Date(now.getTime() + 5000),
        referenceExpiresAt: expiresAt
      });

      expect(() =>
        transaction.rescheduleReferenceAttempt(new Date(expiresAt.getTime() + 1), now, false)
      ).toThrow(InvalidWagerTransactionError);

      const pending = create({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-100'
      });
      expect(() => pending.rescheduleReferenceAttempt(new Date(), now, false)).toThrow(
        InvalidTransactionStateError
      );
    });

    test('reject grava failureCode e resolvedAt', () => {
      const transaction = create();
      const at = new Date('2026-07-29T15:01:00.000Z');

      transaction.reject(FailureCode.InsufficientFunds, at);

      expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(transaction.resolvedAt).toBe(at);
      expect(transaction.balanceAfter).toBeUndefined();
    });

    test('fail grava failureCode e resolvedAt', () => {
      const transaction = create();
      const at = new Date('2026-07-29T15:01:00.000Z');

      transaction.fail(FailureCode.PermanentInfraFailure, at);

      expect(transaction.status).toBe(WagerTransactionStatus.Failed);
      expect(transaction.failureCode).toBe(FailureCode.PermanentInfraFailure);
      expect(transaction.resolvedAt).toBe(at);
    });

    test('estados terminais não podem transicionar', () => {
      const processed = createProcessed();
      expect(() => processed.markProcessed(brl('100.00'))).toThrow(InvalidTransactionStateError);
      expect(() => processed.markPendingReference()).toThrow(InvalidTransactionStateError);
      expect(() => processed.reject(FailureCode.InvalidPayload)).toThrow(
        InvalidTransactionStateError
      );
      expect(() => processed.fail(FailureCode.PermanentInfraFailure)).toThrow(
        InvalidTransactionStateError
      );

      const rejected = create();
      rejected.reject(FailureCode.InsufficientFunds);
      expect(() => rejected.markProcessed(brl('100.00'))).toThrow(InvalidTransactionStateError);
      expect(() => rejected.markPendingReference()).toThrow(InvalidTransactionStateError);

      const failed = create();
      failed.fail(FailureCode.PermanentInfraFailure);
      expect(() => failed.markProcessed(brl('100.00'))).toThrow(InvalidTransactionStateError);
    });
  });

  describe('consultas', () => {
    test('affectsBalance é falso apenas para LOSS', () => {
      expect(create().affectsBalance()).toBe(true);
      expect(create({ kind: WagerTransactionKind.Win }).affectsBalance()).toBe(true);
      expect(create({ kind: WagerTransactionKind.Loss }).affectsBalance()).toBe(false);
      expect(
        create({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'transaction-100'
        }).affectsBalance()
      ).toBe(true);
      expect(
        create({
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: 'transaction-100'
        }).affectsBalance()
      ).toBe(true);
    });

    test('requiresReference e acceptsReference por kind', () => {
      expect(create().requiresReference()).toBe(false);
      expect(
        create({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'transaction-100'
        }).requiresReference()
      ).toBe(true);
      expect(
        create({
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: 'transaction-100'
        }).requiresReference()
      ).toBe(true);

      expect(create().acceptsReference()).toBe(false);
      expect(create({ kind: WagerTransactionKind.Win }).acceptsReference()).toBe(true);
      expect(create({ kind: WagerTransactionKind.Loss }).acceptsReference()).toBe(true);
      expect(
        create({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'transaction-100'
        }).acceptsReference()
      ).toBe(true);
      expect(
        create({
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: 'transaction-100'
        }).acceptsReference()
      ).toBe(true);
    });

    test('isSettlement identifica WIN e LOSS', () => {
      expect(create({ kind: WagerTransactionKind.Win }).isSettlement()).toBe(true);
      expect(create({ kind: WagerTransactionKind.Loss }).isSettlement()).toBe(true);
      expect(create().isSettlement()).toBe(false);
    });

    test('canReverse respeita os alvos permitidos', () => {
      const refund = create({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-100'
      });
      const rollback = create({
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'transaction-100'
      });

      expect(refund.canReverse(WagerTransactionKind.Bet)).toBe(true);
      expect(refund.canReverse(WagerTransactionKind.Win)).toBe(false);
      expect(rollback.canReverse(WagerTransactionKind.Bet)).toBe(true);
      expect(rollback.canReverse(WagerTransactionKind.Win)).toBe(true);
      expect(rollback.canReverse(WagerTransactionKind.Refund)).toBe(true);
      expect(rollback.canReverse(WagerTransactionKind.Loss)).toBe(false);
      expect(create().canReverse(WagerTransactionKind.Bet)).toBe(false);
    });

    test('ledgerDirectionFor por kind', () => {
      expect(create().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(create({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(
        LedgerDirection.Credit
      );
      expect(create({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor()).toBeUndefined();
      expect(
        create({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'transaction-100'
        }).ledgerDirectionFor()
      ).toBe(LedgerDirection.Credit);
    });

    test('ledgerDirectionFor de ROLLBACK inverte a referência', () => {
      const bet = create();
      const win = create({ kind: WagerTransactionKind.Win });
      const refund = create({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-100'
      });
      const rollback = create({
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'transaction-100'
      });

      expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
      expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    });

    test('matchesPayload compara o hash', () => {
      const transaction = create();
      expect(transaction.matchesPayload(base.payloadHash)).toBe(true);
      expect(transaction.matchesPayload('b'.repeat(64))).toBe(false);
    });
  });
});
