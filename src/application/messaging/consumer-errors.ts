import { DomainError } from '../../shared/errors/domain-error';
import { FailureCode } from '../../shared/errors/failure-code';
import { ApplicationError } from '../errors/application.errors';
import { UniqueConstraintConflictError } from '../errors/persistence.errors';
import { InvalidQueueMessageError } from './wager-transaction-message';

export class InboxPayloadMismatchError extends InvalidQueueMessageError {
  constructor(messageId: string) {
    super(`Inbox message ${messageId} already exists with a different payload hash`);
    this.name = new.target.name;
  }
}

export enum MessageFailureKind {
  Transient = 'TRANSIENT',
  Conflict = 'CONFLICT',
  Permanent = 'PERMANENT',
  Unknown = 'UNKNOWN'
}

const PERMANENT_CODES = new Set<FailureCode>([
  FailureCode.InvalidPayload,
  FailureCode.OpeningNotAllowed,
  FailureCode.WalletNotFound,
  FailureCode.WalletPlayerMismatch,
  FailureCode.CurrencyMismatch,
  FailureCode.ReferenceRequired,
  FailureCode.IdempotencyPayloadMismatch,
  FailureCode.DuplicateExternalTransaction,
  FailureCode.WalletAlreadyExists
]);

export function classifyMessageError(error: unknown): MessageFailureKind {
  if (
    error instanceof ApplicationError &&
    error.failureCode === FailureCode.TransientInfraFailure
  ) {
    return MessageFailureKind.Transient;
  }
  if (error instanceof UniqueConstraintConflictError) {
    return MessageFailureKind.Conflict;
  }
  if (error instanceof InvalidQueueMessageError) {
    return MessageFailureKind.Permanent;
  }
  if (error instanceof ApplicationError) {
    return PERMANENT_CODES.has(error.failureCode)
      ? MessageFailureKind.Permanent
      : MessageFailureKind.Unknown;
  }
  if (error instanceof DomainError) {
    return MessageFailureKind.Permanent;
  }
  return MessageFailureKind.Unknown;
}

export function visibilityBackoffSeconds(receiveCount: number): number {
  const normalized = Number.isInteger(receiveCount) && receiveCount >= 1 ? receiveCount : 1;
  return Math.min(2 ** (normalized - 1) * 5, 60);
}
