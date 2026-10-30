import { describe, expect, test } from 'bun:test';
import { BadRequestException, CallHandler, ExecutionContext } from '@nestjs/common';
import { catchError, lastValueFrom, of, throwError } from 'rxjs';
import type { LoggerPort } from '../../../application/ports/observability.port';
import { StructuredLoggingInterceptor } from './structured-logging.interceptor';

interface CapturedLog {
  event: string;
  fields: Record<string, unknown>;
}

function capturingLogger(): { logger: LoggerPort; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  return {
    logs,
    logger: {
      info: (event, fields) => logs.push({ event, fields: fields ?? {} }),
      warn: (event, fields) => logs.push({ event, fields: fields ?? {} }),
      error: (event, fields) => logs.push({ event, fields: fields ?? {} })
    }
  };
}

function context(responseStatusCode = 200): ExecutionContext {
  const request = {
    method: 'POST',
    originalUrl: '/wagering/transactions',
    body: { walletId: 'wallet-1', providerId: 'provider-1' },
    params: {},
    correlationId: 'corr-1'
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ statusCode: responseStatusCode })
    })
  } as unknown as ExecutionContext;
}

describe('StructuredLoggingInterceptor', () => {
  test('registra o status HTTP real de uma exceção, não o status default da resposta', async () => {
    const { logger, logs } = capturingLogger();
    const interceptor = new StructuredLoggingInterceptor(logger);
    const next: CallHandler = {
      handle: () => throwError(() => new BadRequestException('invalid payload'))
    };

    await lastValueFrom(
      interceptor.intercept(context(200), next).pipe(catchError(() => of(undefined)))
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]?.event).toBe('http_request_completed');
    expect(logs[0]?.fields.httpStatus).toBe(400);
    expect(logs[0]?.fields.outcome).toBe('ERROR');
  });
});
