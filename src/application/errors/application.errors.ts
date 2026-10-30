import { FailureCode } from '../../shared/errors/failure-code';

export interface ApplicationErrorDetails {
  transactionId?: string;
  status?: string;
  idempotentReplay?: boolean;
}

export class ApplicationError extends Error {
  constructor(
    message: string,
    readonly failureCode: FailureCode,
    readonly httpStatus: number,
    readonly details: ApplicationErrorDetails = {}
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidRequestError extends ApplicationError {
  constructor(message: string) {
    super(message, FailureCode.InvalidPayload, 400);
  }
}

export class OpeningNotAllowedError extends ApplicationError {
  constructor(message = 'OPENING cannot be submitted by API or queue') {
    super(message, FailureCode.OpeningNotAllowed, 400);
  }
}

export class ResourceNotFoundError extends ApplicationError {
  constructor(message: string, failureCode: FailureCode = FailureCode.InvalidPayload) {
    super(message, failureCode, 404);
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor(message = 'Wallet not found') {
    super(message, FailureCode.WalletNotFound, 422);
  }
}

export class WalletPlayerMismatchError extends ApplicationError {
  constructor(message = 'Wallet does not belong to the provided player') {
    super(message, FailureCode.WalletPlayerMismatch, 422);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  constructor(message = 'Wallet already exists for this player and currency') {
    super(message, FailureCode.WalletAlreadyExists, 409);
  }
}

export class DuplicateExternalTransactionError extends ApplicationError {
  constructor(message = 'External transaction is already registered') {
    super(message, FailureCode.DuplicateExternalTransaction, 409);
  }
}

export class IdempotencyPayloadMismatchError extends ApplicationError {
  constructor(message = 'Idempotency key was reused with a different payload') {
    super(message, FailureCode.IdempotencyPayloadMismatch, 409);
  }
}

export class TransientFailureError extends ApplicationError {
  constructor(message = 'Service is temporarily unavailable, retry with the same idempotency key') {
    super(message, FailureCode.TransientInfraFailure, 503);
  }
}
