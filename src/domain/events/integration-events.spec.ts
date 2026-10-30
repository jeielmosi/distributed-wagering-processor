import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../shared/errors/failure-code';
import { LedgerDirection } from '../ledger/ledger-direction';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { WagerTransactionKind } from '../wager-transaction/wager-transaction-kind';
import {
  CreateWagerTransactionProps,
  WagerTransaction
} from '../wager-transaction/wager-transaction';
import { EventContext, IntegrationEventType, integrationEventWireType } from './integration-event';
import { mapTransactionEvents } from './event-mapper';
import { WagerTransactionPendingReference } from './wager-transaction-pending-reference';
import { WagerTransactionProcessed } from './wager-transaction-processed';
import { WagerTransactionRejected } from './wager-transaction-rejected';
import { WalletBalanceChanged } from './wallet-balance-changed';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const occurredAt = new Date('2026-07-29T15:00:00.000Z');
const ctx: EventContext & { eventId: string } = {
  eventId: '0192f298-345e-7e38-af88-e43f851a8300',
  correlationId: 'correlation-1',
  causationId: 'cause-1',
  occurredAt
};

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
  createdAt: occurredAt
};

const create = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction =>
  WagerTransaction.create({ ...base, ...overrides });

const processed = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction => {
  const transaction = create(overrides);
  transaction.markProcessed(brl('75.00'), undefined, occurredAt);
  return transaction;
};

const entry = (
  overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {}
): WalletLedgerEntry =>
  WalletLedgerEntry.create({
    id: '0192f298-345e-7e38-af88-e43f851a8400',
    walletId: base.walletId,
    transactionId: base.id,
    direction: LedgerDirection.Debit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('75.00'),
    walletVersion: 2,
    createdAt: occurredAt,
    ...overrides
  });

