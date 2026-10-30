import { Inject, Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { TransactionContext } from '../../application/ports/transaction-context';
import { MikroOrmTransactionContext } from './mikro-orm-transaction-context';
import { MIKRO_ORM } from './mikro-orm.module';

@Injectable()
export class MikroOrmEntityManagerResolver {
  private readonly storage = new AsyncLocalStorage<MikroOrmTransactionContext>();

  constructor(@Inject(MIKRO_ORM) private readonly orm: MikroORM) {}

  current(): MikroOrmTransactionContext | undefined {
    return this.storage.getStore();
  }

  resolve(ctx?: TransactionContext): EntityManager {
    if (ctx instanceof MikroOrmTransactionContext) {
      return ctx.em;
    }
    const current = this.storage.getStore();
    if (current !== undefined) {
      return current.em;
    }
    return this.orm.em.fork();
  }

  run<T>(ctx: MikroOrmTransactionContext, work: () => T): T {
    return this.storage.run(ctx, work);
  }
}
