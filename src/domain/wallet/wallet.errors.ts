import { DomainError } from '../../shared/errors/domain-error';
import { FailureCode } from '../../shared/errors/failure-code';

export class InsufficientBalanceError extends DomainError {
  constructor() {
    super('Insufficient wallet balance', FailureCode.InsufficientFunds);
  }
}

export class InvalidWalletError extends DomainError {
  constructor(message: string) {
    super(message, FailureCode.InvalidPayload);
  }
}