describe('Integration Events', () => {
  describe(IntegrationEventType.WAGER_TRANSACTION_PROCESSED, () => {
    test('serializa payload e envelope', () => {
      const event = WagerTransactionProcessed.from(processed(), ctx);

      expect(event.toJSON()).toEqual({
        eventId: ctx.eventId,
        eventType: integrationEventWireType(IntegrationEventType.WAGER_TRANSACTION_PROCESSED),
        aggregateId: base.id,
        correlationId: ctx.correlationId,
        causationId: ctx.causationId,
        occurredAt: occurredAt.toISOString(),
        version: 1,
        data: {
          transactionId: base.id,
          providerId: base.providerId,
          externalTransactionId: base.externalTransactionId,
          playerId: base.playerId,
          walletId: base.walletId,
          roundId: base.roundId,
          gameId: base.gameId,
          kind: WagerTransactionKind.Bet,
          money: { amount: '25.00', currency: 'BRL' },
          balanceAfter: { amount: '75.00', currency: 'BRL' },
          affectsBalance: true
        }
      });
    });

    test('LOSS tem affectsBalance false e inclui referência resolvida', () => {
      const transaction = create({
        kind: WagerTransactionKind.Loss,
        referenceExternalTransactionId: 'transaction-100'
      });
      transaction.markProcessed(brl('100.00'), '0192f298-345e-7e38-af88-e43f851a8200', occurredAt);

      const json = WagerTransactionProcessed.from(transaction, ctx).toJSON();

      expect(json.data.affectsBalance).toBe(false);
      expect(json.data.referenceTransactionId).toBe('0192f298-345e-7e38-af88-e43f851a8200');
    });

    test('OPENING serializa campos de provedor nulos', () => {
      const opening = WagerTransaction.opening({
        id: base.id,
        walletId: base.walletId,
        playerId: base.playerId,
        money: brl('100.00'),
        balanceAfter: brl('100.00'),
        at: occurredAt
      });
      const json = WagerTransactionProcessed.from(opening, ctx).toJSON();

      expect(json.data.providerId).toBeNull();
      expect(json.data.externalTransactionId).toBeNull();
      expect(json.data.roundId).toBeNull();
      expect(json.data.gameId).toBeNull();
      expect(json.data.money).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(json.data.balanceAfter).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(json.data.affectsBalance).toBe(true);
    });

    test('omite causationId quando ausente', () => {
      const json = WagerTransactionProcessed.from(processed(), {
        ...ctx,
        causationId: undefined
      }).toJSON();

      expect(json).not.toHaveProperty('causationId');
    });
  });

  describe(IntegrationEventType.WAGER_TRANSACTION_REJECTED, () => {
    test('serializa payload e envelope', () => {
      const transaction = create();
      transaction.reject(FailureCode.InsufficientFunds, occurredAt);
      const json = WagerTransactionRejected.from(transaction, ctx).toJSON();

      expect(json.eventType).toBe(
        integrationEventWireType(IntegrationEventType.WAGER_TRANSACTION_REJECTED)
      );
      expect(json.version).toBe(1);
      expect(json.aggregateId).toBe(base.id);
      expect(json.data).toEqual({
        transactionId: base.id,
        providerId: base.providerId,
        externalTransactionId: base.externalTransactionId,
        playerId: base.playerId,
        walletId: base.walletId,
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
        failureCode: FailureCode.InsufficientFunds
      });
    });

    test('inclui referência externa quando presente', () => {
      const transaction = create({
        kind: WagerTransactionKind.Win,
        referenceExternalTransactionId: 'transaction-100'
      });
      transaction.reject(FailureCode.ReferenceNotFound, occurredAt);
      const json = WagerTransactionRejected.from(transaction, ctx).toJSON();

      expect(json.data.referenceExternalTransactionId).toBe('transaction-100');
    });
  });

  describe(IntegrationEventType.WALLET_BALANCE_CHANGED, () => {
    test('serializa payload e envelope', () => {
      const json = WalletBalanceChanged.from(entry(), ctx).toJSON();

      expect(json).toEqual({
        eventId: ctx.eventId,
        eventType: integrationEventWireType(IntegrationEventType.WALLET_BALANCE_CHANGED),
        aggregateId: base.walletId,
        correlationId: ctx.correlationId,
        causationId: ctx.causationId,
        occurredAt: occurredAt.toISOString(),
        version: 1,
        data: {
          walletId: base.walletId,
          transactionId: base.id,
          direction: LedgerDirection.Debit,
          money: { amount: '25.00', currency: 'BRL' },
          balanceBefore: { amount: '100.00', currency: 'BRL' },
          balanceAfter: { amount: '75.00', currency: 'BRL' },
          walletVersion: 2
        }
      });
    });
  });

  describe(IntegrationEventType.WAGER_TRANSACTION_PENDING_REFERENCE, () => {
    test('serializa payload e envelope', () => {
      const transaction = create({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-100'
      });
      transaction.markPendingReference();
      const json = WagerTransactionPendingReference.from(transaction, ctx).toJSON();

      expect(json.eventType).toBe(
        integrationEventWireType(IntegrationEventType.WAGER_TRANSACTION_PENDING_REFERENCE)
      );
      expect(json.aggregateId).toBe(base.id);
      expect(json.data).toEqual({
        transactionId: base.id,
        providerId: base.providerId,
        externalTransactionId: base.externalTransactionId,
        playerId: base.playerId,
        walletId: base.walletId,
        kind: WagerTransactionKind.Refund,
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: 'transaction-100'
      });
    });
  });

  describe('mapTransactionEvents', () => {
    test('PROCESSED com efeito no saldo gera WagerTransactionProcessed e WalletBalanceChanged', () => {
      const transaction = processed();
      const walletEntry = entry();
      const events = mapTransactionEvents(transaction, walletEntry, ctx);

      expect(events.map((event) => event.eventType)).toEqual([
        IntegrationEventType.WAGER_TRANSACTION_PROCESSED,
        IntegrationEventType.WALLET_BALANCE_CHANGED
      ]);
    });

    test('LOSS gera apenas WagerTransactionProcessed', () => {
      const transaction = create({ kind: WagerTransactionKind.Loss });
      transaction.markProcessed(brl('100.00'), undefined, occurredAt);

      const events = mapTransactionEvents(transaction, undefined, ctx);

      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe(IntegrationEventType.WAGER_TRANSACTION_PROCESSED);
    });

    test('OPENING gera WagerTransactionProcessed e WalletBalanceChanged com saldo inicial', () => {
      const opening = WagerTransaction.opening({
        id: base.id,
        walletId: base.walletId,
        playerId: base.playerId,
        money: brl('100.00'),
        balanceAfter: brl('100.00'),
        at: occurredAt
      });
      const openingEntry = entry({
        direction: LedgerDirection.Credit,
        money: brl('100.00'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('100.00'),
        walletVersion: 1
      });

      const events = mapTransactionEvents(opening, openingEntry, ctx);
      const processedJson = events[0]?.toJSON() as ReturnType<WagerTransactionProcessed['toJSON']>;
      const balanceJson = events[1]?.toJSON() as ReturnType<WalletBalanceChanged['toJSON']>;

      expect(processedJson.data.providerId).toBeNull();
      expect(processedJson.data.affectsBalance).toBe(true);
      expect(balanceJson.data.direction).toBe(LedgerDirection.Credit);
      expect(balanceJson.data.balanceBefore).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(balanceJson.data.walletVersion).toBe(1);
    });

    test('REJECTED gera apenas WagerTransactionRejected', () => {
      const transaction = create();
      transaction.reject(FailureCode.InsufficientFunds, occurredAt);

      const events = mapTransactionEvents(transaction, undefined, ctx);

      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe(IntegrationEventType.WAGER_TRANSACTION_REJECTED);
    });

    test('PENDING_REFERENCE gera apenas WagerTransactionPendingReference', () => {
      const transaction = create({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-100'
      });
      transaction.markPendingReference();

      const events = mapTransactionEvents(transaction, undefined, ctx);

      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe(IntegrationEventType.WAGER_TRANSACTION_PENDING_REFERENCE);
    });

    test('FAILED não gera evento de integração', () => {
      const transaction = create();
      transaction.fail(FailureCode.PermanentInfraFailure, occurredAt);

      expect(mapTransactionEvents(transaction, undefined, ctx)).toEqual([]);
    });

    test('PROCESSED com efeito no saldo exige lançamento no ledger', () => {
      expect(() => mapTransactionEvents(processed(), undefined, ctx)).toThrow();
    });
  });
});
