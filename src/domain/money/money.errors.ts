import { DomainError } from '../../shared/errors/domain-error';
import { FailureCode } from '../../shared/errors/failure-code';

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(message, FailureCode.InvalidPayload);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super(
      `Currency mismatch: expected ${expected}, received ${actual}`,
      FailureCode.CurrencyMismatch
    );
  }
}
