import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { WagerTransactionKind } from '../../../domain/wager-transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../../../domain/wager-transaction/wager-transaction-status';
import { FailureCode } from '../../../shared/errors/failure-code';
import { MoneyAmountType } from '../types/money-amount.type';

@Entity({ tableName: 'wager_transactions' })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid', columnType: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 255, columnType: 'varchar(255)', nullable: true })
  providerId?: string | null;

  @Property({ type: 'string', length: 255, columnType: 'varchar(255)', nullable: true })
  externalTransactionId?: string | null;

  @Property({ type: 'string', length: 255, columnType: 'varchar(255)' })
  idempotencyKey!: string;

  @Property({ type: 'string', length: 64, columnType: 'char(64)' })
  payloadHash!: string;

  @Property({ type: 'uuid', columnType: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid', columnType: 'uuid' })
  playerId!: string;

  @Property({ type: 'string', length: 255, columnType: 'varchar(255)', nullable: true })
  roundId?: string | null;

  @Property({ type: 'string', length: 255, columnType: 'varchar(255)', nullable: true })
  gameId?: string | null;

  @Property({ type: 'string', length: 16, columnType: 'varchar(16)' })
  kind!: WagerTransactionKind;

  @Property({ type: MoneyAmountType })
  amount!: string;

  @Property({ type: 'string', length: 3, columnType: 'varchar(3)' })
  currency!: string;

  @Property({ type: MoneyAmountType, nullable: true })
  balanceAfterAmount?: string | null;

  @Property({ type: 'string', length: 3, columnType: 'varchar(3)', nullable: true })
  balanceAfterCurrency?: string | null;

  @Property({ type: 'string', length: 255, columnType: 'varchar(255)', nullable: true })
  referenceExternalTransactionId?: string | null;

  @Property({ type: 'uuid', columnType: 'uuid', nullable: true })
  referenceTransactionId?: string | null;

  @Property({ type: 'string', length: 32, columnType: 'varchar(32)' })
  status!: WagerTransactionStatus;

  @Property({ type: 'string', length: 64, columnType: 'varchar(64)', nullable: true })
  failureCode?: FailureCode | null;

  @Property({ type: 'string', length: 255, columnType: 'varchar(255)', nullable: true })
  correlationId?: string | null;

  @Property({ type: 'string', length: 255, columnType: 'varchar(255)', nullable: true })
  causationId?: string | null;

  @Property({ type: 'datetime', columnType: 'timestamptz', defaultRaw: 'now()' })
  createdAt!: Date;

  @Property({ type: 'datetime', columnType: 'timestamptz', defaultRaw: 'now()' })
  updatedAt!: Date;

  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true })
  processedAt?: Date | null;

  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true })
  resolvedAt?: Date | null;

  @Property({ type: 'integer', default: 0 })
  referenceAttempts!: number;

  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true })
  nextReferenceAttemptAt?: Date | null;

  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true })
  referenceExpiresAt?: Date | null;

  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true })
  referenceLastAttemptAt?: Date | null;
}
