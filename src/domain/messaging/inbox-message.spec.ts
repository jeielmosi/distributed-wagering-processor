import { describe, expect, test } from 'bun:test';
import { InvalidInboxMessageError } from './inbox-message.errors';
import { InboxMessage } from './inbox-message';

const receivedAt = new Date('2026-07-29T15:00:00.000Z');
const processedAt = new Date('2026-07-29T15:01:00.000Z');
const payloadHash = 'a'.repeat(64);

const receive = (
  overrides: Partial<Parameters<typeof InboxMessage.receive>[0]> = {}
): InboxMessage =>
  InboxMessage.receive({
    messageId: 'message-123',
    consumerName: 'wager-transactions',
    payloadHash,
    receivedAt,
    ...overrides
  });

describe('InboxMessage', () => {
  test('receive cria mensagem não processada', () => {
    const message = receive();

    expect(message.messageId).toBe('message-123');
    expect(message.consumerName).toBe('wager-transactions');
    expect(message.payloadHash).toBe(payloadHash);
    expect(message.receivedAt).toBe(receivedAt);
    expect(message.processedAt).toBeUndefined();
    expect(message.isProcessed()).toBe(false);
  });

  test('markProcessed preenche processedAt', () => {
    const message = receive();
    message.markProcessed(processedAt);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toBe(processedAt);
  });

  test('markProcessed é rejeitado em mensagem já processada', () => {
    const message = receive();
    message.markProcessed(processedAt);
    expect(() => message.markProcessed(processedAt)).toThrow(InvalidInboxMessageError);
  });

  test('rehydrate reconstrói mensagem processada', () => {
    const message = InboxMessage.rehydrate({
      messageId: 'message-123',
      consumerName: 'wager-transactions',
      payloadHash,
      receivedAt,
      processedAt
    });

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toBe(processedAt);
  });

  test('rehydrate reconstrói mensagem não processada', () => {
    const message = InboxMessage.rehydrate({
      messageId: 'message-123',
      consumerName: 'wager-transactions',
      payloadHash,
      receivedAt
    });

    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  test('valida messageId e consumerName', () => {
    expect(() => receive({ messageId: '' })).toThrow(InvalidInboxMessageError);
    expect(() => receive({ messageId: 'x'.repeat(256) })).toThrow(InvalidInboxMessageError);
    expect(() => receive({ consumerName: ' ' })).toThrow(InvalidInboxMessageError);
  });

  test('valida payloadHash SHA-256', () => {
    expect(() => receive({ payloadHash: 'abc' })).toThrow(InvalidInboxMessageError);
    expect(() => receive({ payloadHash: 'z'.repeat(64) })).toThrow(InvalidInboxMessageError);
  });
});
