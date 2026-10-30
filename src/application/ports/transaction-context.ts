export interface TransactionContext {
  readonly id: string;
}

export enum TransactionIsolation {
  ReadCommitted = 'READ COMMITTED',
  RepeatableRead = 'REPEATABLE READ',
  Serializable = 'SERIALIZABLE'
}

export interface TransactionOptions {
  isolation?: TransactionIsolation;
  readOnly?: boolean;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

export interface UnitOfWork {
  run<T>(work: (ctx: TransactionContext) => Promise<T>, options?: TransactionOptions): Promise<T>;
  current(): TransactionContext | undefined;
}
