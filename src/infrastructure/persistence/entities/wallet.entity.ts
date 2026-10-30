import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { MoneyAmountType } from '../types/money-amount.type';

@Entity({ tableName: 'wallets' })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid', columnType: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', columnType: 'uuid' })
  playerId!: string;

  @Property({ type: 'string', length: 3, columnType: 'varchar(3)' })
  currency!: string;

  @Property({ type: MoneyAmountType })
  balanceAmount!: string;

  @Property({ type: 'integer' })
  version!: number;

  @Property({ type: 'datetime', columnType: 'timestamptz', defaultRaw: 'now()' })
  createdAt!: Date;

  @Property({ type: 'datetime', columnType: 'timestamptz', defaultRaw: 'now()' })
  updatedAt!: Date;
}
