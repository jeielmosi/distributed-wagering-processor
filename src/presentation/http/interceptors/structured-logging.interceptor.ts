import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor
} from '@nestjs/common';
import { Observable, catchError, tap, throwError } from 'rxjs';
import type { LoggerPort } from '../../../application/ports/observability.port';

interface LoggedRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  route?: { path?: string };
  correlationId?: string;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
}

enum HttpOutcome {
  Success = 'SUCCESS',
  Error = 'ERROR'
}

interface LoggedResponse {
  statusCode?: number;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function statusFromError(error: unknown, fallback: number | undefined): number | undefined {
  if (error instanceof HttpException) {
    return error.getStatus();
  }
  if (typeof error === 'object' && error !== null) {
    const httpStatus = (error as { httpStatus?: unknown }).httpStatus;
    if (typeof httpStatus === 'number') {
      return httpStatus;
    }
  }
  return fallback;
}

@Injectable()
export class StructuredLoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: LoggerPort) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<LoggedRequest>();
    const response = http.getResponse<LoggedResponse>();
    const startedAt = performance.now();
    const startedAtEpoch = Date.now();
    let finished = false;

    const finish = (outcome: HttpOutcome, result?: unknown, status?: number): void => {
      if (finished) {
        return;
      }
      finished = true;
      const path = request.route?.path ?? request.originalUrl?.split('?')[0] ?? request.url ?? '';
      const body = request.body ?? {};
      const resultBody =
        typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
      this.logger.info('http_request_completed', {
        correlationId: request.correlationId,
        transactionId: stringField(resultBody.transactionId),
        walletId: request.params?.walletId ?? stringField(body.walletId),
        providerId: stringField(body.providerId) ?? stringField(resultBody.providerId),
        method: request.method,
        path,
        httpStatus: status ?? response.statusCode,
        outcome,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        startedAt: new Date(startedAtEpoch).toISOString()
      });
    };

    return next.handle().pipe(
      tap((result) => finish(HttpOutcome.Success, result)),
      catchError((error: unknown) => {
        finish(HttpOutcome.Error, undefined, statusFromError(error, response.statusCode));
        return throwError(() => error);
      })
    );
  }
}
