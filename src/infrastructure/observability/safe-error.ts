import { ApplicationError } from '../../application/errors/application.errors';
import { DomainError } from '../../shared/errors/domain-error';
import { postgresConstraint, postgresErrorCode } from '../persistence/postgres/postgres-error';

export function safeErrorFields(error: unknown): Record<string, unknown> {
  if (error instanceof ApplicationError) {
    const cause = error.cause;
    return {
      errorName: error.name,
      failureCode: error.failureCode,
      httpStatus: error.httpStatus,
      ...(cause instanceof Error
        ? {
            cause: {
              errorName: cause.name,
              code: postgresErrorCode(cause),
              constraint: postgresConstraint(cause)
            }
          }
        : {})
    };
  }
  if (error instanceof DomainError) {
    return {
      errorName: error.name,
      failureCode: error.failureCode
    };
  }
  if (error instanceof Error) {
    return {
      errorName: error.name,
      code: postgresErrorCode(error),
      constraint: postgresConstraint(error)
    };
  }
  return { errorName: typeof error };
}
