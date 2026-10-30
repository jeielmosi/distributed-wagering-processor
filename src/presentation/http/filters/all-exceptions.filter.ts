import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { ApplicationError } from '../../../application/errors/application.errors';
import {
  PersistenceConflict,
  UniqueConstraintConflictError
} from '../../../application/errors/persistence.errors';
import type { LoggerPort, MetricsPort } from '../../../application/ports/observability.port';
import type { PersistenceErrorTranslatorPort } from '../../../application/ports/persistence-error-translator.port';
import { DomainError } from '../../../shared/errors/domain-error';
import { FailureCode } from '../../../shared/errors/failure-code';

interface ErrorEnvelope {
  failureCode: FailureCode;
  message: string;
  correlationId?: string;
  transactionId?: string;
  status?: string;
  idempotentReplay?: boolean;
  details?: unknown;
}

interface CorrelatedRequest {
  correlationId?: string;
}

interface FilterResponse {
  status(code: number): FilterResponse;
  json(body: ErrorEnvelope): void;
  setHeader(name: string, value: string): void;
}

interface DescribedError {
  status: number;
  body: ErrorEnvelope;
  retryAfter?: boolean;
}

function statusForFailureCode(failureCode: FailureCode): number {
  switch (failureCode) {
    case FailureCode.InvalidPayload:
    case FailureCode.OpeningNotAllowed:
      return HttpStatus.BAD_REQUEST;
    case FailureCode.WalletNotFound:
      return HttpStatus.NOT_FOUND;
    case FailureCode.WalletAlreadyExists:
    case FailureCode.DuplicateExternalTransaction:
    case FailureCode.IdempotencyPayloadMismatch:
      return HttpStatus.CONFLICT;
    case FailureCode.CurrencyMismatch:
    case FailureCode.WalletPlayerMismatch:
    case FailureCode.ReferenceRequired:
    case FailureCode.InsufficientFunds:
    case FailureCode.InsufficientFundsForReversal:
    case FailureCode.ReferenceNotFound:
    case FailureCode.ReferenceNotProcessed:
    case FailureCode.ReferenceAlreadyReverted:
    case FailureCode.ReferenceAlreadySettled:
    case FailureCode.ReferenceHasProcessedWin:
    case FailureCode.ReferenceAmountMismatch:
    case FailureCode.ReferenceContextMismatch:
    case FailureCode.InvalidReferenceKind:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case FailureCode.TransientInfraFailure:
      return HttpStatus.SERVICE_UNAVAILABLE;
    case FailureCode.TransactionNotFound:
    case FailureCode.RouteNotFound:
      return HttpStatus.NOT_FOUND;
    case FailureCode.PermanentInfraFailure:
      return HttpStatus.INTERNAL_SERVER_ERROR;
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger: LoggerPort,
    private readonly metrics: MetricsPort,
    private readonly translator: PersistenceErrorTranslatorPort
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<CorrelatedRequest>();
    const response = http.getResponse<FilterResponse>();
    const described = this.describe(this.translator.translate(exception), request.correlationId);

    if (described.retryAfter === true) {
      response.setHeader('Retry-After', '1');
    }
    if (
      described.body.transactionId === undefined &&
      described.body.failureCode !== FailureCode.RouteNotFound
    ) {
      this.metrics.preLineFailure(described.body.failureCode, described.status);
    }
    this.logger.warn('http_request_rejected', {
      correlationId: request.correlationId,
      failureCode: described.body.failureCode,
      httpStatus: described.status,
      transactionId: described.body.transactionId
    });
    response.status(described.status).json(described.body);
  }

  private describe(exception: unknown, correlationId?: string): DescribedError {
    if (exception instanceof ApplicationError) {
      return {
        status: exception.httpStatus,
        body: this.envelope(correlationId, exception.failureCode, exception.message, {
          ...exception.details
        }),
        retryAfter: exception.httpStatus === HttpStatus.SERVICE_UNAVAILABLE
      };
    }

    if (exception instanceof DomainError) {
      const failureCode = exception.failureCode ?? FailureCode.InvalidPayload;
      return {
        status: statusForFailureCode(failureCode),
        body: this.envelope(correlationId, failureCode, exception.message),
        retryAfter: failureCode === FailureCode.TransientInfraFailure
      };
    }

    if (exception instanceof HttpException) {
      return this.describeHttpException(exception, correlationId);
    }

    if (exception instanceof UniqueConstraintConflictError) {
      return this.describeConflict(exception, correlationId);
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: this.envelope(correlationId, FailureCode.PermanentInfraFailure, 'Internal server error')
    };
  }

  private describeConflict(
    exception: UniqueConstraintConflictError,
    correlationId?: string
  ): DescribedError {
    switch (exception.conflict) {
      case PersistenceConflict.WalletPlayerCurrency:
        return {
          status: HttpStatus.CONFLICT,
          body: this.envelope(
            correlationId,
            FailureCode.WalletAlreadyExists,
            'Wallet already exists for this player and currency'
          )
        };
      case PersistenceConflict.ProviderExternal:
        return {
          status: HttpStatus.CONFLICT,
          body: this.envelope(
            correlationId,
            FailureCode.DuplicateExternalTransaction,
            'External transaction is already registered'
          )
        };
      case PersistenceConflict.Reversal:
        return {
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          body: this.envelope(
            correlationId,
            FailureCode.ReferenceAlreadyReverted,
            'Reference was already reverted'
          )
        };
      case PersistenceConflict.Settlement:
        return {
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          body: this.envelope(
            correlationId,
            FailureCode.ReferenceAlreadySettled,
            'Reference was already settled'
          )
        };
      case PersistenceConflict.Idempotency:
      default:
        return {
          status: HttpStatus.CONFLICT,
          body: this.envelope(
            correlationId,
            FailureCode.DuplicateExternalTransaction,
            'Unique constraint violation'
          )
        };
    }
  }

  private describeHttpException(exception: HttpException, correlationId?: string): DescribedError {
    const status = exception.getStatus();
    const response = exception.getResponse();
    let failureCode: FailureCode = FailureCode.InvalidPayload;
    let message = exception.message;
    let details: unknown;

    if (typeof response === 'object' && response !== null) {
      const record = response as Record<string, unknown>;
      if (typeof record.failureCode === 'string') {
        failureCode = record.failureCode as FailureCode;
      }
      if (typeof record.message === 'string') {
        message = record.message;
      } else if (Array.isArray(record.message)) {
        details = record.message;
        message = 'Invalid request payload';
      }
    }

    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      failureCode = FailureCode.TransientInfraFailure;
    } else if (status === HttpStatus.NOT_FOUND && failureCode === FailureCode.InvalidPayload) {
      failureCode = FailureCode.RouteNotFound;
    }

    return {
      status,
      body: this.envelope(
        correlationId,
        failureCode,
        message,
        details === undefined ? {} : { details }
      ),
      retryAfter: status === HttpStatus.SERVICE_UNAVAILABLE
    };
  }

  private envelope(
    correlationId: string | undefined,
    failureCode: FailureCode,
    message: string,
    extra: {
      transactionId?: string;
      status?: string;
      idempotentReplay?: boolean;
      details?: unknown;
    } = {}
  ): ErrorEnvelope {
    const envelope: ErrorEnvelope = { failureCode, message };
    if (correlationId !== undefined) {
      envelope.correlationId = correlationId;
    }
    if (extra.transactionId !== undefined) {
      envelope.transactionId = extra.transactionId;
    }
    if (extra.status !== undefined) {
      envelope.status = extra.status;
    }
    if (extra.idempotentReplay !== undefined) {
      envelope.idempotentReplay = extra.idempotentReplay;
    }
    if (extra.details !== undefined) {
      envelope.details = extra.details;
    }
    return envelope;
  }
}
