import { DomainError } from '../errors/domain-error';
import { FailureCode } from '../errors/failure-code';

export class ZeroMovementError extends DomainError {
  constructor() {
    super('Financial movements must be greater than zero', FailureCode.InvalidPayload);
  }
}
