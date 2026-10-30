import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../ledger/ledger-direction';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { WalletBalanceChanged } from '../events/wallet-balance-changed';
import { InvalidOutboxMessageError, MAX_OUTBOX_ATTEMPTS, OutboxMessage } from './outbox-message';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const occurredAt = new Date('2026-07-29T15:00:00.000Z');
const ctx = {
  eventId: '0192f298-345e-7e38-af88-e43f851a8300',
  correlationId: 'correlation-1',
  causationId: 'cause-1',
  occurredAt
};

const event = (): WalletBalanceChanged =>
  WalletBalanceChanged.from(
    WalletLedgerEntry.create({
      id: '0192f298-345e-7e38-af88-e43f851a8400',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
      walletVersion: 2,
      createdAt: occurredAt
    }),
    ctx
  );

const enqueue = (): OutboxMessage => OutboxMessage.enqueue(event());

describe('OutboxMessage', () => {
  test('enqueue usa eventId, aggregateId e eventType do evento', () => {
    const message = enqueue();

    expect(message.id).toBe(ctx.eventId);
    expect(message.aggregateId).toBe('0192f291-27dd-7d3f-8071-5f8685deef37');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.occurredAt).toBe(occurredAt);
    expect(message.attempts).toBe(0);
    expect(message.claimCount).toBe(0);
    expect(message.publishedAt).toBeUndefined();
    expect(message.deadLetteredAt).toBeUndefined();
    expect(message.isPending()).toBe(true);
  });

  test('enqueue deixa a mensagem devida imediatamente', () => {
    const message = enqueue();

    expect(message.nextAttemptAt).toBe(occurredAt);
    expect(message.isDue(occurredAt)).toBe(true);
    expect(message.isDue(new Date(occurredAt.getTime() - 1))).toBe(false);
  });

  test('payload contém o envelope completo', () => {
    const message = enqueue();

    expect(message.payload).toEqual(event().toJSON() as unknown as Record<string, unknown>);
  });

  test('markPublished encerra o ciclo', () => {
    const message = enqueue();
    const publishedAt = new Date('2026-07-29T15:02:00.000Z');
    message.markPublished(publishedAt);

    expect(message.publishedAt).toBe(publishedAt);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date('2027-01-01T00:00:00.000Z'))).toBe(false);
  });

  test('markPublished é rejeitado em mensagem já publicada', () => {
    const message = enqueue();
    message.markPublished(occurredAt);
    expect(() => message.markPublished(occurredAt)).toThrow(InvalidOutboxMessageError);
  });

  test('scheduleRetry incrementa attempts e aplica backoff exponencial', () => {
    const message = enqueue();
    const now = new Date('2026-07-29T15:00:00.000Z');

    message.scheduleRetry(now);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt.getTime()).toBe(now.getTime() + 5000);

    message.scheduleRetry(now);
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt.getTime()).toBe(now.getTime() + 10000);

    message.scheduleRetry(now);
    expect(message.attempts).toBe(3);
    expect(message.nextAttemptAt.getTime()).toBe(now.getTime() + 20000);
  });

  test('backoff respeita o teto de 60 segundos', () => {
    const message = enqueue();
    const now = new Date('2026-07-29T15:00:00.000Z');

    for (let attempt = 0; attempt < 8; attempt += 1) {
      message.scheduleRetry(now);
    }

    expect(message.attempts).toBe(8);
    expect(message.nextAttemptAt.getTime()).toBe(now.getTime() + 60000);
  });

  test('dead-letter após MAX_OUTBOX_ATTEMPTS falhas', () => {
    const message = enqueue();
    const now = new Date('2026-07-29T15:00:00.000Z');

    for (let attempt = 0; attempt < MAX_OUTBOX_ATTEMPTS; attempt += 1) {
      message.scheduleRetry(now, 'publish failed');
    }

    expect(message.attempts).toBe(MAX_OUTBOX_ATTEMPTS);
    expect(message.deadLetteredAt).toBeDefined();
    expect(message.lastError).toBe('publish failed');
    expect(message.isPending()).toBe(false);
  });

  test('markDeadLettered preserva erro e data', () => {
    const message = enqueue();
    const deadLetteredAt = new Date('2026-07-29T15:02:00.000Z');
    message.markDeadLettered(deadLetteredAt, 'dlq failure');

    expect(message.deadLetteredAt).toBe(deadLetteredAt);
    expect(message.lastError).toBe('dlq failure');
    expect(message.isPending()).toBe(false);
  });

  test('mensagem publicada ou dead-lettered não agenda retry', () => {
    const published = enqueue();
    published.markPublished(occurredAt);
    expect(() => published.scheduleRetry(occurredAt)).toThrow(InvalidOutboxMessageError);

    const deadLettered = enqueue();
    deadLettered.markDeadLettered(occurredAt, 'error');
    expect(() => deadLettered.scheduleRetry(occurredAt)).toThrow(InvalidOutboxMessageError);
  });

  test('rehydrate reconstrói o estado persistido', () => {
    const payload = event().toJSON() as unknown as Record<string, unknown>;
    const message = OutboxMessage.rehydrate({
      id: ctx.eventId,
      aggregateId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      eventType: 'WalletBalanceChanged',
      payload,
      occurredAt,
      attempts: 3,
      claimCount: 4,
      nextAttemptAt: new Date('2026-07-29T15:00:20.000Z'),
      publishedAt: undefined,
      deadLetteredAt: undefined,
      lastError: 'previous error',
      createdAt: occurredAt
    });

    expect(message.attempts).toBe(3);
    expect(message.claimCount).toBe(4);
    expect(message.lastError).toBe('previous error');
    expect(message.payload).toEqual(payload);
  });
});
