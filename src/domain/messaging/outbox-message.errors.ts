import { DomainError } from '../../shared/errors/domain-error';
import { FailureCode } from '../../shared/errors/failure-code';

export class InvalidOutboxMessageError extends DomainError {
  constructor(message: string) {
    super(message, FailureCode.InvalidPayload);
  }
}
