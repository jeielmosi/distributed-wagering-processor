import { describe, expect, test } from 'bun:test';
import { FailureCode } from './failure-code';

describe('FailureCode', () => {
  test('contém os 23 códigos da taxonomia', () => {
    expect(Object.values(FailureCode)).toHaveLength(23);
    expect(new Set(Object.values(FailureCode)).size).toBe(23);
  });

  test('cobre apostas, reversões, referências, idempotência e wallet', () => {
    const expected = [
      'INSUFFICIENT_FUNDS',
      'INSUFFICIENT_FUNDS_FOR_REVERSAL',
      'REFERENCE_REQUIRED',
      'REFERENCE_NOT_FOUND',
      'REFERENCE_NOT_PROCESSED',
      'REFERENCE_ALREADY_REVERTED',
      'REFERENCE_ALREADY_SETTLED',
      'REFERENCE_HAS_PROCESSED_WIN',
      'REFERENCE_AMOUNT_MISMATCH',
      'REFERENCE_CONTEXT_MISMATCH',
      'INVALID_REFERENCE_KIND',
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'CURRENCY_MISMATCH',
      'INVALID_PAYLOAD',
      'WALLET_NOT_FOUND',
      'WALLET_PLAYER_MISMATCH',
      'WALLET_ALREADY_EXISTS',
      'DUPLICATE_EXTERNAL_TRANSACTION',
      'TRANSACTION_NOT_FOUND',
      'ROUTE_NOT_FOUND',
      'OPENING_NOT_ALLOWED',
      'TRANSIENT_INFRA_FAILURE',
      'PERMANENT_INFRA_FAILURE'
    ];
    expect((Object.values(FailureCode) as string[]).sort()).toEqual(expected.sort());
  });
});
