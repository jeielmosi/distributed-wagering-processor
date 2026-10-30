import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface CorrelationRequest {
  correlationId: string;
}

export const CorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<CorrelationRequest>();
    return request.correlationId;
  }
);
