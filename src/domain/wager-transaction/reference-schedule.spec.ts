import { describe, expect, test } from 'bun:test';
import {
  MAX_REFERENCE_ATTEMPTS,
  PENDING_REFERENCE_TTL_MS,
  PENDING_TARGET_DELAY_MS,
  referenceBackoffDelayMs,
  referenceRetryAt
} from './reference-schedule';

describe('reference schedule', () => {
  test('backoff dobra a cada tentativa e satura em 60s', () => {
    expect(referenceBackoffDelayMs(1)).toBe(5000);
    expect(referenceBackoffDelayMs(2)).toBe(10000);
    expect(referenceBackoffDelayMs(3)).toBe(20000);
    expect(referenceBackoffDelayMs(4)).toBe(40000);
    expect(referenceBackoffDelayMs(5)).toBe(60000);
    expect(referenceBackoffDelayMs(10)).toBe(60000);
  });

  test('agendamento nunca ultrapassa a expiração', () => {
    const now = new Date('2026-10-26T12:00:00.000Z');
    const expiresAt = new Date(now.getTime() + 10000);

    expect(referenceRetryAt(now, 5000, expiresAt)).toEqual(new Date(now.getTime() + 5000));
    expect(referenceRetryAt(now, 60000, expiresAt)).toEqual(expiresAt);
  });

  test('constantes do retry de referência', () => {
    expect(MAX_REFERENCE_ATTEMPTS).toBe(10);
    expect(PENDING_REFERENCE_TTL_MS).toBe(3600_000);
    expect(PENDING_TARGET_DELAY_MS).toBe(45000);
  });
});
