import { FailureCode } from '../../shared/errors/failure-code';
import { ApplicationError } from './application.errors';

export enum PersistenceConflict {
  WalletPlayerCurrency = 'WALLET_PLAYER_CURRENCY',
  Idempotency = 'IDEMPOTENCY',
  ProviderExternal = 'PROVIDER_EXTERNAL',
  Reversal = 'REVERSAL',
  Settlement = 'SETTLEMENT'
}

export class UniqueConstraintConflictError extends Error {
  constructor(
    readonly conflict?: PersistenceConflict,
    message = conflict === undefined
      ? 'Unique constraint violation'
      : `Unique constraint conflict: ${conflict}`
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidPersistenceDataError extends ApplicationError {
  constructor(message = 'Invalid request payload') {
    super(message, FailureCode.InvalidPayload, 400);
  }
}

export class PersistenceFailureError extends ApplicationError {
  constructor(message = 'Internal database failure') {
    super(message, FailureCode.PermanentInfraFailure, 500);
  }
}
