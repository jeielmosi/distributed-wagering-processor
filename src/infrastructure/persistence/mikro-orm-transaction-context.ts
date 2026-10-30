import { EntityManager } from '@mikro-orm/postgresql';
import { TransactionContext } from '../../application/ports/transaction-context';

export class MikroOrmTransactionContext implements TransactionContext {
  constructor(
    public readonly id: string,
    public readonly em: EntityManager
  ) {}
}
