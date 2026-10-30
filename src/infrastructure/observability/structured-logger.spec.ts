import { afterEach, describe, expect, test } from 'bun:test';
import { InvalidMoneyError } from '../../domain/money/money.errors';
import { logger, LogLevel, sanitizeLogValue } from './structured-logger';

const originalError = console.error;

afterEach(() => {
  console.error = originalError;
});

describe('sanitizeLogValue', () => {
  test('redige chaves sensíveis e nunca devolve payload completo', () => {
    const sanitized = sanitizeLogValue({
      correlationId: 'corr-1',
      payload: { amount: '10.00' },
      body: '{"pan":"4111111111111111"}',
      authorization: 'Bearer secret',
      pan: '4111111111111111',
      safe: 'ok'
    }) as Record<string, unknown>;

    expect(sanitized.correlationId).toBe('corr-1');
    expect(sanitized.safe).toBe('ok');
    expect(sanitized.payload).toBe('[redacted]');
    expect(sanitized.body).toBe('[redacted]');
    expect(sanitized.authorization).toBe('[redacted]');
    expect(sanitized.pan).toBe('[redacted]');
  });

  test('não redige chaves que apenas contêm um termo sensível como substring', () => {
    const sanitized = sanitizeLogValue({
      companyId: 'company-1',
      amount: '10.00',
      balanceAfter: '90.00',
      totalAmount: '100.00'
    }) as Record<string, unknown>;

    expect(sanitized.companyId).toBe('company-1');
    expect(sanitized.amount).toBe('[redacted]');
    expect(sanitized.balanceAfter).toBe('[redacted]');
    expect(sanitized.totalAmount).toBe('[redacted]');
  });

  test('trunca strings longas e limita profundidade', () => {
    const long = 'x'.repeat(3000);
    const sanitized = sanitizeLogValue({ long }) as { long: string };
    expect(sanitized.long.length).toBeLessThan(3000);
    expect(sanitized.long.endsWith('[truncated]')).toBe(true);

    const deep = sanitizeLogValue({ a: { b: { c: { d: { e: 1 } } } } }) as {
      a: { b: { c: { d: unknown } } };
    };
    expect(JSON.stringify(deep)).toContain('[truncated]');
  });

  test('não preserva valor monetário na mensagem de Error', () => {
    const sanitized = sanitizeLogValue(new InvalidMoneyError('Invalid monetary amount: -5.00'));

    expect(JSON.stringify(sanitized)).not.toContain('-5.00');
  });
});

describe('StructuredLogger', () => {
  test('emite JSON com campos obrigatórios e sem dados sensíveis', () => {
    let line = '';
    console.error = (value?: unknown) => {
      line = String(value);
    };

    logger
      .child({ transactionId: 'tx-1', walletId: 'wal-1', providerId: 'prov-1' })
      .error('transaction_failed', {
        correlationId: 'corr-1',
        messageId: 'msg-1',
        payload: { secret: 'bank-data' },
        error: new Error('boom')
      });

    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record.level).toBe(LogLevel.Error);
    expect(record.event).toBe('transaction_failed');
    expect(record.correlationId).toBe('corr-1');
    expect(record.messageId).toBe('msg-1');
    expect(record.transactionId).toBe('tx-1');
    expect(record.walletId).toBe('wal-1');
    expect(record.providerId).toBe('prov-1');
    expect(record.payload).toBe('[redacted]');
    expect(typeof record.timestamp).toBe('string');
  });
});
