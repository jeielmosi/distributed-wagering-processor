import { TransactionContext } from './transaction-context';

export interface Clock {
  now(ctx?: TransactionContext): Promise<Date>;
}
