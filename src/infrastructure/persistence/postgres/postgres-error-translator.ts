import { Injectable } from '@nestjs/common';
import {
  ApplicationError,
  TransientFailureError
} from '../../../application/errors/application.errors';
import {
  InvalidPersistenceDataError,
  PersistenceConflict,
  PersistenceFailureError,
  UniqueConstraintConflictError
} from '../../../application/errors/persistence.errors';
import type { PersistenceErrorTranslatorPort } from '../../../application/ports/persistence-error-translator.port';
import { DomainError } from '../../../shared/errors/domain-error';
import { DatabaseConstraint } from './database-constraint';
import {
  isCheckViolation,
  isInvalidTextRepresentation,
  isStringDataRightTruncation,
  isTransientDatabaseError,
  isUniqueViolation,
  postgresConstraint,
  postgresErrorCode
} from './postgres-error';

const CONFLICT_BY_CONSTRAINT: Record<string, PersistenceConflict> = {
  [DatabaseConstraint.WALLETS_PLAYER_CURRENCY]: PersistenceConflict.WalletPlayerCurrency,
  [DatabaseConstraint.WAGER_TRANSACTION_IDEMPOTENCY_PROVIDER]: PersistenceConflict.Idempotency,
  [DatabaseConstraint.WAGER_TRANSACTION_IDEMPOTENCY_OPENING]: PersistenceConflict.Idempotency,
  [DatabaseConstraint.WAGER_TRANSACTION_PROVIDER_EXTERNAL]: PersistenceConflict.ProviderExternal,
  [DatabaseConstraint.WAGER_TRANSACTION_REVERSAL]: PersistenceConflict.Reversal,
  [DatabaseConstraint.WAGER_TRANSACTION_SETTLEMENT]: PersistenceConflict.Settlement
};

function withCause<T extends Error>(translated: T, cause: unknown): T {
  (translated as Error & { cause?: unknown }).cause = cause;
  return translated;
}

@Injectable()
export class PostgresErrorTranslator implements PersistenceErrorTranslatorPort {
  translate(error: unknown): unknown {
    if (
      error instanceof ApplicationError ||
      error instanceof DomainError ||
      error instanceof UniqueConstraintConflictError
    ) {
      return error;
    }
    if (isTransientDatabaseError(error)) {
      return withCause(new TransientFailureError(), error);
    }
    if (isUniqueViolation(error)) {
      const constraint = postgresConstraint(error)?.toUpperCase();
      return withCause(
        new UniqueConstraintConflictError(
          constraint === undefined ? undefined : CONFLICT_BY_CONSTRAINT[constraint]
        ),
        error
      );
    }
    if (
      isCheckViolation(error) ||
      isInvalidTextRepresentation(error) ||
      isStringDataRightTruncation(error)
    ) {
      return withCause(new InvalidPersistenceDataError(), error);
    }
    if (postgresErrorCode(error) !== undefined) {
      return withCause(new PersistenceFailureError(), error);
    }
    return error;
  }
}
