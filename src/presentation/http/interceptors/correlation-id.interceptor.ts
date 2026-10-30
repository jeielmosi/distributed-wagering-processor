import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { InvalidRequestError } from '../../../application/errors/application.errors';
import { newUuidV7 } from '../../../shared/id/uuid';

interface CorrelationHttpRequest {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
}

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<CorrelationHttpRequest>();
    const response = http.getResponse<HeaderResponse>();
    const header = request.headers['x-correlation-id'];

    let correlationId: string;
    if (header === undefined) {
      correlationId = newUuidV7();
    } else if (typeof header !== 'string' || header.trim().length === 0 || header.length > 255) {
      throw new InvalidRequestError('X-Correlation-Id must contain between 1 and 255 characters');
    } else {
      correlationId = header.trim();
    }

    request.correlationId = correlationId;
    response.setHeader('X-Correlation-Id', correlationId);
    return next.handle();
  }
}
