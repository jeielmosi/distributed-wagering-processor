import { describe, expect, test } from 'bun:test';
import { InvalidQueueMessageError } from './wager-transaction-message';
import {
  classifyMessageError,
  MessageFailureKind,
  visibilityBackoffSeconds
} from './consumer-errors';
import {
  ApplicationError,
  DuplicateExternalTransactionError,
  IdempotencyPayloadMismatchError,
  TransientFailureError,
  WalletNotFoundError,
  WalletPlayerMismatchError
} from '../errors/application.errors';
import {
  InvalidPersistenceDataError,
  PersistenceConflict,
  PersistenceFailureError,
  UniqueConstraintConflictError
} from '../errors/persistence.errors';
import { FailureCode } from '../../shared/errors/failure-code';
import { CurrencyMismatchError } from '../../domain/money/money.errors';
import { ZeroMovementError } from '../../shared/errors/zero-movement-error';

describe('classifyMessageError', () => {
  test('classifica negócio persistível como unknown (o use case já respondeu)', () => {
    expect(classifyMessageError(new Error('unexpected'))).toBe(MessageFailureKind.Unknown);
    expect(classifyMessageError(new PersistenceFailureError())).toBe(MessageFailureKind.Unknown);
  });

  test('classifica falhas transitórias traduzidas', () => {
    expect(classifyMessageError(new TransientFailureError())).toBe(MessageFailureKind.Transient);
    expect(
      classifyMessageError(
        new ApplicationError('temporary', FailureCode.TransientInfraFailure, 503)
      )
    ).toBe(MessageFailureKind.Transient);
  });

  test('classifica conflito de unicidade traduzido como recuperável', () => {
    expect(
      classifyMessageError(new UniqueConstraintConflictError(PersistenceConflict.Settlement))
    ).toBe(MessageFailureKind.Conflict);
    expect(classifyMessageError(new UniqueConstraintConflictError())).toBe(
      MessageFailureKind.Conflict
    );
  });

  test('classifica erros permanentes de payload e de vínculo', () => {
    expect(classifyMessageError(new InvalidQueueMessageError('bad'))).toBe(
      MessageFailureKind.Permanent
    );
    expect(classifyMessageError(new WalletNotFoundError())).toBe(MessageFailureKind.Permanent);
    expect(classifyMessageError(new WalletPlayerMismatchError())).toBe(
      MessageFailureKind.Permanent
    );
    expect(classifyMessageError(new CurrencyMismatchError('BRL', 'USD'))).toBe(
      MessageFailureKind.Permanent
    );
    expect(classifyMessageError(new DuplicateExternalTransactionError())).toBe(
      MessageFailureKind.Permanent
    );
    expect(classifyMessageError(new IdempotencyPayloadMismatchError())).toBe(
      MessageFailureKind.Permanent
    );
    expect(classifyMessageError(new ZeroMovementError())).toBe(MessageFailureKind.Permanent);
    expect(classifyMessageError(new InvalidPersistenceDataError())).toBe(
      MessageFailureKind.Permanent
    );
  });
});

describe('visibilityBackoffSeconds', () => {
  test('cresce exponencialmente e satura em 60s', () => {
    expect(visibilityBackoffSeconds(1)).toBe(5);
    expect(visibilityBackoffSeconds(2)).toBe(10);
    expect(visibilityBackoffSeconds(3)).toBe(20);
    expect(visibilityBackoffSeconds(4)).toBe(40);
    expect(visibilityBackoffSeconds(5)).toBe(60);
    expect(visibilityBackoffSeconds(10)).toBe(60);
  });
});
