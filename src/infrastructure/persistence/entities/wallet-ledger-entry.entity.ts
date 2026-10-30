import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { LedgerDirection } from '../../../domain/ledger/ledger-direction';
import { MoneyAmountType } from '../types/money-amount.type';

@Entity({ tableName: 'wallet_ledger_entries' })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid', columnType: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', columnType: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid', columnType: 'uuid' })
  transactionId!: string;

  @Property({ type: 'integer' })
  walletVersion!: number;

  @Property({ type: 'string', length: 8, columnType: 'varchar(8)' })
  direction!: LedgerDirection;

  @Property({ type: MoneyAmountType })
  amount!: string;

  @Property({ type: 'string', length: 3, columnType: 'varchar(3)' })
  currency!: string;

  @Property({ type: MoneyAmountType })
  balanceBeforeAmount!: string;

  @Property({ type: MoneyAmountType })
  balanceAfterAmount!: string;

  @Property({ type: 'datetime', columnType: 'timestamptz', defaultRaw: 'now()' })
  createdAt!: Date;
}
