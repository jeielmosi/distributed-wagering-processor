import { describe, expect, test } from 'bun:test';
import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction-kind';
import {
  InvalidQueueMessageError,
  parseWagerTransactionMessage
} from './wager-transaction-message';

const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';

function message(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messageId: 'msg-123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      playerId: PLAYER_ID,
      walletId: WALLET_ID,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      ...overrides
    }
  });
}

function parse(raw: string, fallback = 'sqs-message-id') {
  return parseWagerTransactionMessage(raw, fallback);
}

describe('parseWagerTransactionMessage', () => {
  test('converte o envelope SQS em comando do use case', () => {
    const parsed = parse(message());

    expect(parsed.messageId).toBe('msg-123');
    expect(parsed.correlationId).toBe('sqs-message-id');
    expect(parsed.command).toEqual({
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      playerId: PLAYER_ID,
      walletId: WALLET_ID,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      correlationId: 'sqs-message-id',
      causationId: 'msg-123'
    });
  });

  test('usa correlationId do body quando presente', () => {
    const body = JSON.parse(message());
    body.correlationId = 'corr-1';

    expect(parse(JSON.stringify(body)).correlationId).toBe('corr-1');
  });

  test('preserva referenceExternalTransactionId quando presente', () => {
    const parsed = parse(
      message({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-100'
      })
    );

    expect(parsed.command.referenceExternalTransactionId).toBe('transaction-100');
  });

  test('rejeita JSON inválido', () => {
    expect(() => parse('{not-json')).toThrow(InvalidQueueMessageError);
  });

  test('rejeita type diferente de WagerTransactionRequested', () => {
    const body = JSON.parse(message());
    body.type = 'OtherEvent';

    expect(() => parse(JSON.stringify(body))).toThrow(InvalidQueueMessageError);
  });

  test('rejeita messageId vazio ou maior que 255', () => {
    const empty = JSON.parse(message());
    empty.messageId = '   ';

    expect(() => parse(JSON.stringify(empty))).toThrow(InvalidQueueMessageError);

    const tooLong = JSON.parse(message());
    tooLong.messageId = 'x'.repeat(256);

    expect(() => parse(JSON.stringify(tooLong))).toThrow(InvalidQueueMessageError);
  });

  test('rejeita data não-objeto', () => {
    const body = JSON.parse(message());
    body.data = 'nope';

    expect(() => parse(JSON.stringify(body))).toThrow(InvalidQueueMessageError);
  });

  test('rejeita campos obrigatórios ausentes ou vazios', () => {
    for (const field of [
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'playerId',
      'walletId',
      'roundId',
      'gameId'
    ]) {
      const body = JSON.parse(message());
      delete body.data[field];
      expect(() => parse(JSON.stringify(body))).toThrow(InvalidQueueMessageError);
    }
  });

  test('rejeita UUID malformado em playerId ou walletId', () => {
    const player = JSON.parse(message());
    player.data.playerId = 'not-a-uuid';
    expect(() => parse(JSON.stringify(player))).toThrow(InvalidQueueMessageError);

    const wallet = JSON.parse(message());
    wallet.data.walletId = '123';
    expect(() => parse(JSON.stringify(wallet))).toThrow(InvalidQueueMessageError);
  });

  test('rejeita kind desconhecido', () => {
    expect(() => parse(message({ kind: 'UNKNOWN' }))).toThrow(InvalidQueueMessageError);
  });

  test('rejeita money sem amount ou currency', () => {
    const withoutAmount = JSON.parse(message());
    delete withoutAmount.data.money.amount;
    expect(() => parse(JSON.stringify(withoutAmount))).toThrow(InvalidQueueMessageError);

    const withoutCurrency = JSON.parse(message());
    delete withoutCurrency.data.money.currency;
    expect(() => parse(JSON.stringify(withoutCurrency))).toThrow(InvalidQueueMessageError);
  });

  test('rejeita BET com referência', () => {
    expect(() => parse(message({ referenceExternalTransactionId: 'transaction-100' }))).toThrow(
      InvalidQueueMessageError
    );
  });

  test('rejeita REFUND/ROLLBACK sem referência', () => {
    expect(() => parse(message({ kind: WagerTransactionKind.Refund }))).toThrow(
      InvalidQueueMessageError
    );
    expect(() => parse(message({ kind: WagerTransactionKind.Rollback }))).toThrow(
      InvalidQueueMessageError
    );
  });

  test('rejeita auto-referência', () => {
    expect(() =>
      parse(
        message({
          kind: WagerTransactionKind.Refund,
          externalTransactionId: 'transaction-123',
          referenceExternalTransactionId: 'transaction-123'
        })
      )
    ).toThrow(InvalidQueueMessageError);
  });
});
