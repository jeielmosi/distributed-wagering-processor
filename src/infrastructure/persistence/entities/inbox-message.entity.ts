import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'string', length: 255, columnType: 'varchar(255)' })
  consumerName!: string;

  @PrimaryKey({ type: 'string', length: 255, columnType: 'varchar(255)' })
  messageId!: string;

  @Property({ type: 'string', length: 64, columnType: 'char(64)' })
  payloadHash!: string;

  @Property({ type: 'string', length: 255, columnType: 'varchar(255)', nullable: true })
  correlationId?: string | null;

  @Property({ type: 'datetime', columnType: 'timestamptz', defaultRaw: 'now()' })
  receivedAt!: Date;

  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true })
  processedAt?: Date | null;
}
