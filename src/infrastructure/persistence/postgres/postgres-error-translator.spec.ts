import { describe, expect, test } from 'bun:test';
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
import { DomainError } from '../../../shared/errors/domain-error';
import { FailureCode } from '../../../shared/errors/failure-code';
import { DatabaseConstraint } from './database-constraint';
import { PostgresErrorTranslator } from './postgres-error-translator';

function postgresError(code: string, constraint?: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code, constraint });
}

const translator = new PostgresErrorTranslator();

describe('PostgresErrorTranslator', () => {
  test('traduz SQLSTATEs transitórios para TransientFailureError', () => {
    for (const code of ['55P03', '40P01', '40001', '57014', 'ECONNREFUSED', 'ETIMEDOUT']) {
      expect(translator.translate(postgresError(code))).toBeInstanceOf(TransientFailureError);
    }
  });

  test('traduz violações de unicidade para o conflito semântico correspondente', () => {
    const cases: Array<[string, PersistenceConflict]> = [
      [DatabaseConstraint.WALLETS_PLAYER_CURRENCY, PersistenceConflict.WalletPlayerCurrency],
      [DatabaseConstraint.WAGER_TRANSACTION_IDEMPOTENCY_PROVIDER, PersistenceConflict.Idempotency],
      [DatabaseConstraint.WAGER_TRANSACTION_IDEMPOTENCY_OPENING, PersistenceConflict.Idempotency],
      [
        DatabaseConstraint.WAGER_TRANSACTION_PROVIDER_EXTERNAL,
        PersistenceConflict.ProviderExternal
      ],
      [DatabaseConstraint.WAGER_TRANSACTION_REVERSAL, PersistenceConflict.Reversal],
      [DatabaseConstraint.WAGER_TRANSACTION_SETTLEMENT, PersistenceConflict.Settlement]
    ];

    for (const [constraint, conflict] of cases) {
      const translated = translator.translate(postgresError('23505', constraint.toLowerCase()));
      expect(translated).toBeInstanceOf(UniqueConstraintConflictError);
      expect((translated as UniqueConstraintConflictError).conflict).toBe(conflict);
    }
  });

  test('mantém conflito sem alvo quando a constraint é desconhecida', () => {
    const translated = translator.translate(postgresError('23505', 'uq_unknown'));
    expect(translated).toBeInstanceOf(UniqueConstraintConflictError);
    expect((translated as UniqueConstraintConflictError).conflict).toBeUndefined();
  });

  test('traduz dados inválidos para InvalidPersistenceDataError', () => {
    for (const code of ['23514', '22P02', '22001']) {
      expect(translator.translate(postgresError(code))).toBeInstanceOf(InvalidPersistenceDataError);
    }
  });

  test('traduz demais erros do PostgreSQL para PersistenceFailureError', () => {
    expect(translator.translate(postgresError('XX000'))).toBeInstanceOf(PersistenceFailureError);
  });

  test('preserva erros que não vieram do PostgreSQL', () => {
    const error = new Error('unexpected');
    expect(translator.translate(error)).toBe(error);
    expect(translator.translate(undefined)).toBeUndefined();
  });

  test('não retraduz erros de aplicação, domínio ou conflito já traduzidos', () => {
    const application = new ApplicationError('x', FailureCode.InvalidPayload, 400);
    const domain = new DomainError('x');
    const conflict = new UniqueConstraintConflictError(PersistenceConflict.Reversal);

    expect(translator.translate(application)).toBe(application);
    expect(translator.translate(domain)).toBe(domain);
    expect(translator.translate(conflict)).toBe(conflict);
  });
});
