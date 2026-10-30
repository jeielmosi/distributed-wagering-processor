import { Inject, Injectable } from '@nestjs/common';
import { IsolationLevel, MikroORM } from '@mikro-orm/postgresql';
import { newUuidV7 } from '../../shared/id/uuid';
import {
  TransactionContext,
  TransactionIsolation,
  TransactionOptions,
  UnitOfWork
} from '../../application/ports/transaction-context';
import { PERSISTENCE_ERROR_TRANSLATOR } from '../../application/ports/tokens';
import type { PersistenceErrorTranslatorPort } from '../../application/ports/persistence-error-translator.port';
import { MikroOrmEntityManagerResolver } from './mikro-orm-entity-manager-resolver';
import { MikroOrmTransactionContext } from './mikro-orm-transaction-context';
import { MIKRO_ORM } from './mikro-orm.module';
import { PostgresErrorTranslator } from './postgres/postgres-error-translator';

const DEFAULT_STATEMENT_TIMEOUT_MS = 30000;
const DEFAULT_LOCK_TIMEOUT_MS = 10000;

function isolationLevel(value: TransactionOptions['isolation']): IsolationLevel | undefined {
  switch (value) {
    case TransactionIsolation.ReadCommitted:
      return IsolationLevel.READ_COMMITTED;
    case TransactionIsolation.RepeatableRead:
      return IsolationLevel.REPEATABLE_READ;
    case TransactionIsolation.Serializable:
      return IsolationLevel.SERIALIZABLE;
    default:
      return undefined;
  }
}

@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    @Inject(MIKRO_ORM) private readonly orm: MikroORM,
    private readonly resolver: MikroOrmEntityManagerResolver,
    @Inject(PERSISTENCE_ERROR_TRANSLATOR)
    private readonly translator: PersistenceErrorTranslatorPort = new PostgresErrorTranslator()
  ) {}

  async run<T>(
    work: (ctx: TransactionContext) => Promise<T>,
    options: TransactionOptions = {}
  ): Promise<T> {
    const current = this.resolver.current();
    if (current !== undefined) {
      return this.withTranslatedErrors(() => work(current));
    }

    const em = this.orm.em.fork();
    const statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

    return this.withTranslatedErrors(() =>
      em.transactional(
        async (txEm) => {
          await txEm.execute(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
          await txEm.execute(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
          const ctx = new MikroOrmTransactionContext(newUuidV7(), txEm);
          return this.resolver.run(ctx, () => work(ctx));
        },
        {
          isolationLevel: isolationLevel(options.isolation),
          readOnly: options.readOnly
        }
      )
    );
  }

  current(): TransactionContext | undefined {
    return this.resolver.current();
  }

  private async withTranslatedErrors<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw this.translator.translate(error);
    }
  }
}
