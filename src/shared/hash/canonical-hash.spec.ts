import { describe, expect, test } from 'bun:test';
import { canonicalJson, hashWagerPayload, sha256Hex } from './canonical-hash';
import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction-kind';

const basePayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' }
};

describe('canonicalJson', () => {
  test('ordena chaves recursivamente', () => {
    const a = { z: 1, a: { y: 2, b: 3 } };
    const b = { a: { b: 3, y: 2 }, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"b":3,"y":2},"z":1}');
  });

  test('remove chaves nulas e indefinidas', () => {
    expect(canonicalJson({ a: 1, b: null, c: undefined, d: 'x' })).toBe('{"a":1,"d":"x"}');
  });

  test('preserva ordem de arrays', () => {
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
  });

  test('serializa datas em ISO-8601', () => {
    const date = new Date('2026-07-29T15:00:00.000Z');
    expect(canonicalJson({ at: date })).toBe('{"at":"2026-07-29T15:00:00.000Z"}');
  });
});

describe('sha256Hex', () => {
  test('gera SHA-256 hexadecimal', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});

describe('hashWagerPayload', () => {
  test('é independente da ordem das chaves', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: WagerTransactionKind.Bet,
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: basePayload.walletId,
      playerId: basePayload.playerId,
      externalTransactionId: basePayload.externalTransactionId,
      providerId: basePayload.providerId
    };
    expect(hashWagerPayload(reordered)).toBe(hashWagerPayload(basePayload));
  });

  test('normaliza o valor monetário para duas casas', () => {
    expect(hashWagerPayload({ ...basePayload, money: { amount: '25', currency: 'BRL' } })).toBe(
      hashWagerPayload(basePayload)
    );
  });

  test('ignora campos nulos e indefinidos', () => {
    const withNulls = {
      ...basePayload,
      referenceExternalTransactionId: null as unknown as string,
      extra: undefined
    };
    expect(hashWagerPayload(withNulls)).toBe(hashWagerPayload(basePayload));
  });

  test('muda quando o valor, a moeda ou a referência muda', () => {
    const baseHash = hashWagerPayload(basePayload);
    expect(
      hashWagerPayload({ ...basePayload, money: { amount: '25.01', currency: 'BRL' } })
    ).not.toBe(baseHash);
    expect(
      hashWagerPayload({ ...basePayload, money: { amount: '25.00', currency: 'USD' } })
    ).not.toBe(baseHash);
    expect(
      hashWagerPayload({ ...basePayload, referenceExternalTransactionId: 'transaction-122' })
    ).not.toBe(baseHash);
  });

  test('gera 64 caracteres hexadecimais', () => {
    expect(hashWagerPayload(basePayload)).toMatch(/^[0-9a-f]{64}$/);
  });
});
