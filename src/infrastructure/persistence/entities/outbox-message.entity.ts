import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid', columnType: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', columnType: 'uuid' })
  aggregateId!: string;

  @Property({ type: 'string', length: 255, columnType: 'varchar(255)' })
  eventType!: string;

  @Property({ type: 'json', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ type: 'string', length: 255, columnType: 'varchar(255)', nullable: true })
  correlationId?: string | null;

  @Property({ type: 'datetime', columnType: 'timestamptz' })
  occurredAt!: Date;

  @Property({ type: 'integer', default: 0 })
  attempts!: number;

  @Property({ type: 'integer', default: 0 })
  claimCount!: number;

  @Property({ type: 'datetime', columnType: 'timestamptz' })
  nextAttemptAt!: Date;

  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true })
  publishedAt?: Date | null;

  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true })
  deadLetteredAt?: Date | null;

  @Property({ type: 'text', nullable: true })
  lastError?: string | null;
}
