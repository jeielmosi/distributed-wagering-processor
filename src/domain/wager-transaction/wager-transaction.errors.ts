import { DomainError } from '../../shared/errors/domain-error';
import { FailureCode } from '../../shared/errors/failure-code';

export class InvalidWagerTransactionError extends DomainError {
  constructor(message: string, failureCode: FailureCode = FailureCode.InvalidPayload) {
    super(message, failureCode);
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super(message, FailureCode.InvalidPayload);
  }
}
