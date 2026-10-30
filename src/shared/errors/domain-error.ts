import { FailureCode } from './failure-code';

export class DomainError extends Error {
  readonly failureCode?: FailureCode;

  constructor(message: string, failureCode?: FailureCode) {
    super(message);
    this.name = new.target.name;
    this.failureCode = failureCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
