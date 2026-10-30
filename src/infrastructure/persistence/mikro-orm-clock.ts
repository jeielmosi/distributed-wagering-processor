import { Injectable } from '@nestjs/common';
import { Clock } from '../../application/ports/clock.port';
import { TransactionContext } from '../../application/ports/transaction-context';
import { MikroOrmEntityManagerResolver } from './mikro-orm-entity-manager-resolver';

@Injectable()
export class MikroOrmClock implements Clock {
  constructor(private readonly resolver: MikroOrmEntityManagerResolver) {}

  async now(ctx?: TransactionContext): Promise<Date> {
    const em = this.resolver.resolve(ctx);
    const rows = await em.execute<{ now: Date }[]>('select now() as now');
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (row === undefined) {
      throw new Error('PostgreSQL did not return the current timestamp');
    }
    return row.now instanceof Date ? row.now : new Date(String(row.now));
  }
}
