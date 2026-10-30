import { describe, expect, test } from 'bun:test';
import { NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import {
  InvalidRequestError,
  ResourceNotFoundError,
  TransientFailureError
} from '../../../application/errors/application.errors';
import {
  PersistenceConflict,
  UniqueConstraintConflictError
} from '../../../application/errors/persistence.errors';
import type { LoggerPort, MetricsPort } from '../../../application/ports/observability.port';
import type { PersistenceErrorTranslatorPort } from '../../../application/ports/persistence-error-translator.port';
import { FailureCode } from '../../../shared/errors/failure-code';
import { AllExceptionsFilter } from './all-exceptions.filter';

interface MockResponse {
  statusCode?: number;
  body?: unknown;
  headers: Record<string, string>;
  status(code: number): MockResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

const logger: LoggerPort = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

const metrics: MetricsPort = {
  transactionPersisted: () => {},
  observeProcessing: () => {},
  idempotencyHit: () => {},
  reconciliationDivergence: () => {},
  uncorrelatedWin: () => {},
  preLineFailure: () => {}
};

const translator: PersistenceErrorTranslatorPort = {
  translate: (error: unknown) => error
};

function filter(): AllExceptionsFilter {
  return new AllExceptionsFilter(logger, metrics, translator);
}

function hostFor(correlationId = 'corr-filter'): {
  host: ArgumentsHost;
  response: MockResponse;
} {
  const response: MockResponse = {
    headers: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    }
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ correlationId }),
      getResponse: () => response
    })
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('AllExceptionsFilter', () => {
  test('mapeia falha transitória para 503 com Retry-After e envelope único', () => {
    const { host, response } = hostFor();
    filter().catch(new TransientFailureError(), host);

    expect(response.statusCode).toBe(503);
    expect(response.headers['Retry-After']).toBe('1');
    expect(response.body).toMatchObject({
      failureCode: FailureCode.TransientInfraFailure,
      correlationId: 'corr-filter'
    });
    expect(response.body).not.toHaveProperty('transactionId');
  });

  test('mapeia conflito de unicidade traduzido para o failureCode de negócio', () => {
    const wallet = hostFor('corr-wallet');
    filter().catch(
      new UniqueConstraintConflictError(PersistenceConflict.WalletPlayerCurrency),
      wallet.host
    );
    expect(wallet.response.statusCode).toBe(409);
    expect(wallet.response.body).toMatchObject({
      failureCode: FailureCode.WalletAlreadyExists,
      correlationId: 'corr-wallet'
    });

    const settlement = hostFor('corr-settlement');
    filter().catch(
      new UniqueConstraintConflictError(PersistenceConflict.Settlement),
      settlement.host
    );
    expect(settlement.response.statusCode).toBe(422);
    expect(settlement.response.body).toMatchObject({
      failureCode: FailureCode.ReferenceAlreadySettled,
      correlationId: 'corr-settlement'
    });
  });

  test('não expõe a mensagem interna de erros desconhecidos', () => {
    const { host, response } = hostFor('corr-unknown');
    filter().catch(new Error('password=super-secret'), host);

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({
      failureCode: FailureCode.PermanentInfraFailure,
      message: 'Internal server error',
      correlationId: 'corr-unknown'
    });
    expect(JSON.stringify(response.body)).not.toContain('super-secret');
  });

  test('mapeia 404 de rota desconhecida sem contar como falha pré-linha', () => {
    let preLineFailures = 0;
    const countingMetrics: MetricsPort = {
      ...metrics,
      preLineFailure: () => {
        preLineFailures += 1;
      }
    };
    const { host, response } = hostFor('corr-route');
    new AllExceptionsFilter(logger, countingMetrics, translator).catch(
      new NotFoundException('Cannot GET /missing'),
      host
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toMatchObject({
      failureCode: 'ROUTE_NOT_FOUND',
      correlationId: 'corr-route'
    });
    expect(preLineFailures).toBe(0);
  });

  test('mapeia 400 e 404 para o mesmo envelope', () => {
    const invalid = hostFor('corr-400');
    filter().catch(new InvalidRequestError('bad payload'), invalid.host);
    expect(invalid.response.statusCode).toBe(400);
    expect(invalid.response.body).toMatchObject({
      failureCode: FailureCode.InvalidPayload,
      message: 'bad payload',
      correlationId: 'corr-400'
    });

    const missing = hostFor('corr-404');
    filter().catch(
      new ResourceNotFoundError('Wallet not found', FailureCode.WalletNotFound),
      missing.host
    );
    expect(missing.response.statusCode).toBe(404);
    expect(missing.response.body).toMatchObject({
      failureCode: FailureCode.WalletNotFound,
      correlationId: 'corr-404'
    });
  });
});
